#!/usr/bin/env python3
"""Turn a finished PDF into a Word file that looks like it.

    convert.py <in.pdf> <out.docx> <result.json>

The server compiles the report to PDF with typst and then runs this script on
the result, so the Word file can never disagree with the PDF: redactions are
already baked in, figure numbering is whatever typst evaluated, and the page
breaks are the ones the reader saw.

pdf2docx does the page-to-paragraph work. Two things it gets wrong on a real
report are repaired here, and both repairs are written against page geometry
rather than against any one template:

1. A running header or footer is ordinary page content to pdf2docx, so it
   becomes a paragraph in the body. Word then re-flows it, every page grows by
   the height of its footer, and a 23-page report comes out at 44. So the
   repeating bands are found, removed from the PDF before the conversion, and
   put back afterwards as real Word headers and footers.
2. A table of contents whose entries end in dot leaders confuses the line
   grouping: entries merge, and page numbers land next to the wrong title.
   The entries are read out of the PDF instead and written back as one clean
   paragraph each, with a dot-leader tab stop.

Nothing here knows what a report is. A PDF with no running band and no table
of contents goes through both steps untouched.
"""

import contextlib
import copy
import json
import logging
import os
import re
import sys
from statistics import median

import pymupdf
from docx import Document
from docx.enum.text import WD_LINE_SPACING, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor
from docx.text.paragraph import Paragraph

# ── thresholds ────────────────────────────────────────────────────────────
# A band has to live near a page edge. 12% of US Letter is 95 pt, which is
# more than any running header sensibly occupies and still clear of the first
# body line even on a page that opens with a large heading.
BAND_ZONE_FRACTION = 0.12
# Two rows are the same row when their normalized text matches and their top
# edges are within this many points. Typst puts a running header on the same
# baseline every time; the tolerance is for generators that round per page.
BAND_Y_TOLERANCE_PT = 2.0
# Share of the pages that have anything at all in that zone. Below this it is
# body content that happens to repeat, not a band. A cover page with nothing
# up there is not counted either way.
BAND_REPEAT_FRACTION = 0.60
# A rule under a header or a filled strip behind a footer joins the band when
# it repeats and sits within this distance of the repeating text.
BAND_GLUE_PT = 30.0
# Lines of one band sit next to each other, so a repeating row this many row
# heights clear of the band is body content that happens to repeat, such as a
# page-opening heading whose only change is its number. Without this the
# heading would be stripped out of the document.
BAND_LINE_GLUE = 1.6
# Room left around a band rectangle when it is removed, so a glyph that
# overhangs its reported box does not survive as a sliver.
BAND_PAD_PT = 1.0
# A horizontal gap this wide starts a new column within one row: it is what
# separates a left header piece from a right one, and a section number from
# the title beside it. Narrower than this is ordinary inter-word space.
COLUMN_GAP_PT = 4.0
# How far a column's edge may sit from the text area's edge and still count
# as flush with it.
ALIGN_TOLERANCE_PT = 6.0

# A dot leader is this many dots or more, optionally spaced. Four would match
# an ellipsis followed by a full stop; six is past anything punctuation does.
LEADER_MIN_DOTS = 6
# Dot-leader paragraphs this far apart in the converted document still belong
# to the same table of contents: pdf2docx sometimes leaves a stray fragment
# between two entries.
TOC_RUN_GAP = 2
# Fewer than this in one stretch is a coincidence, not a table of contents.
TOC_RUN_MIN = 3
# Ceiling on the blank space carried over before an entry, so one bad reading
# cannot push the list onto another page.
TOC_MAX_SPACE_BEFORE_PT = 24.0

# Invisible characters a typesetter puts around a page number.
INVISIBLE = "⁠​‌‍﻿"
DIGITS = re.compile(r"\d+")
LEADER = re.compile(r"(?:\.[ \t ]*){%d,}" % LEADER_MIN_DOTS)
TOC_LINE = re.compile(
    r"^(?P<title>.*?\S)[ \t ]*(?:\.[ \t ]*){%d,}[%s ]*(?P<page>\d{1,4})$"
    % (LEADER_MIN_DOTS, INVISIBLE)
)
BOLD_FLAG = 1 << 4
SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")
FONT_STYLE_SUFFIX = re.compile(
    r"[-,_]?(?:bold|italic|oblique|regular|book|light|medium|semibold|demibold"
    r"|black|heavy|thin|roman|mt|ps)$",
    re.IGNORECASE,
)


class ConvertError(Exception):
    """A failure with a message short enough to show an operator."""


# ── reading the page ──────────────────────────────────────────────────────


def normalize(text):
    """Collapse whitespace and blank out digit runs.

    Two pages of a running header differ only in the page number, so the page
    number has to stop being part of the identity before the two compare
    equal.
    """
    return DIGITS.sub("#", " ".join(text.split()))


def font_family(pdf_font_name):
    """`ABCDEF+Poppins-Bold` to `Poppins`, so Word is asked for a family."""
    name = SUBSET_PREFIX.sub("", str(pdf_font_name or "")).split(",")[0]
    while True:
        shorter = FONT_STYLE_SUFFIX.sub("", name)
        if shorter == name or not shorter:
            break
        name = shorter
    return name.strip(" -_") or None


def rgb_of(color_int):
    value = int(color_int or 0)
    return RGBColor((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)


def page_rows(page):
    """One entry per visual row, each split into columns.

    PyMuPDF reports the left and right halves of a running header as two lines
    of one block, and a table-of-contents number as a line of its own beside
    its title. Both are one row to a reader, so rows on the same baseline of
    the same block are joined, and then split again wherever a gap wider than
    ordinary word spacing appears. That split is the column structure both
    repairs below are built on.
    """
    raw = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = [s for s in line.get("spans", []) if s.get("text", "").strip()]
            if spans:
                raw.append({"y0": line["bbox"][1], "y1": line["bbox"][3], "block": id(block), "spans": spans})
    raw.sort(key=lambda r: (round(r["y0"], 1), r["spans"][0]["bbox"][0]))

    joined = []
    for row in raw:
        previous = joined[-1] if joined else None
        if (
            previous is not None
            and previous["block"] == row["block"]
            and abs(previous["y0"] - row["y0"]) <= BAND_Y_TOLERANCE_PT
        ):
            previous["spans"].extend(row["spans"])
            previous["y1"] = max(previous["y1"], row["y1"])
            continue
        joined.append(dict(row))

    out = []
    for row in joined:
        spans = sorted(row["spans"], key=lambda s: s["bbox"][0])
        columns = []
        for span in spans:
            x0, x1 = span["bbox"][0], span["bbox"][2]
            if columns and x0 - columns[-1]["x1"] <= COLUMN_GAP_PT:
                column = columns[-1]
                joiner = " " if x0 - column["x1"] > 0.8 and not column["text"].endswith(" ") else ""
                column["text"] += joiner + span["text"]
                column["x1"] = max(column["x1"], x1)
                continue
            columns.append(
                {
                    "x0": x0,
                    "x1": x1,
                    "text": span["text"],
                    "font": font_family(span["font"]),
                    "size": span["size"],
                    "bold": bool(span["flags"] & BOLD_FLAG),
                    "color": span["color"],
                }
            )
        for column in columns:
            column["text"] = column["text"].strip()
        columns = [c for c in columns if c["text"]]
        if not columns:
            continue
        out.append(
            {
                "y0": row["y0"],
                "y1": row["y1"],
                "x0": columns[0]["x0"],
                "x1": columns[-1]["x1"],
                "columns": columns,
                "text": " ".join(c["text"] for c in columns),
            }
        )
    return out


# ── step 1: find the repeating bands ──────────────────────────────────────


def in_zone(page, edge, y0, y1):
    height = page.rect.height
    if edge == "top":
        return y1 <= height * BAND_ZONE_FRACTION
    return y0 >= height * (1.0 - BAND_ZONE_FRACTION)


def detect_band(doc, edge):
    """The repeating header or footer of this document, or None.

    Rows in the edge zone are grouped by their normalized text and their
    rounded top edge. A group is a band when it appears on at least
    BAND_REPEAT_FRACTION of the pages that have anything in that zone.
    """
    per_page = {}
    populated = []
    for index in range(doc.page_count):
        page = doc[index]
        rows = [r for r in page_rows(page) if in_zone(page, edge, r["y0"], r["y1"])]
        per_page[index] = rows
        if rows:
            populated.append(index)
    if len(populated) < 2:
        return None

    groups = {}
    for index in populated:
        seen = set()
        for row in per_page[index]:
            key = (normalize(row["text"]), round(row["y0"] / BAND_Y_TOLERANCE_PT))
            if key in seen:  # one page cannot vote twice for the same row
                continue
            seen.add(key)
            groups.setdefault(key, []).append((index, row))

    need = max(2, int(round(len(populated) * BAND_REPEAT_FRACTION)))
    repeating = edge_cluster([rows for rows in groups.values() if len(rows) >= need], edge)
    if not repeating:
        return None

    pages = sorted({index for rows in repeating for index, _ in rows})
    text_top = min(row["y0"] for rows in repeating for _, row in rows)
    text_bottom = max(row["y1"] for rows in repeating for _, row in rows)
    top, bottom = text_top, text_bottom

    rule_under = False
    strip_behind = None
    for drawing in repeating_drawings(doc, pages, edge):
        rect = drawing["rect"]
        if rect.y0 > bottom + BAND_GLUE_PT or rect.y1 < top - BAND_GLUE_PT:
            continue
        top = min(top, rect.y0)
        bottom = max(bottom, rect.y1)
        if drawing.get("fill") is not None and rect.height > 1.0:
            strip_behind = tuple(drawing["fill"])
        elif edge == "top" and rect.y0 >= text_bottom - 1.0:
            rule_under = True

    columns = []
    for rows in sorted(repeating, key=lambda rows: rows[0][1]["x0"]):
        columns.extend(describe_columns(rows))
    return {
        "edge": edge,
        "pages": pages,
        "top": top,
        "bottom": bottom,
        "text_top": text_top,
        "text_bottom": text_bottom,
        "columns": columns,
        "rule_under": rule_under,
        "strip_behind": strip_behind,
    }


def edge_cluster(groups, edge):
    """Keep only the repeating rows that sit together at the page edge.

    A running band is the outermost thing on its page. Body content can repeat
    too, and on a report where every page opens with a heading of the same
    shape it repeats inside the edge zone, so proximity to the edge is what
    separates the two.
    """
    if not groups:
        return []
    bounds = {id(rows): (min(r["y0"] for _, r in rows), max(r["y1"] for _, r in rows)) for rows in groups}
    ordered = sorted(groups, key=lambda rows: bounds[id(rows)][0 if edge == "top" else 1], reverse=edge != "top")
    kept = [ordered[0]]
    top, bottom = bounds[id(ordered[0])]
    for rows in ordered[1:]:
        low, high = bounds[id(rows)]
        glue = BAND_LINE_GLUE * max(bottom - top, high - low, 1.0)
        if low <= bottom + glue and high >= top - glue:
            kept.append(rows)
            top, bottom = min(top, low), max(bottom, high)
    return kept


def repeating_drawings(doc, pages, edge):
    """Vector drawings that appear, identically placed, on most band pages."""
    groups = {}
    for index in pages:
        page = doc[index]
        seen = set()
        for drawing in page.get_drawings():
            rect = drawing["rect"]
            if not in_zone(page, edge, rect.y0, rect.y1):
                continue
            key = (drawing.get("type"), round(rect.x0, 1), round(rect.y0, 1), round(rect.x1, 1), round(rect.y1, 1))
            if key in seen:
                continue
            seen.add(key)
            groups.setdefault(key, []).append(drawing)
    need = max(2, int(round(len(pages) * BAND_REPEAT_FRACTION)))
    return [drawings[0] for drawings in groups.values() if len(drawings) >= need]


def describe_columns(rows):
    """Turn one repeating row into columns Word can lay out.

    Every occurrence has the same shape once digits are blanked out, so the
    digit runs line up slot by slot across pages. A slot whose value rises by
    one per page is the page number, and the difference between the printed
    number and the page index is kept so Word can start counting there.
    """
    counts = {len(row["columns"]) for _, row in rows}
    if len(counts) != 1:
        # Shapes disagree; the safe reading is one column spanning the row.
        merged = [
            (
                index,
                {
                    "x0": row["x0"],
                    "x1": row["x1"],
                    "text": row["text"],
                    "font": row["columns"][0]["font"],
                    "size": row["columns"][0]["size"],
                    "bold": row["columns"][0]["bold"],
                    "color": row["columns"][0]["color"],
                },
            )
            for index, row in rows
        ]
        return [describe_one_column(merged)]
    width = counts.pop()
    return [describe_one_column([(index, row["columns"][i]) for index, row in rows]) for i in range(width)]


def describe_one_column(cells):
    """One column of a band: its look, and its page-number slot if it has one."""
    first = cells[0][1]
    numbers = [list(DIGITS.finditer(cell["text"])) for _, cell in cells]
    slots = min((len(n) for n in numbers), default=0)
    page_slot = None
    page_offset = None
    for slot in range(slots):
        offsets = {int(m[slot].group()) - index for (index, _), m in zip(cells, numbers)}
        if len(offsets) == 1 and len(cells) > 1:
            page_slot, page_offset = slot, offsets.pop()
            break

    parts = []
    if page_slot is None:
        parts.append({"kind": "text", "text": first["text"]})
    else:
        match = numbers[0][page_slot]
        parts.append({"kind": "text", "text": first["text"][: match.start()]})
        parts.append({"kind": "page"})
        parts.append({"kind": "text", "text": first["text"][match.end() :]})
    return {
        "x0": min(cell["x0"] for _, cell in cells),
        "x1": max(cell["x1"] for _, cell in cells),
        "parts": [p for p in parts if p["kind"] != "text" or p["text"]],
        "font": first["font"],
        "size": first["size"],
        "bold": first["bold"],
        "color": first["color"],
        "page_offset": page_offset,
    }


def strip_bands(doc, bands):
    """Erase the band rectangles, in place, on the pages that carry them.

    A redaction annotation with no fill removes the text and the line art it
    covers and leaves everything else alone. Images are excluded outright: a
    figure that reaches into the zone is body content, not a band.
    """
    for band in bands:
        for index in band["pages"]:
            page = doc[index]
            page.add_redact_annot(
                pymupdf.Rect(page.rect.x0, band["top"] - BAND_PAD_PT, page.rect.x1, band["bottom"] + BAND_PAD_PT),
                cross_out=False,
            )
    for index in sorted({i for band in bands for i in band["pages"]}):
        doc[index].apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
            text=pymupdf.PDF_REDACT_TEXT_REMOVE,
        )


# ── step 2: read the table of contents out of the PDF ─────────────────────


def content_bounds(doc):
    """The left and right edges of the page's text area, in PDF points.

    The median of each page's own extremes, so one full-bleed cover or one
    figure that runs into the margin does not move the reference the bands and
    the table of contents are positioned against.
    """
    lefts, rights = [], []
    for index in range(doc.page_count):
        rows = page_rows(doc[index])
        if not rows:
            continue
        lefts.append(min(row["x0"] for row in rows))
        rights.append(max(row["x1"] for row in rows))
    if not lefts:
        return 0.0, doc[0].rect.width
    return median(lefts), median(rights)


def detect_toc(doc, bands):
    """Rows that read "title, dot leader, page number", in reading order."""
    spans = [(b["top"] - BAND_PAD_PT, b["bottom"] + BAND_PAD_PT) for b in bands]
    entries = []
    for index in range(doc.page_count):
        rows = [
            r
            for r in page_rows(doc[index])
            if not any(r["y0"] >= top and r["y1"] <= bottom for top, bottom in spans)
        ]
        previous = None
        for row in rows:
            match = TOC_LINE.match(row["text"].strip())
            segments = title_segments(row) if match else None
            if not segments:
                previous = row
                continue
            entries.append(
                {
                    "page_index": index,
                    "y0": row["y0"],
                    "x0": row["x0"],
                    # Distance from whatever sits above, which is how much air
                    # the first entry of a list needs under its heading.
                    "gap_before": (row["y0"] - previous["y1"]) if previous else 0.0,
                    "title": " ".join(s["text"] for s in segments),
                    "segments": segments,
                    "number": match.group("page"),
                    "font": segments[0]["font"],
                    "size": segments[0]["size"],
                    "bold": segments[0]["bold"],
                    "color": segments[0]["color"],
                }
            )
            previous = row
    return entries


def title_segments(row):
    """The columns before the dot leader, with their offsets from the row's left."""
    segments = []
    for column in row["columns"]:
        text = column["text"]
        match = LEADER.search(text)
        if match:
            text = text[: match.start()]
        text = text.strip(" " + INVISIBLE)
        if text:
            segments.append(
                {
                    "offset": round(column["x0"] - row["x0"], 1),
                    "text": text,
                    "font": column["font"],
                    "size": column["size"],
                    "bold": column["bold"],
                    "color": column["color"],
                }
            )
        if match:
            break
    return segments


def toc_line_pitch(entries):
    """Median distance between consecutive entries on one page."""
    gaps = [
        b["y0"] - a["y0"]
        for a, b in zip(entries, entries[1:])
        if a["page_index"] == b["page_index"] and b["y0"] > a["y0"]
    ]
    return median(gaps) if gaps else None


# ── step 3: write the bands back as Word headers and footers ──────────────


# WordprocessingML validates child order, and Word refuses to open a file
# that gets it wrong ("the file appears to be corrupted") rather than
# ignoring the element. python-docx orders the properties it knows about;
# these are the two sequences this script adds to itself.
PPR_ORDER = (
    "w:pStyle w:keepNext w:keepLines w:pageBreakBefore w:framePr w:widowControl w:numPr"
    " w:suppressLineNumbers w:pBdr w:shd w:tabs w:suppressAutoHyphens w:kinsoku w:wordWrap"
    " w:overflowPunct w:topLinePunct w:autoSpaceDE w:autoSpaceDN w:bidi w:adjustRightInd"
    " w:snapToGrid w:spacing w:ind w:contextualSpacing w:mirrorIndents w:suppressOverlap w:jc"
    " w:textDirection w:textAlignment w:textboxTightWrap w:outlineLvl w:divId w:cnfStyle"
    " w:rPr w:sectPr w:pPrChange"
).split()
SECTPR_ORDER = (
    "w:headerReference w:footerReference w:footnotePr w:endnotePr w:type w:pgSz w:pgMar"
    " w:paperSrc w:pgBorders w:lnNumType w:pgNumType w:cols w:formProt w:vAlign w:noEndnote"
    " w:titlePg w:textDirection w:bidi w:rtlGutter w:docGrid w:printerSettings w:sectPrChange"
).split()


def insert_ordered(parent, node, order):
    """Put `node` where the schema's sequence says it belongs."""
    tags = [qn(name) for name in order]
    position = tags.index(node.tag)
    for child in parent:
        if child.tag in tags and tags.index(child.tag) > position:
            child.addprevious(node)
            return
    parent.append(node)


def set_page_numbering_start(section, start):
    """`w:pgNumType w:start`, so Word prints the numbers the PDF printed."""
    element = section._sectPr
    for existing in element.findall(qn("w:pgNumType")):
        element.remove(existing)
    node = OxmlElement("w:pgNumType")
    node.set(qn("w:start"), str(start))
    insert_ordered(element, node, SECTPR_ORDER)


def add_page_field(paragraph):
    """A real PAGE field, so Word numbers the pages itself. Returns its runs."""
    runs = []
    for kind, text in (("begin", None), (None, " PAGE "), ("end", None)):
        run = OxmlElement("w:r")
        if kind:
            char = OxmlElement("w:fldChar")
            char.set(qn("w:fldCharType"), kind)
            run.append(char)
        else:
            instruction = OxmlElement("w:instrText")
            instruction.set(qn("xml:space"), "preserve")
            instruction.text = text
            run.append(instruction)
        paragraph._p.append(run)
        runs.append(run)
    return runs


def style_run(run, look):
    if look["font"]:
        run.font.name = look["font"]  # sets w:ascii and w:hAnsi
        fonts = run._element.get_or_add_rPr().get_or_add_rFonts()
        for attribute in ("w:cs", "w:eastAsia"):
            fonts.set(qn(attribute), look["font"])
    run.font.size = Pt(round(look["size"], 1))
    run.font.bold = look["bold"]
    run.font.color.rgb = rgb_of(look["color"])


def style_field(paragraph, elements, look):
    """Give a field's runs the same look, which python-docx cannot reach."""
    template = paragraph.add_run("")
    style_run(template, look)
    rpr = template._element.find(qn("w:rPr"))
    for element in elements:
        if rpr is not None:
            element.insert(0, copy.deepcopy(rpr))
    paragraph._p.remove(template._element)


def shade_paragraph(paragraph, fill):
    node = OxmlElement("w:shd")
    node.set(qn("w:val"), "clear")
    node.set(qn("w:color"), "auto")
    node.set(qn("w:fill"), "%02X%02X%02X" % tuple(max(0, min(255, int(round(c * 255)))) for c in fill[:3]))
    insert_ordered(paragraph._p.get_or_add_pPr(), node, PPR_ORDER)


def underline_paragraph(paragraph):
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")  # eighths of a point
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "auto")
    borders.append(bottom)
    insert_ordered(paragraph._p.get_or_add_pPr(), borders, PPR_ORDER)


def alignment_of(column, left, right):
    """Left, centre or right, from where the column sits in the text area."""
    centre = (left + right) / 2.0
    if abs(column["x0"] - left) <= ALIGN_TOLERANCE_PT:
        return "left"
    if abs(column["x1"] - right) <= ALIGN_TOLERANCE_PT:
        return "right"
    if abs((column["x0"] + column["x1"]) / 2.0 - centre) <= ALIGN_TOLERANCE_PT * 2:
        return "centre"
    return "left" if column["x0"] - left < right - column["x1"] else "right"


def band_height(band):
    """How tall the band's own line is, with room for a border under it."""
    text = max(band["text_bottom"] - band["text_top"], 1.0)
    tallest = max((column["size"] for column in band["columns"]), default=10.0)
    return max(text, tallest * 1.15)


def fill_band_paragraph(paragraph, band, left_margin, content_left, content_right):
    """One paragraph holding the band's left, centre and right columns.

    Tab stops and indents are measured from the section's own left margin,
    which pdf2docx sets per page, so the band lands on the same column as the
    body however the margins came out.
    """
    clear_paragraph(paragraph)
    fmt = paragraph.paragraph_format
    fmt.space_before = Pt(0)
    fmt.space_after = Pt(0)
    fmt.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    fmt.line_spacing = Pt(round(band_height(band), 1))
    fmt.left_indent = Pt(round(max(0.0, content_left - left_margin), 1))
    fmt.right_indent = Pt(0)
    reset_tab_stops(paragraph)
    centre = (content_left + content_right) / 2.0 - left_margin
    right = content_right - left_margin
    fmt.tab_stops.add_tab_stop(Pt(round(max(1.0, centre), 1)), WD_TAB_ALIGNMENT.CENTER, WD_TAB_LEADER.SPACES)
    fmt.tab_stops.add_tab_stop(Pt(round(max(2.0, right), 1)), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.SPACES)

    slots = {"left": [], "centre": [], "right": []}
    for column in band["columns"]:
        slots[alignment_of(column, content_left, content_right)].append(column)

    for order, name in enumerate(("left", "centre", "right")):
        if order:
            paragraph.add_run("\t")
        for column in slots[name]:
            for part in column["parts"]:
                if part["kind"] == "page":
                    style_field(paragraph, add_page_field(paragraph), column)
                else:
                    style_run(paragraph.add_run(part["text"]), column)

    if band["edge"] == "top" and band["rule_under"]:
        underline_paragraph(paragraph)
    if band["edge"] == "bottom" and band["strip_behind"]:
        shade_paragraph(paragraph, band["strip_behind"])


def clear_paragraph(paragraph):
    for run in list(paragraph.runs):
        run._element.getparent().remove(run._element)


def reset_tab_stops(paragraph):
    """Drop the paragraph's own tab stops and cancel the ones it inherits.

    Word merges a style's tab stops with the paragraph's rather than letting
    the paragraph replace them, and the built-in Header and Footer styles come
    with a centre and a right stop for one-inch margins. Leaving them in place
    sends the first tab to the style's centre stop and the right-hand piece of
    a running header lands in the middle of the page.
    """
    stops = paragraph.paragraph_format.tab_stops
    stops.clear_all()
    positions = []
    style = paragraph.style
    seen = set()
    while style is not None and id(style) not in seen:
        seen.add(id(style))
        positions.extend(stop.position for stop in style.paragraph_format.tab_stops)
        style = style.base_style
    for position in sorted(set(positions)):
        stops.add_tab_stop(position, WD_TAB_ALIGNMENT.CLEAR)


def section_blocks(body):
    """The top-level elements of each section, in order."""
    groups = [[]]
    for child in body:
        if child.tag == qn("w:sectPr"):
            continue
        groups[-1].append(child)
        properties = child.find(qn("w:pPr")) if child.tag == qn("w:p") else None
        if properties is not None and properties.find(qn("w:sectPr")) is not None:
            groups.append([])
    if groups and not groups[-1]:
        groups.pop()
    return groups


def shave_leading_space(blocks, amount):
    """Take `amount` points of blank space off the top of a section.

    Word reserves max(top margin, header distance + header height) before the
    body starts, and pdf2docx sets a top margin that assumed no header at all.
    Without this the whole page slides down by the height of the header, and a
    full page spills onto a second one. The space comes off the first
    paragraph's own spacing, which is the blank run-up pdf2docx writes to put
    the first line where the PDF had it.
    """
    left = amount
    for block in blocks:
        if left <= 0.01 or block.tag != qn("w:p"):
            break
        fmt = Paragraph(block, None).paragraph_format
        for name in ("space_after", "space_before"):
            value = getattr(fmt, name)
            if value is None:
                continue
            take = min(value.pt, left)
            setattr(fmt, name, Pt(round(value.pt - take, 1)))
            left -= take
        spacing = fmt.line_spacing  # a Length when exact, a bare float when a multiple
        if left > 0.01 and hasattr(spacing, "pt"):
            take = min(max(0.0, spacing.pt - 1.0), left)
            fmt.line_spacing = Pt(round(spacing.pt - take, 1))
            left -= take
        break  # only the run-up before the first real content is ours to take
    return left


def apply_bands(document, bands, page_height, content_left, content_right, page_count):
    """Put the bands back as real Word headers and footers.

    pdf2docx writes one section per PDF page with that page's own margins, so
    when the counts line up each section is given the band its page carried
    and the cover keeps its empty header. Otherwise every section gets the
    band and the first page is excluded with "different first page".
    """
    header_band = next((b for b in bands if b["edge"] == "top"), None)
    footer_band = next((b for b in bands if b["edge"] == "bottom"), None)
    offsets = [c["page_offset"] for b in bands for c in b["columns"] if c["page_offset"] is not None]
    band_pages = {index for band in bands for index in band["pages"]}
    sections = document.sections
    per_page = len(sections) == page_count
    blocks = section_blocks(document.element.body)
    warnings = []
    unshaved = 0.0

    for index, section in enumerate(sections):
        bare = per_page and index not in band_pages
        first_page_bare = not per_page and index == 0 and 0 not in band_pages
        section.different_first_page_header_footer = first_page_bare
        if first_page_bare:
            section.first_page_header.is_linked_to_previous = False
            section.first_page_footer.is_linked_to_previous = False
        left_margin = section.left_margin.pt
        for part, band in (("header", header_band), ("footer", footer_band)):
            holder = getattr(section, part)
            if bare and index == 0:
                # Nothing precedes the first section, so linking is the same
                # as having no header at all, and it costs the page no space.
                holder.is_linked_to_previous = True
                continue
            holder.is_linked_to_previous = False
            clear_paragraph(holder.paragraphs[0])
            if band is not None and not bare:
                fill_band_paragraph(holder.paragraphs[0], band, left_margin, content_left, content_right)
                continue
            # An empty definition still reserves its distance plus a line, and
            # with the margins pdf2docx writes that is enough to push a full
            # page onto a second one. Flatten it instead of leaving defaults.
            fmt = holder.paragraphs[0].paragraph_format
            fmt.space_before = Pt(0)
            fmt.space_after = Pt(0)
            fmt.line_spacing_rule = WD_LINE_SPACING.EXACTLY
            fmt.line_spacing = Pt(1)
            setattr(section, part + "_distance", Pt(0))

        if header_band and not bare:
            height = band_height(header_band) + (4.0 if header_band["rule_under"] else 2.0)
            reserved = header_band["text_top"] + height
            section.header_distance = Pt(round(header_band["text_top"], 1))
            if reserved > section.top_margin.pt:
                delta = reserved - section.top_margin.pt
                section.top_margin = Pt(round(reserved, 1))
                if index < len(blocks):
                    unshaved += shave_leading_space(blocks[index], delta)
        if footer_band and not bare:
            height = band_height(footer_band) + 2.0
            distance = max(0.0, page_height - footer_band["text_bottom"])
            if distance + height > section.bottom_margin.pt:
                distance = max(0.0, section.bottom_margin.pt - height)
            section.footer_distance = Pt(round(distance, 1))
            if distance + height > section.bottom_margin.pt:
                section.bottom_margin = Pt(round(distance + height, 1))
        if offsets and index == 0:
            set_page_numbering_start(section, offsets[0])

    if unshaved > 1.0:
        warnings.append(
            "The running header did not fit in the margin the converter chose on some pages, "
            "so their content sits about %d pt lower than in the PDF." % round(unshaved)
        )
    return warnings


# ── step 4: write the table of contents back ──────────────────────────────


def body_paragraphs(document):
    """Every `w:p` in the body, in document order, tables included.

    Walking the object model instead would visit a merged cell once per grid
    column it spans, and the same paragraph would then be deleted twice.
    """
    return list(document.element.body.iter(qn("w:p")))


def paragraph_text(element):
    return "".join(node.text or "" for node in element.iter(qn("w:t")))


def leader_runs(paragraphs):
    """Stretches of dot-leader paragraphs that could be a table of contents."""
    runs = []
    for index, element in enumerate(paragraphs):
        if not LEADER.search(paragraph_text(element)):
            continue
        if runs and index - runs[-1][-1] <= TOC_RUN_GAP + 1:
            runs[-1].append(index)
        else:
            runs.append([index])
    return [run for run in runs if len(run) >= TOC_RUN_MIN]


def removal_unit(body, element):
    """What has to go for one converted entry to disappear cleanly.

    A paragraph sitting directly in the body is its own unit. One inside a
    table is removed with its whole row: the number and the title of an entry
    land in different cells of the same row, and emptying a cell instead
    leaves a table Word will not open.
    """
    unit = element
    node = element.getparent()
    while node is not None and node is not body:
        if node.tag == qn("w:tr"):
            unit = node
        node = node.getparent()
    return unit


def top_level_block(body, element):
    node = element
    while node is not None and node.getparent() is not body:
        node = node.getparent()
    return node


def section_index_of(body, block):
    """Which section a top-level block belongs to."""
    index = 0
    for child in body:
        if child is block:
            return index
        if child.tag == qn("w:p"):
            properties = child.find(qn("w:pPr"))
            if properties is not None and properties.find(qn("w:sectPr")) is not None:
                index += 1
    return index


def squash(text):
    return re.sub(r"[^0-9a-z]+", "", text.lower())


def write_toc_entry(paragraph, entry, indent, right_stop, pitch, space_before):
    """One entry: indent, title, dot leader, page number.

    Tab stop positions are measured from the section's left margin, the same
    reference as the indent, so every entry's page number lines up at the
    right edge of the text area whatever its level.
    """
    fmt = paragraph.paragraph_format
    fmt.left_indent = Pt(round(indent, 1))
    fmt.right_indent = Pt(0)
    fmt.first_line_indent = Pt(0)
    fmt.space_after = Pt(0)
    fmt.space_before = Pt(round(space_before, 1))
    if pitch:
        fmt.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        fmt.line_spacing = Pt(round(pitch, 1))
    reset_tab_stops(paragraph)
    for segment in entry["segments"][1:]:
        if segment["offset"] > COLUMN_GAP_PT:
            fmt.tab_stops.add_tab_stop(
                Pt(round(indent + segment["offset"], 1)), WD_TAB_ALIGNMENT.LEFT, WD_TAB_LEADER.SPACES
            )
    fmt.tab_stops.add_tab_stop(Pt(round(max(indent + 1.0, right_stop), 1)), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)

    for order, segment in enumerate(entry["segments"]):
        if order:
            style_run(paragraph.add_run("\t" if segment["offset"] > COLUMN_GAP_PT else " "), segment)
        style_run(paragraph.add_run(segment["text"]), segment)
    last = entry["segments"][-1]
    style_run(paragraph.add_run("\t"), last)
    style_run(paragraph.add_run(entry["number"]), last)


def rebuild_toc(document, entries, content_left, content_right):
    """Replace the converted dot-leader paragraphs with one clean line each.

    Entries are matched to a stretch of dot-leader paragraphs by their title
    text, so a table of contents split over two pages still lands in the right
    place and a stray dot leader elsewhere in the document is left alone. The
    replacements are written at the body level even when the converter put the
    original inside a table, because a table cell would clip the dot leader at
    its own width rather than at the page's.
    """
    if not entries:
        return 0, []
    body = document.element.body
    paragraphs = body_paragraphs(document)
    runs = leader_runs(paragraphs)
    if not runs:
        return 0, ["The table of contents could not be found in the converted file, so it was left as it was."]

    pitch = toc_line_pitch(entries)
    haystacks = [squash("".join(paragraph_text(paragraphs[i]) for i in range(run[0], run[-1] + 1))) for run in runs]
    assigned = {index: [] for index in range(len(runs))}
    missed = 0
    for entry in entries:
        # The whole line first. Failing that, the title without its section
        # number: the converter sometimes leaves the number in the row above
        # the stretch this scan started at, and then only the words match.
        needles = [squash(entry["title"]), squash(entry["segments"][-1]["text"])]
        for index, haystack in enumerate(haystacks):
            if any(needle and needle in haystack for needle in needles):
                assigned[index].append(entry)
                break
        else:
            missed += 1

    written = 0
    for index, run in enumerate(runs):
        mine = assigned[index]
        if not mine:
            continue
        region = [paragraphs[position] for position in range(run[0], run[-1] + 1)]
        units = []
        for element in region:
            unit = removal_unit(body, element)
            if unit not in units:
                units.append(unit)
        block = top_level_block(body, units[0])
        if block is None:
            continue
        # The entries go back where their block sits: before it when the block
        # opened with one of them, after it when something else did (a page
        # heading the converter swept into the same table).
        opener = next((child for child in block if child.tag in (qn("w:tr"), qn("w:p"))), None)
        before = block is units[0] or opener is units[0]
        section = document.sections[min(section_index_of(body, block), len(document.sections) - 1)]
        left_margin = section.left_margin.pt
        right_stop = max(1.0, content_right - left_margin)

        made = []
        previous = None
        for entry in mine:
            element = OxmlElement("w:p")
            made.append(element)
            indent = max(0.0, entry["x0"] - left_margin)
            if previous is None:
                space = entry["gap_before"]
            elif pitch and previous["page_index"] == entry["page_index"]:
                space = max(0.0, (entry["y0"] - previous["y0"]) - pitch)
            else:
                space = 0.0
            write_toc_entry(
                Paragraph(element, document), entry, indent, right_stop, pitch, min(TOC_MAX_SPACE_BEFORE_PT, space)
            )
            previous = entry
            written += 1

        target = block
        for element in made:
            if before:
                target.addprevious(element)
            else:
                target.addnext(element)
                target = element
        for unit in units:
            parent = unit.getparent()
            if parent is not None:
                parent.remove(unit)
        if block.tag == qn("w:tbl") and not block.findall(qn("w:tr")):
            block.getparent().remove(block)

    warnings = []
    if missed:
        warnings.append(
            "%d table-of-contents %s not rebuilt; %s left as the converter wrote %s."
            % (missed, "entry was" if missed == 1 else "entries were", "it was" if missed == 1 else "they were",
               "it" if missed == 1 else "them")
        )
    return written, warnings


# ── the run ───────────────────────────────────────────────────────────────


def run_pdf2docx(source, target):
    """pdf2docx, with its own chatter kept off both streams.

    It logs a line per page on the root logger, which it configures itself at
    import time, and it prints the input path while doing so. Neither belongs
    in a server's output, so the level is lowered after the import and stdout
    is pointed at stderr for the call in case anything prints directly.
    """
    from pdf2docx import Converter

    logging.getLogger().setLevel(logging.ERROR)
    converter = Converter(source)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            converter.convert(target)
    finally:
        converter.close()


def convert(pdf_path, docx_path):
    warnings = []
    doc = pymupdf.open(pdf_path)
    try:
        if doc.page_count == 0:
            raise ConvertError("the PDF has no pages")
        pages = doc.page_count
        page_height = doc[0].rect.height
        content_left, content_right = content_bounds(doc)
        bands = [b for b in (detect_band(doc, "top"), detect_band(doc, "bottom")) if b]
        entries = detect_toc(doc, bands)
        band_pages = sorted({index for band in bands for index in band["pages"]})
        if not bands:
            warnings.append("No repeating header or footer was found, so the Word file has none.")
        else:
            bare = [i for i in range(1, pages) if i not in band_pages]
            if bare:
                warnings.append(
                    "%d page(s) after the first carry no running header or footer in the PDF; "
                    "Word repeats one on every page but the first." % len(bare)
                )
            strip_bands(doc, bands)
        stripped = docx_path + ".pdf"
        doc.save(stripped, garbage=3, deflate=True)
    finally:
        doc.close()

    part = docx_path + ".part"
    try:
        run_pdf2docx(stripped, part)
    finally:
        with contextlib.suppress(OSError):
            os.remove(stripped)
    if not os.path.exists(part) or os.path.getsize(part) == 0:
        raise ConvertError("the converter produced no Word file")

    document = Document(part)
    written, toc_warnings = rebuild_toc(document, entries, content_left, content_right)
    warnings.extend(toc_warnings)
    if bands:
        warnings.extend(apply_bands(document, bands, page_height, content_left, content_right, pages))
    document.save(part)
    os.replace(part, docx_path)

    if written:
        warnings.append("%d table-of-contents entries were rebuilt." % written)
    return {
        "ok": True,
        "pages": pages,
        "headerFooter": {
            "header": any(b["edge"] == "top" for b in bands),
            "footer": any(b["edge"] == "bottom" for b in bands),
            "pagesWithBands": len(band_pages),
        },
        "tocEntries": written,
        "warnings": warnings,
    }


def write_result(path, payload):
    with contextlib.suppress(OSError):
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True)


def main(argv):
    if len(argv) != 4:
        print("usage: convert.py <in.pdf> <out.docx> <result.json>", file=sys.stderr)
        return 2
    pdf_path, docx_path, result_path = argv[1], argv[2], argv[3]
    try:
        result = convert(pdf_path, docx_path)
    except ConvertError as err:
        write_result(result_path, {"ok": False, "message": str(err)[:300]})
        print(str(err)[:300], file=sys.stderr)
        return 1
    except Exception as err:  # noqa: BLE001 - a short message is all the caller gets
        message = ("%s: %s" % (type(err).__name__, err))[:300]
        write_result(result_path, {"ok": False, "message": message})
        print(message, file=sys.stderr)
        return 1
    write_result(result_path, result)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
