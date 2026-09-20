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
import math
import os
import re
import sys
import time
import unicodedata
import zipfile
from collections import Counter
from statistics import median
from xml.etree import ElementTree

import pymupdf
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor
from docx.text.paragraph import Paragraph

# Isolated mode drops the script's own directory from the import path, and
# the server runs this with -I, so the sibling module is found by hand.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fonts  # noqa: E402

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
# A running band is separated from the body by a margin, and body text is not.
# The candidate must clear the nearest body row by at least this fraction of
# the body's own line pitch. Measured on five documents (the ratio is the
# candidate's gap to the nearest body row over the median body line pitch):
#
#   a real running header, 23-page report      1.03     keep
#   a real footer, same report                14.13     keep
#   a real page-number footer, letter/1in     25.67     keep
#   a repeated FIRST BODY LINE under a header  0.13     drop
#   a repeated table header and data row       0.31     drop
#   alternating headers plus body lines        0.13     drop
#
# 0.5 sits in the empty middle: twice the worst false positive, half the
# tightest true one. Without it the repeated first body line of every page is
# deleted from the document and pasted into the Word header.
BAND_SEPARATION_RATIO = 0.5
# The gap above has to be measurable on more than this many of the band's
# pages. A page whose only text is the candidate cannot be measured, and a
# document made of those was accepted by default: every page's one body line
# was lifted into the Word header and the text check, having nothing left to
# compare, called it clean.
BAND_SEPARATION_MIN_PAGES = 2
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

# ── the decoration pdf2docx drops ─────────────────────────────────────────
# A filled rectangle survives the conversion when it becomes a table cell and
# is discarded otherwise. These separate the shapes worth putting back from
# the ones that are already handled, and every number is from the reference
# report: its table cells are 17.6 pt tall around an 11.6 pt line (ratio 1.5),
# its code panels 46.2 pt around three of them (4.2), its accent bar 7.2 pt
# wide, and its chart legend's swatches 9 pt squares 6 pt left of their label.
PANEL_MIN_WIDTH_PT = 40.0
PANEL_MIN_HEIGHT_PT = 12.0
PANEL_PADDING_RATIO = 1.6
BAR_MAX_WIDTH_PT = 12.0
PANEL_MIN_SIDE_PT = 3.0
SWATCH_MAX_SIDE_PT = 14.0
SWATCH_TEXT_GAP_PT = 10.0
# How many characters either side of a run boundary identify it. Eight is
# enough to be unambiguous on a report and short enough to survive the
# converter splitting a run somewhere else.
PAIR_WINDOW = 8
# Families whose name says the text is code. A space inserted into a command
# is a change to the report, not a repair, so the marker-space pass stays out
# of anything wearing one of these.
MONOSPACE = re.compile(r"mono|courier|consol|menlo|inconsolata|source ?code", re.IGNORECASE)
# A justified paragraph reaches the right edge on every line but its last.
# Three lines is the shortest run where that means anything: two lines both
# reaching the edge is also what a centred pair looks like.
JUSTIFY_MIN_LINES = 3
JUSTIFY_EDGE_PT = 3.0
JUSTIFY_LINE_GAP_PT = 6.0
# Slack added to a paragraph whose lines are broken where the PDF broke them.
# Word and typst measure a justified line a fraction differently, and a line
# that fills the column exactly in the PDF wraps twice here without it.
LINE_FIT_RELIEF_PT = 4.0
LINE_FIT_MAX_RELIEF_PT = 12.0
# English Metric Units, which is what a drawing in a Word file is measured in.
EMU_PER_PT = 12700

# ── what the converter will not take on ───────────────────────────────────
# Three bounds, all of them measured rather than guessed. The reference
# report's worst page holds 62 drawings in a 294 kB instruction stream, so
# every one of these has at least a seven times margin over a real report,
# while three A4 pages of 120,000 one-point rectangles (2.1 MB, 2.5 s out of
# typst) are refused in 0.08 s instead of costing the converter 35.9 s and
# 651 MB of RSS. Each refusal reads like the other server export limits and
# sends the operator to the PDF, which has none of these problems.
MAX_PAGES = 300
MAX_PAGE_CONTENT_BYTES = 3_000_000
MAX_PAGE_DRAWINGS = 10_000
# And a budget for the whole document, because the page bound misses the shape
# that really costs: 60 pages of 9,000 drawings clears every per-page test and
# still takes the converter 50.5 s and 403 MB. The reference report draws 479
# shapes across its 23 pages, so 150,000 is over 300 times a real report and
# still refuses that document at its 17th page, before the converter starts.
MAX_DOCUMENT_DRAWINGS = 150_000
# Address space for this process on Linux. PyMuPDF and OpenCV map far more
# than they touch, so this is well above the RSS it is meant to bound; it is
# a backstop that turns a runaway conversion into a MemoryError and a 422
# rather than a cgroup kill of the process that is also the Yjs relay.
ADDRESS_SPACE_LIMIT_BYTES = 3 * 1024 * 1024 * 1024

# Schemes a Word file may hand to the reader's shell. Everything else is
# removed from the PDF before the converter sees it: `FILE://host/share/x`
# resolves as UNC and leaks credentials, and `javascript:` and `ms-msdt:` are
# the same class of problem.
SAFE_LINK_SCHEMES = ("http", "https", "mailto")
LINK_SCHEME = re.compile(r"^\s*([A-Za-z][A-Za-z0-9+.\-]*)\s*:")

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


def truncate(text, limit):
    """`text` cut to `limit` characters, the last one an ellipsis when it was."""
    out = " ".join(str(text).split())
    return out if len(out) <= limit else out[: limit - 1] + "…"


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


def band_quorum(populated):
    """How many pages a group must appear on before it can be a band.

    The old rule was `max(2, round(n x 0.6))`, which on a four-page document
    is two pages: enough for two rows of a long table that happen to land at
    the same height to be read as a running band and deleted. So the floor is
    three, and a document too short for a fraction to mean anything has to
    carry the band on every page it could, bar one: a cover or a divider may
    have something else up there, and nothing else may.
    """
    if populated <= 3:
        return max(2, populated - 1)
    return max(3, math.ceil(populated * BAND_REPEAT_FRACTION))


def row_id(index, row):
    return (index, round(row["y0"], 1), round(row["x0"], 1))


def alternating_at_edge(groups, edge, quorum):
    """Two different texts taking turns at the outermost position, or None.

    An odd-and-even running header is two groups that never share a page. Word
    can express that (`w:evenAndOddHeaders` plus a second header part) and this
    script does not, so the honest answer is to leave that edge in the body
    rather than concatenate both texts into one header, which is what happened
    before: every page carried "Acme Security Assessment Contoso Consulting
    Group".
    """
    if len(groups) < 2:
        return None
    key = (lambda rows: min(r["y0"] for _, r in rows)) if edge == "top" else (lambda rows: -max(r["y1"] for _, r in rows))
    extreme = min(key(rows) for rows in groups)
    outermost = [rows for rows in groups if abs(key(rows) - extreme) <= BAND_Y_TOLERANCE_PT * 2]
    if len(outermost) < 2:
        return None
    pages = [{index for index, _ in rows} for rows in outermost]
    for i, first in enumerate(pages):
        for second in pages[i + 1 :]:
            if not (first & second) and len(first | second) >= quorum:
                return ("the running %s alternates between two texts, which Word cannot repeat "
                        "from one definition" % ("header" if edge == "top" else "footer"))
    return None


def separation(doc, cluster, edge):
    """How far the cluster sits from the body, as a multiple of the body's pitch.

    Returns `(gap, pitch, pages)`: the medians over the pages that carry the
    cluster, and how many pages could be measured at all. A page whose only
    text is the candidate contributes nothing, and a document made of those
    used to be accepted by default, which lifted every page's one body line
    into the header.
    """
    members = {row_id(index, row) for rows in cluster for index, row in rows}
    gaps, pitches = [], []
    for index in sorted({index for rows in cluster for index, _ in rows}):
        rows = page_rows(doc[index])
        mine = [r for r in rows if row_id(index, r) in members]
        rest = [r for r in rows if row_id(index, r) not in members]
        if not mine or not rest:
            continue
        if edge == "top":
            gaps.append(min(r["y0"] for r in rest) - max(r["y1"] for r in mine))
        else:
            gaps.append(min(r["y0"] for r in mine) - max(r["y1"] for r in rest))
        tops = sorted(r["y0"] for r in rest)
        steps = [b - a for a, b in zip(tops, tops[1:]) if 0 < b - a < 100]
        if steps:
            pitches.append(median(steps))
    if not gaps:
        return 0.0, None, 0
    return median(gaps), (median(pitches) if pitches else None), len(gaps)


def is_outermost(doc, cluster, edge):
    """Nothing else may be printed outside the band on a page that carries it."""
    members = {row_id(index, row) for rows in cluster for index, row in rows}
    for index in sorted({index for rows in cluster for index, _ in rows}):
        rows = page_rows(doc[index])
        mine = [r for r in rows if row_id(index, r) in members]
        rest = [r for r in rows if row_id(index, r) not in members]
        if not mine:
            continue
        if edge == "top" and any(r["y0"] < min(m["y0"] for m in mine) - 1.0 for r in rest):
            return False
        if edge == "bottom" and any(r["y1"] > max(m["y1"] for m in mine) + 1.0 for r in rest):
            return False
    return True


def covers_a_stranger(doc, pages, members, top, bottom):
    """Would erasing this rectangle take a row that is not part of the band?"""
    for index in pages:
        for row in page_rows(doc[index]):
            if row_id(index, row) in members:
                continue
            if row["y0"] >= top - BAND_PAD_PT and row["y1"] <= bottom + BAND_PAD_PT:
                return True
    return False


def detect_band(doc, edge):
    """The repeating header or footer of this document.

    Returns `(band, reason)`: a band and None, or None and a sentence saying
    why this edge was left in the body, or None and None when there was simply
    nothing repeating there.

    Rows in the edge zone are grouped by their normalized text and their
    rounded top edge, and a group has to survive four tests before it can be
    lifted out of the document. Each one exists because it caught real content
    being deleted:

    1. Quorum (`band_quorum`), so two rows of a long table cannot be a band.
    2. Stable digits (`describe_columns`), so a column whose number changes
       from page to page and is not the page number is body content.
    3. Separation (`BAND_SEPARATION_RATIO`), so a repeated first body line
       sitting one line under the header stays in the body.
    4. Outermost, so a band candidate with something printed beyond it is not
       a band at all.
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
        return None, None

    groups = {}
    for index in populated:
        seen = set()
        for row in per_page[index]:
            key = (normalize(row["text"]), round(row["y0"] / BAND_Y_TOLERANCE_PT))
            if key in seen:  # one page cannot vote twice for the same row
                continue
            seen.add(key)
            groups.setdefault(key, []).append((index, row))

    quorum = band_quorum(len(populated))
    alternation = alternating_at_edge(list(groups.values()), edge, quorum)
    if alternation:
        return None, alternation

    name = "header" if edge == "top" else "footer"
    keep = []
    rejected = None
    for rows in groups.values():
        if len(rows) < quorum:
            continue
        if len(populated) <= 3:
            # With so few pages the quorum allows one exception, and it has to
            # be a cover-like first page rather than any page that happens to
            # lack the row.
            absent = [i for i in populated if i not in {index for index, _ in rows}]
            if absent and absent != [populated[0]]:
                continue
        if describe_columns(rows) is None:  # test 2, reported by the describer
            rejected = ("the %s's number changes from page to page and is not a page number" % name)
            continue
        keep.append(rows)

    cluster = edge_cluster(keep, edge)
    # Test 3. The cluster is grown from the page edge inwards, so when it does
    # not clear the body the innermost group is the one that does not belong:
    # drop it and measure again, which is how a genuine header survives having
    # a repeated first body line stuck to it.
    while cluster:
        gap, pitch, measured = separation(doc, cluster, edge)
        if measured <= BAND_SEPARATION_MIN_PAGES:
            # Nothing to measure against on almost every page. That used to
            # count as a pass, and then a document whose only body line is the
            # candidate had that line lifted into the header with the text
            # check reporting "0 lines, 0 missing" as success.
            rejected = ("the %s could not be told apart from the body on enough pages" % name)
            cluster = []
            break
        if gap > 0 and (pitch is None or gap >= BAND_SEPARATION_RATIO * pitch):
            break
        rejected = ("the %s sits too close to the first line of the page to lift safely" % name
                    if edge == "top"
                    else "the footer sits too close to the last line of the page to lift safely")
        cluster = cluster[:-1]
    if not cluster:
        return None, rejected
    if not is_outermost(doc, cluster, edge):  # test 4
        return None, ("something else is printed outside the repeating %s on some pages" % name)

    repeating = cluster
    pages = sorted({index for rows in repeating for index, _ in rows})
    text_top = min(row["y0"] for rows in repeating for _, row in rows)
    text_bottom = max(row["y1"] for rows in repeating for _, row in rows)
    top, bottom = text_top, text_bottom

    # A rule under a header or a strip behind a footer is part of the band,
    # and swallowing it grows the rectangle that gets erased. That rectangle
    # is the whole page width, so growing it past the band's own text can take
    # body content with it: a per-page finding title at y 60 to 72 under a
    # header, with a repeating full-width rule at y 72.4, had all eight titles
    # erased. So the enlargement is offered and then checked, and a rectangle
    # that would cover a row which is not a band member is not taken.
    members = {row_id(index, row) for rows in repeating for index, row in rows}
    wanted_top, wanted_bottom = top, bottom
    rule_under = False
    strip_behind = None
    strip_full_width = False
    for drawing in repeating_drawings(doc, pages, edge):
        rect = drawing["rect"]
        if rect.y0 > wanted_bottom + BAND_GLUE_PT or rect.y1 < wanted_top - BAND_GLUE_PT:
            continue
        wanted_top = min(wanted_top, rect.y0)
        wanted_bottom = max(wanted_bottom, rect.y1)
        if drawing.get("fill") is not None and rect.height > 1.0:
            strip_behind = tuple(drawing["fill"])
            strip_full_width = rect.width >= doc[pages[0]].rect.width - 2.0
        elif edge == "top" and rect.y0 >= text_bottom - 1.0:
            rule_under = True
    if covers_a_stranger(doc, pages, members, wanted_top, wanted_bottom):
        # The decoration stays in the body. That is a cosmetic price (the rule
        # under the header is drawn twice, once by Word and once by the page
        # it was left on) against deleting a finding.
        rule_under = False
        strip_behind = None
        strip_full_width = False
    else:
        top, bottom = wanted_top, wanted_bottom

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
        "strip_full_width": strip_full_width,
        # The rows this band is made of, so the text check can leave out
        # exactly those and nothing else.
        "members": members,
    }, None


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
    """Turn one repeating row into columns Word can lay out, or None.

    Every occurrence has the same shape once digits are blanked out, so the
    digit runs line up slot by slot across pages. A slot whose value rises by
    one per page is the page number, and the difference between the printed
    number and the page index is kept so Word can start counting there.

    None means this is not a band. It comes back when a column holds a number
    that changes from page to page and is not the page number: `Host-073 |
    10.0.0.73 | Open port finding number 73` normalizes to the same text as
    every other row of that table, and deleting it as a running footer removes
    a real finding from the report. Digit blanking is what makes a page number
    stop mattering, so anything else it blanks has to be accounted for.
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
        one = describe_one_column(merged)
        return None if one is None else [one]
    width = counts.pop()
    described = [describe_one_column([(index, row["columns"][i]) for index, row in rows]) for i in range(width)]
    return None if any(column is None for column in described) else described


def describe_one_column(cells):
    """One column of a band, or None when its numbers say it is not one."""
    first = cells[0][1]
    numbers = [list(DIGITS.finditer(cell["text"])) for _, cell in cells]
    if len({len(n) for n in numbers}) != 1:
        return None  # a different count of numbers per page is not one band row
    slots = len(numbers[0])
    page_slot = None
    page_offset = None
    for slot in range(slots):
        offsets = {int(m[slot].group()) - index for (index, _), m in zip(cells, numbers)}
        if len(offsets) == 1 and len(cells) > 1:
            page_slot, page_offset = slot, offsets.pop()
            break
    for slot in range(slots):
        if slot == page_slot:
            continue
        if len({m[slot].group() for m in numbers}) != 1:
            return None  # a number that changes and is not the page number

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


def uniform_page_size(doc):
    """The page size every page shares, or None when they differ.

    The band geometry is one set of numbers for the whole document (a footer
    distance measured from the first page's height, a text area from the
    median of every page's own edges), which is wrong the moment a report
    turns a page sideways for a wide table. Rather than carry per-section
    geometry for a case no report here has, a mixed document keeps its bands
    in the body and is told so.
    """
    sizes = {(round(doc[i].rect.width, 1), round(doc[i].rect.height, 1)) for i in range(doc.page_count)}
    return sizes.pop() if len(sizes) == 1 else None


def drop_unsafe_pdf_links(doc):
    """Remove link annotations whose address Word would hand to the shell.

    pdf2docx copies a PDF link annotation into the Word file as an external
    relationship, and Word follows it. `FILE://host/share/x` resolves as UNC
    and leaks the reader's credentials to whoever owns that host; `smb://`,
    `javascript:` and `ms-msdt:` are the same class of problem. A report is
    attacker-influenced text, so the set of schemes that reach a client's
    machine is decided here and not by what the report asked for.

    Internal jumps (a table-of-contents link to another page) are not URI
    annotations and are left alone. A Launch action goes whatever it names:
    typst turns `#link("\\\\\\\\host\\\\share\\\\x")` into one of those rather
    than a URI, and a report has no business asking a reader's machine to open
    a file.
    """
    removed = 0
    for index in range(doc.page_count):
        page = doc[index]
        doomed = []
        for link in page.get_links():
            kind = link.get("kind")
            if kind == pymupdf.LINK_LAUNCH:
                doomed.append(link)
                continue
            if kind != pymupdf.LINK_URI:
                continue
            match = LINK_SCHEME.match(str(link.get("uri") or ""))
            if (match.group(1).lower() if match else "") not in SAFE_LINK_SCHEMES:
                doomed.append(link)
        for link in doomed:
            page.delete_link(link)
            removed += 1
    return removed


def unsafe_docx_targets(path):
    """External relationship targets in the Word file that should not be there.

    The belt to the braces above: the annotations were removed from the PDF
    before the converter saw it, so this should always come back empty. If it
    ever does not, something put an address into a client-facing file that
    this script did not vet, and the conversion fails rather than shipping it.
    """
    bad = []
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.endswith(".rels"):
                continue
            for rel in ElementTree.fromstring(archive.read(name)):
                if rel.get("TargetMode") != "External":
                    continue
                target = rel.get("Target") or ""
                match = LINK_SCHEME.match(target)
                if (match.group(1).lower() if match else "") not in SAFE_LINK_SCHEMES:
                    bad.append(target)
    return bad


def refuse_oversized(doc):
    """Stop a report the converter would spend minutes and gigabytes on.

    pdf2docx walks every vector drawing on a page and builds Python objects
    for the ones it keeps, so cost follows the drawing count rather than the
    file size, and neither the output cap nor the image pixel budget sees it.
    Measured on this machine, three A4 pages of 120,000 one-point rectangles:
    typst wrote them in 2.5 s into 2.1 MB, and the converter took 35.9 s and
    651 MB; at 150 pages it ran past the two-minute timeout. Counting them
    first costs a few milliseconds (see MAX_PAGE_DRAWINGS).
    """
    if doc.page_count > MAX_PAGES:
        raise ConvertError(
            "this report is %d pages, more than the %d the Word converter will take. Export the PDF instead."
            % (doc.page_count, MAX_PAGES)
        )
    total = 0
    for index in range(doc.page_count):
        page = doc[index]
        # The page's own instruction stream first, because reading its length
        # costs nothing: 0.08 s for the whole 120,000-shape document against
        # 2.0 s to count its drawings, and 0.002 s on the reference report.
        if len(page.read_contents()) > MAX_PAGE_CONTENT_BYTES:
            raise ConvertError(
                "page %d of this report is too complex for the Word converter. Export the PDF instead."
                % (index + 1)
            )
        # Then the count itself. get_cdrawings returns plain values rather
        # than Point and Rect objects, which is what makes it cheap enough to
        # run on every page: 0.028 s across the 23-page reference report.
        count = len(page.get_cdrawings())
        if count > MAX_PAGE_DRAWINGS:
            raise ConvertError(
                "page %d of this report draws %d shapes, more than the %d the Word converter will take. "
                "Export the PDF instead." % (index + 1, count, MAX_PAGE_DRAWINGS)
            )
        total += count
        # And the whole document, because the per-page bound misses the shape
        # that actually costs: 60 pages of 9,000 drawings clears every page
        # test and still takes the converter most of a minute. The loop stops
        # at the first page that puts the total over, so a long dense document
        # is refused without counting the rest of it.
        if total > MAX_DOCUMENT_DRAWINGS:
            raise ConvertError(
                "this report draws more than %d shapes, more than the Word converter will take. "
                "Export the PDF instead." % MAX_DOCUMENT_DRAWINGS
            )


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


def fill_band_paragraph(paragraph, band, left_margin, right_margin, content_left, content_right):
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
    indent = max(0.0, content_left - left_margin)
    # A strip that runs to the page edges in the PDF has to do the same here,
    # and Word shades a paragraph between its indents, so the paragraph is
    # pushed out into the margins and an extra tab stop puts the text back
    # where the text area starts. Without this the strip stops at the text
    # area and the page has two grey ends.
    bleeds = band["edge"] == "bottom" and band["strip_behind"] and band.get("strip_full_width")
    if bleeds:
        fmt.left_indent = Pt(-round(left_margin, 1))
        fmt.right_indent = Pt(-round(right_margin, 1))
    else:
        fmt.left_indent = Pt(round(indent, 1))
        fmt.right_indent = Pt(0)
    reset_tab_stops(paragraph)
    centre = (content_left + content_right) / 2.0 - left_margin
    right = content_right - left_margin
    if bleeds:
        fmt.tab_stops.add_tab_stop(Pt(round(max(1.0, indent), 1)), WD_TAB_ALIGNMENT.LEFT, WD_TAB_LEADER.SPACES)
    fmt.tab_stops.add_tab_stop(Pt(round(max(1.0, centre), 1)), WD_TAB_ALIGNMENT.CENTER, WD_TAB_LEADER.SPACES)
    fmt.tab_stops.add_tab_stop(Pt(round(max(2.0, right), 1)), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.SPACES)

    slots = {"left": [], "centre": [], "right": []}
    for column in band["columns"]:
        slots[alignment_of(column, content_left, content_right)].append(column)

    if bleeds:
        paragraph.add_run("\t")
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
        right_margin = section.right_margin.pt
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
                fill_band_paragraph(holder.paragraphs[0], band, left_margin, right_margin, content_left, content_right)
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
    """A title reduced to the characters that identify it, in any script.

    `[^0-9a-z]` reduced every Cyrillic, Greek and CJK title to the empty
    string, which matched nothing, and an entry that matched nothing used to
    be deleted along with the rest of its stretch.
    """
    return re.sub(r"[\W_]+", "", text.casefold(), flags=re.UNICODE)


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
    if missed:
        # All or nothing. Replacing a stretch deletes every paragraph in it,
        # including the ones an unmatched entry came from, so a rebuild that
        # cannot account for every entry would quietly drop the ones it could
        # not place. The list the converter wrote is ugly and complete, which
        # is the better of the two.
        return 0, [
            "The table of contents was left as the converter wrote it: %d of %d entries could not be "
            "matched to it." % (missed, len(entries))
        ]

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

    return written, []


# ── step 5: the decoration pdf2docx leaves behind ─────────────────────────
#
# It keeps a filled rectangle when it becomes a table cell and drops it
# otherwise, so a code block's grey panel, the darker bar down its left edge
# and a chart legend's colour squares all arrive as text on white paper. None
# of that changes what the document says, and all of it is what makes a report
# look like the PDF, so the rectangles are read out of the PDF and put back as
# paragraph shading, a paragraph border and a coloured glyph.


def hex_of(fill):
    return "%02X%02X%02X" % tuple(max(0, min(255, int(round(c * 255)))) for c in tuple(fill)[:3])


def find_decoration(doc, bands):
    """Filled rectangles the converter will drop, and the text they belong to.

    A panel is a filled rectangle with room around the text inside it. A table
    cell is a filled rectangle the text exactly fills, and pdf2docx already
    handles those, so the ratio of the rectangle's height to the tallest row
    inside it is what separates them: the reference report's cells come out at
    1.5 and its code panels at 4.2.

    A swatch is a small filled square sitting just left of a text row, which is
    how a chart legend is drawn.
    """
    member_rows = set()
    for band in bands:
        member_rows |= band.get("members") or set()
    panels, swatches = [], []
    for index in range(doc.page_count):
        page = doc[index]
        rows = [r for r in page_rows(page) if row_id(index, r) not in member_rows]
        # A table cell has neighbours: another filled rectangle sharing its
        # top and bottom (the rest of the row) or its left and right (the rest
        # of the column). A panel stands on its own. This is what separates
        # the two, because size does not: a risk matrix's cells are as tall as
        # a code block and painting one of those onto a paragraph puts a red
        # bar through a sentence. The accent bar is excluded from the test,
        # since it shares its panel's top and bottom by construction.
        wide = [d for d in page.get_drawings()
                if d.get("fill") is not None and d["rect"].width > BAR_MAX_WIDTH_PT]
        for drawing in page.get_drawings():
            fill = drawing.get("fill")
            if fill is None:
                continue
            rect = drawing["rect"]
            if PANEL_MIN_SIDE_PT <= rect.width <= SWATCH_MAX_SIDE_PT and rect.height <= SWATCH_MAX_SIDE_PT:
                # The label is the column that starts just to its right, not
                # the row: a legend puts four swatches on one line and only
                # the first of them would ever sit at the row's own left edge.
                for row in rows:
                    if row["y0"] >= rect.y1 or row["y1"] <= rect.y0:
                        continue
                    label = next((c for c in row["columns"] if 0 <= c["x0"] - rect.x1 <= SWATCH_TEXT_GAP_PT), None)
                    if label:
                        swatches.append({"fill": tuple(fill), "row": row, "label": label["text"]})
                        break
                continue
            if rect.width < PANEL_MIN_WIDTH_PT or rect.height < PANEL_MIN_HEIGHT_PT:
                continue
            if has_grid_neighbour(rect, wide):
                continue  # a table cell, which pdf2docx colours itself
            inside = [r for r in rows if r["y0"] >= rect.y0 - 1 and r["y1"] <= rect.y1 + 1
                      and r["x0"] >= rect.x0 - 1 and r["x1"] <= rect.x1 + 1]
            if not inside:
                continue
            tallest = max(r["y1"] - r["y0"] for r in inside)
            if len(inside) < 2 and rect.height < PANEL_PADDING_RATIO * tallest:
                continue  # text that exactly fills its box is a cell too
            panels.append({"fill": tuple(fill), "rows": inside, "rect": rect, "page": index, "bar": None})
    # A narrow filled rectangle hugging a panel's left edge is the accent bar.
    for index in range(doc.page_count):
        for drawing in doc[index].get_drawings():
            fill = drawing.get("fill")
            rect = drawing["rect"]
            if fill is None or rect.width > BAR_MAX_WIDTH_PT:
                continue
            for panel in panels:
                if panel["page"] != index or panel["bar"] is not None:
                    continue
                if abs(rect.x1 - panel["rect"].x0) <= 1.5 and abs(rect.y0 - panel["rect"].y0) <= 2.0:
                    panel["bar"] = {"fill": tuple(fill), "width": rect.width}
    return panels, swatches


def has_grid_neighbour(rect, others):
    """Another filled rectangle sharing this one's row or its column."""
    for other in others:
        box = other["rect"]
        if abs(box.x0 - rect.x0) < 0.5 and abs(box.x1 - rect.x1) < 0.5 and abs(box.y0 - rect.y0) > 0.5:
            return True
        if abs(box.y0 - rect.y0) < 0.5 and abs(box.y1 - rect.y1) < 0.5 and abs(box.x0 - rect.x0) > 0.5:
            return True
    return False


def shade_run_of_paragraphs(document, panels):
    """Shade the paragraphs a panel's text ended up in, and draw its bar.

    Matching is by text, in document order: the same code block appears on
    every finding page of a report, so "the only paragraph that contains this
    line" is the wrong question. The panels are walked in page order against a
    cursor into the paragraphs, which pairs the nth occurrence with the nth
    panel. A row that matches nothing ahead of the cursor is skipped. A
    paragraph
    that already carries a fill, or sits in a table cell that does, is left
    alone: pdf2docx colours the cells it recognised and a second fill would
    fight with it. It does not colour a code block, even though it does put
    one in a cell, which is why "is it in a table" is the wrong question and
    "does it already have a colour" is the right one.
    """
    body = document.element.body
    # Every paragraph, including the ones that already have a colour: a panel
    # the converter did handle still has to consume its place in the order, or
    # the cursor runs ahead and the next panel is painted onto the wrong text.
    paragraphs = body_paragraphs(document)
    squashed = [compare_squash(paragraph_text(p)) for p in paragraphs]
    painted = []
    cursor = 0
    for panel in sorted(panels, key=lambda p: (p["page"], p["rect"].y0)):
        matched = []
        for row in panel["rows"]:
            needle = compare_squash(row["text"])
            if len(needle) < COMPARE_MIN_CHARS:
                continue
            position = next((i for i in range(cursor, len(squashed)) if needle in squashed[i]), None)
            if position is not None:
                matched.append(position)
        if not matched:
            continue
        for position in sorted(set(matched)):
            if already_shaded(body, paragraphs[position]):
                continue
            paragraph = Paragraph(paragraphs[position], document)
            shade_paragraph(paragraph, panel["fill"])
            if panel["bar"]:
                left_border(paragraph, panel["bar"])
            painted.append(paragraphs[position])
        cursor = max(matched) + 1
    return painted


def already_shaded(body, element):
    """Does this paragraph, or the cell holding it, already carry a fill?"""
    node = element
    while node is not None and node is not body:
        properties = node.find(qn("w:pPr")) if node.tag == qn("w:p") else node.find(qn("w:tcPr"))
        if properties is not None:
            fill = properties.find(qn("w:shd"))
            if fill is not None and (fill.get(qn("w:fill")) or "auto").lower() not in ("auto", "ffffff", ""):
                return True
        node = node.getparent()
    return False


def left_border(paragraph, bar):
    node = OxmlElement("w:pBdr")
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    # Eighths of a point, and Word refuses anything above 48.
    left.set(qn("w:sz"), str(max(4, min(48, int(round(bar["width"] * 8))))))
    left.set(qn("w:space"), "0")
    left.set(qn("w:color"), hex_of(bar["fill"]))
    node.append(left)
    properties = paragraph._p.get_or_add_pPr()
    for existing in properties.findall(qn("w:pBdr")):
        properties.remove(existing)
    insert_ordered(properties, node, PPR_ORDER)


def restore_swatches(document, swatches):
    """Put a chart legend's colour squares back as coloured glyphs.

    pdf2docx drops a small filled square that is not part of a table, so the
    legend arrives as four words with nothing to tell them apart. A filled
    square character in the swatch's colour, in the run the label starts,
    reads the same at the size a legend is printed at.
    """
    body = document.element.body
    paragraphs = body_paragraphs(document)
    squashed = [compare_squash(paragraph_text(p)) for p in paragraphs]
    by_row = {}
    for swatch in swatches:
        by_row.setdefault(id(swatch["row"]), []).append(swatch)
    added = 0
    for group in by_row.values():
        labels = [compare_squash(s["label"]) for s in group]
        if not all(labels):
            continue
        runs = None
        # The whole legend in one paragraph, run by run.
        for element, text in zip(paragraphs, squashed):
            if all(label in text for label in labels):
                paragraph = Paragraph(element, document)
                found = [next((r._element for r in paragraph.runs
                               if compare_squash(r.text).startswith(label)), None) for label in labels]
                if all(run is not None for run in found):
                    runs = found
                break
        # Or one paragraph per label, in order, which is how the converter
        # writes a legend it has read as a column of cells.
        if runs is None:
            window = matching_sequence(paragraphs, squashed, labels)
            if window is None:
                continue
            if any(already_shaded(body, element) for element in window):
                continue  # the converter kept this cell's colour already
            runs = [element.find(qn("w:r")) for element in window]
            if any(run is None for run in runs):
                continue
        for swatch, target in zip(group, runs):
            target.addprevious(colour_square(target, swatch["fill"]))
            added += 1
    return added


def matching_sequence(paragraphs, squashed, labels):
    """The first run of paragraphs whose texts are exactly these labels, in order."""
    filled = [i for i, text in enumerate(squashed) if text]
    for start in range(len(filled) - len(labels) + 1):
        window = filled[start : start + len(labels)]
        if [squashed[i] for i in window] == labels:
            return [paragraphs[i] for i in window]
    return None


def colour_square(sibling, fill):
    """A run holding a filled square in `fill`, styled like its neighbour."""
    mark = copy.deepcopy(sibling if sibling.tag == qn("w:r") else OxmlElement("w:r"))
    if mark.tag != qn("w:r"):
        mark = OxmlElement("w:r")
    for child in list(mark):
        if child.tag != qn("w:rPr"):
            mark.remove(child)
    properties = mark.find(qn("w:rPr"))
    if properties is None:
        properties = OxmlElement("w:rPr")
        mark.insert(0, properties)
    for existing in properties.findall(qn("w:color")):
        properties.remove(existing)
    colour = OxmlElement("w:color")
    colour.set(qn("w:val"), hex_of(fill))
    properties.append(colour)
    text = OxmlElement("w:t")
    text.set(qn("xml:space"), "preserve")
    text.text = "■ "
    mark.append(text)
    return mark


def pdf_pictures(doc):
    """Every raster image the PDF places, with where it sits and what shows.

    A cover usually bleeds off the page, so the rectangle it was drawn at and
    the part of it a reader sees are two different things, and Word only has
    the second: an inline picture starts at the text origin and cannot hang
    over the page edge.
    """
    out = []
    for index in range(doc.page_count):
        page = doc[index]
        for info in page.get_image_info():
            rect = pymupdf.Rect(info["bbox"])
            visible = rect & page.rect
            if visible.is_empty or rect.width <= 0 or rect.height <= 0:
                continue
            out.append({"page": index, "rect": rect, "visible": visible})
    return out


def fit_pictures(document, pictures):
    """Give each inline picture the size and the crop the PDF gave it.

    pdf2docx sizes a picture to the rectangle it was drawn at, which for a
    full-bleed cover is larger than the page: Word then places all 816 pt of
    an 816 pt image from the top of the text area, so the whole page is
    pushed down by the bleed and the bottom is cut off. Cropping the picture
    to the part of it the PDF actually shows, with `a:srcRect`, and sizing it
    to that, puts it exactly where the PDF has it without moving anything
    else on the page.

    Only inline pictures are touched. The converter anchors the images it
    renders itself from vector art, and those have no counterpart here.
    """
    inlines = [d for d in document.element.body.iter(qn("wp:inline"))]
    if len(inlines) != len(pictures):
        return 0
    fixed = 0
    for element, picture in zip(inlines, pictures):
        rect, visible = picture["rect"], picture["visible"]
        width = int(round(visible.width * EMU_PER_PT))
        height = int(round(visible.height * EMU_PER_PT))
        for node in [element.find(qn("wp:extent"))] + list(element.iter(qn("a:ext"))):
            if node is None:
                continue
            node.set("cx", str(width))
            node.set("cy", str(height))
        crop = {
            "l": (visible.x0 - rect.x0) / rect.width,
            "t": (visible.y0 - rect.y0) / rect.height,
            "r": (rect.x1 - visible.x1) / rect.width,
            "b": (rect.y1 - visible.y1) / rect.height,
        }
        fill = next(element.iter(qn("pic:blipFill")), None)
        if fill is not None and any(value > 0.0005 for value in crop.values()):
            for existing in fill.findall(qn("a:srcRect")):
                fill.remove(existing)
            node = OxmlElement("a:srcRect")
            for side, value in crop.items():
                if value > 0.0005:
                    # Thousandths of a percent of the source image's side.
                    node.set(side, str(int(round(value * 100000))))
            blip = fill.find(qn("a:blip"))
            (blip.addnext(node) if blip is not None else fill.append(node))
        fixed += 1
    return fixed


def flush_left_runs(doc, bands, content_left, content_right):
    """Runs of consecutive lines that all begin at the text area's left edge.

    pdf2docx reads alignment off one line's geometry at a time, which goes
    wrong two ways in the same paragraph. It misses justification on some
    paragraphs and not others. And a middle line that happens to sit near the
    middle of the column is marked centred, so it renders a few characters in
    from the margin while the PDF has it flush: the reference report's
    "{{OUR_COMPANY}} strongly recommends..." came out with `jc="center"` in
    between two left-aligned lines of its own paragraph.

    The PDF settles both. A line that starts at the left edge is flush left,
    whatever its right end does, and a run of them whose every line but the
    last also reaches the right edge is justified. Three lines is the shortest
    run where that means anything, because two lines that both reach the edge
    is also what a centred pair looks like.
    """
    member_rows = set()
    for band in bands:
        member_rows |= band.get("members") or set()
    found = []
    for index in range(doc.page_count):
        rows = [r for r in page_rows(doc[index]) if row_id(index, r) not in member_rows]
        run = []

        def close(run):
            lines = [compare_squash(r["text"]) for r in run]
            if not any(len(line) >= COMPARE_MIN_CHARS for line in lines):
                return
            justified = False
            if len(run) >= JUSTIFY_MIN_LINES:
                # The edge is taken from the run itself and then checked
                # against the page's: justified prose overshoots the layout
                # column by a glyph's overhang, by up to 5 pt on the reference
                # report, while a table stops exactly on it.
                edge = max(r["x1"] for r in run[:-1])
                justified = (edge >= content_right - JUSTIFY_EDGE_PT
                             and all(abs(r["x1"] - edge) <= JUSTIFY_EDGE_PT for r in run[:-1]))
            # How far the run's longest line reaches past the column the
            # page nominally has. Word measures a line against the indents it
            # is given, and a forced line that is a hair too wide wraps twice:
            # the PDF's own overshoot is what that hair measures.
            overshoot = max((r["x1"] for r in run), default=content_right) - content_right
            found.append({"lines": lines, "justified": justified, "overshoot": overshoot})

        for row in rows + [None]:
            starts = row is not None and abs(row["x0"] - content_left) <= JUSTIFY_EDGE_PT
            # Consecutive lines of one paragraph: the next line's top may sit
            # a little above the previous line's bottom, because a line box is
            # taller than the text in it.
            follows = starts and (not run or -JUSTIFY_LINE_GAP_PT <= row["y0"] - run[-1]["y1"] <= JUSTIFY_LINE_GAP_PT)
            if not follows:
                close(run)
                run = [row] if starts else []
            else:
                run.append(row)
            # A line that does not reach the edge is the last line of its
            # paragraph, so the heading above a paragraph does not become part
            # of it and drag the whole run below the flush test.
            if run and run[-1]["x1"] < content_right - JUSTIFY_EDGE_PT:
                close(run)
                run = []
    return found


def force_line_breaks(document, runs, shaded):
    """Break each paragraph where the PDF broke it.

    Word's text engine breaks a justified line a word earlier or later than
    typst did, and on a text-heavy page that is the whole of what is left to
    see. The PDF knows where every line ended, so the converter's paragraphs
    are split there with a manual break and left justified: Word justifies a
    line that ends in a manual break, so they still reach both margins.

    What this costs is re-flow. Editing such a paragraph leaves the old breaks
    where they were, and the reader has to delete them (Find and Replace, `^l`
    for a space) to get a paragraph that wraps by itself again. The owner
    asked for the PDF's layout, which is what `--line-breaks=pdf` means.

    Code is never touched: a code block's lines are already separate
    paragraphs and its text must come out byte for byte. Neither is a
    paragraph the PDF wrote as one line, because there is nothing to break.
    """
    paragraphs = body_paragraphs(document)
    squashed = [compare_squash(paragraph_text(p)) for p in paragraphs]
    shaded = set(shaded)
    cursor = 0
    broken = 0
    for run in runs:
        lines = [line for line in run["lines"] if len(line) >= COMPARE_MIN_CHARS]
        if len(lines) < 2:
            cursor += 1
            continue
        joined = "".join(lines)
        position = next((i for i in range(cursor, len(squashed)) if squashed[i] == joined), None)
        if position is None:
            cursor += 1
            continue
        element = paragraphs[position]
        if is_code(element, shaded) or in_table_single_line(document.element.body, element):
            cursor = position + 1
            continue
        added = split_paragraph_at(element, lines)
        if added:
            # Widen the column by what the PDF's own lines overhang it, so a
            # line that fits there fits here and Word does not wrap it again
            # into a short orphan.
            relief = min(LINE_FIT_MAX_RELIEF_PT, max(0.0, run.get("overshoot", 0.0)) + LINE_FIT_RELIEF_PT)
            Paragraph(element, document).paragraph_format.right_indent = Pt(-round(relief, 1))
        broken += added
        cursor = position + 1
    return broken


def in_table_single_line(body, element):
    """Is this paragraph inside a table cell?

    Breaking inside one changes the row's height, and pdf2docx sized every row
    from the lines it wrote. Measured on the reference report, breaking inside
    cells cost page 9 about 0.07 of structural similarity on its own.
    """
    node = element.getparent()
    while node is not None and node is not body:
        if node.tag == qn("w:tc"):
            return True
        node = node.getparent()
    return False


def split_paragraph_at(element, lines):
    """Insert `w:br` at each of the PDF's line ends, splitting runs if need be.

    Landing a break only where a run boundary happens to fall is worse than
    not breaking at all: the paragraph then carries some of the PDF's line
    ends and lets Word choose the rest, and the two disagree. Measured on the
    reference report, that took three pages down by up to 0.23 structural
    similarity. So a break that falls inside a run splits it.
    """
    runs = [node for node in element.iter(qn("w:r")) if node.find(qn("w:t")) is not None]
    if not runs:
        return 0
    wanted = []
    total = 0
    for line in lines[:-1]:
        total += len(line)
        wanted.append(total)

    seen = 0
    inserted = 0
    queue = list(runs)
    while queue and wanted:
        node = queue.pop(0)
        text = node.find(qn("w:t"))
        raw = text.text or ""
        length = len(compare_squash(raw))
        if wanted[0] > seen + length:
            seen += length
            continue
        cut = raw_offset_for(raw, wanted[0] - seen)
        if cut is None:
            seen += length
            continue
        if cut < len(raw):
            tail = copy.deepcopy(node)
            spare = tail.find(qn("w:t"))
            spare.text = raw[cut:]
            spare.set(qn("xml:space"), "preserve")
            text.text = raw[:cut]
            text.set(qn("xml:space"), "preserve")
            node.addnext(tail)
            queue.insert(0, tail)
        # Its own run, so the break carries no text formatting of its own.
        holder = OxmlElement("w:r")
        holder.append(OxmlElement("w:br"))
        node.addnext(holder)
        inserted += 1
        wanted.pop(0)
        seen += len(compare_squash(raw[:cut]))
    return inserted


def raw_offset_for(text, squashed_count):
    """Where in `text` the first `squashed_count` comparable characters end."""
    for cut in range(1, len(text) + 1):
        if len(compare_squash(text[:cut])) >= squashed_count:
            return cut
    return None


def align_paragraphs(document, runs):
    """Give each flush-left line the alignment and indent the PDF gave it.

    Every line of a run starts at the same x in the PDF, so none of them may
    carry a first-line or hanging indent and none of them may be centred or
    right-aligned. The lines of a justified run are justified except the last,
    which is how Word writes a justified paragraph too.
    """
    paragraphs = body_paragraphs(document)
    squashed = [compare_squash(paragraph_text(p)) for p in paragraphs]
    cursor = 0
    done = 0
    for run in runs:
        for order, needle in enumerate(run["lines"]):
            if len(needle) < COMPARE_MIN_CHARS:
                continue
            position = next((i for i in range(cursor, len(squashed)) if needle in squashed[i]), None)
            if position is None:
                continue
            paragraph = Paragraph(paragraphs[position], document)
            last = order == len(run["lines"]) - 1
            paragraph.alignment = (WD_ALIGN_PARAGRAPH.JUSTIFY if run["justified"] and not last
                                   else WD_ALIGN_PARAGRAPH.LEFT)
            paragraph.paragraph_format.first_line_indent = Pt(0)
            # Not position + 1: the converter often writes several of these
            # lines as one paragraph, and that paragraph has to stay available
            # to the rest of the run.
            cursor = position
            done += 1
        cursor += 1
    return done


# ── step 6: the text the converter ran together ───────────────────────────


def typed_soft_hyphens(doc, bands):
    """Soft hyphens the author typed, rather than the ones typst broke lines at.

    A break hyphen is the last character of its line. One anywhere else was in
    the report's own text, is invisible to a reader, and is removed with the
    rest, so the export says how many.
    """
    member_rows = set()
    for band in bands:
        member_rows |= band.get("members") or set()
    typed = 0
    for index in range(doc.page_count):
        for row in page_rows(doc[index]):
            if row_id(index, row) in member_rows:
                continue
            for column in row["columns"]:
                text = column["text"]
                typed += text.count("­") - (1 if text.endswith("­") else 0)
    return max(0, typed)


def spaced_pairs(doc):
    """Boundaries where the PDF put a gap and the converter may not.

    pdf2docx writes one run per PDF span and drops the space between two of
    them, so a numbered step arrives as "1.{{REMEDIATION STEP}}". The PDF
    knows there was a gap there, so the pairs are collected here and matched
    against the converter's run boundaries afterwards.
    """
    pairs = set()
    for index in range(doc.page_count):
        for row in page_rows(doc[index]):
            for left, right in zip(row["columns"], row["columns"][1:]):
                pairs.add((compare_squash(left["text"])[-PAIR_WINDOW:],
                           compare_squash(right["text"])[:PAIR_WINDOW]))
            # Within a column the row builder already inserted the space, so
            # the pair is taken from the text it produced.
            for column in row["columns"]:
                text = column["text"]
                for position, char in enumerate(text):
                    if char == " " and position and position + 1 < len(text):
                        pairs.add((compare_squash(text[:position])[-PAIR_WINDOW:],
                                   compare_squash(text[position + 1:])[:PAIR_WINDOW]))
    return {pair for pair in pairs if pair[0] and pair[1]}


def is_code(element, shaded):
    """Is this paragraph code, where a space is a change and not a repair?

    Two signals, either of which is enough: the shape pass painted it as a
    panel (a code block is the thing that comes out of the converter as bare
    text on white paper), or every run in it names a monospace family.
    """
    if element in shaded:
        return True
    fonts = [f.get(qn("w:ascii")) or "" for f in element.iter(qn("w:rFonts"))]
    return bool(fonts) and all(MONOSPACE.search(name) for name in fonts)


def repair_text(document, pairs, shaded=()):
    """Drop soft hyphens, and put back a space the converter ran together.

    A soft hyphen is where the typesetter broke a word, not a character of the
    document, and Word prints it: the reference report showed "em-ployed",
    "likeli-hood" and "appro-priate" in the middle of a line. Real hyphens are
    U+002D and are left alone, which is why this does not use pdf2docx's own
    `delete_end_line_hyphen`: that would turn "non-critical" into
    "noncritical". Every soft hyphen goes, including one an author typed on
    purpose and including one inside a code block; `typed_soft_hyphens` counts
    those separately so the export can say it happened.

    The space repair is kept away from code. The text check squashes
    whitespace, so a space added inside a command would be invisible to it,
    and `1.{{X}}` or `version1.2.3` in a shell line must come out byte for
    byte as the report wrote it.
    """
    shaded = set(shaded)
    removed, spaced = 0, 0
    for element in body_paragraphs(document):
        nodes = [n for n in element.iter(qn("w:t"))]
        for node in nodes:
            if node.text and "­" in node.text:
                removed += node.text.count("­")
                node.text = node.text.replace("­", "")
                node.set(qn("xml:space"), "preserve")
        if is_code(element, shaded):
            continue
        for left, right in zip(nodes, nodes[1:]):
            if not left.text or not right.text:
                continue
            if left.text[-1].isspace() or right.text[0].isspace():
                continue
            key = (compare_squash(left.text)[-PAIR_WINDOW:], compare_squash(right.text)[:PAIR_WINDOW])
            if key[0] and key[1] and key in pairs:
                right.text = " " + right.text
                right.set(qn("xml:space"), "preserve")
                spaced += 1
    return removed, spaced


# ── the safety net: did the Word file keep the PDF's text? ────────────────
#
# Every repair above deletes something from the document and writes something
# back, and a heuristic that deletes the wrong thing is the one failure nobody
# would notice: the Word file still looks like a report. So the two texts are
# compared afterwards, and a conversion that lost any of the PDF's words is
# thrown away and done again with the repairs off.

# Characters a typesetter leaves in the text layer that no reader sees.
INVISIBLE_FOR_COMPARE = dict.fromkeys(
    ord(c) for c in "­​‌‍⁠﻿‎‏"
)
# Three dots or more is a leader, not words. The PDF writes them as characters
# and Word draws them from a tab stop, so neither side may count them.
DOT_RUN = re.compile(r"(?:\.[ \t ]*){3,}")
# Whitespace, hyphens and dashes: everything a re-flow may add, drop or move.
DASHES = "".join(chr(c) for c in (0x2D, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212))
SQUASH_DROP = re.compile("[\\s%s]+" % re.escape(DASHES), re.UNICODE)
HAS_ALNUM = re.compile(r"\w", re.UNICODE)
# A piece of text shorter than this proves nothing: "1." and "LOW" occur all
# over a report, so finding one somewhere does not mean this one survived, and
# not finding it would be noise.
COMPARE_MIN_CHARS = 4


W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
W_T = W_NS + "t"
BREAKS = (W_NS + "tab", W_NS + "br", W_NS + "p")


def compare_squash(text):
    """One block of text, flattened into the form both sides are compared in.

    Everything that a re-flow is allowed to change goes: whitespace of any
    kind, hyphens and dashes, dot leaders, and the invisible characters a
    typesetter leaves behind. What is left is the letters and digits in order,
    which is what has to survive the conversion.

    Whitespace has to go rather than be collapsed, because the two sides
    disagree about it constantly and none of it is content: the PDF prints
    "1. {{RECOMMENDATION}}" as two pieces on one line and the converter writes
    one run reading "1.{{RECOMMENDATION}}"; a word broken across two PDF lines
    comes back with the hyphen kept, dropped or turned into a space.
    """
    out = unicodedata.normalize("NFKC", text).translate(INVISIBLE_FOR_COMPARE)
    out = DOT_RUN.sub("", out)
    return SQUASH_DROP.sub("", out).casefold()


def body_lines(doc, bands):
    """The PDF's text for the comparison: one entry per line, with its pieces.

    A band's text is expected once per page in the PDF and once per section in
    the Word file, and those two counts have nothing to do with each other, so
    the comparison drops it on both sides instead of trying to reconcile them.
    Pages that do not carry the band keep every line.

    Each line also carries its columns, because they are the pieces that are
    really contiguous on the page. A row of a two-column table reads
    "TECHNIQUES MITIGATIONS" across the page and the converter writes the
    cells down one column and then the other, which is a re-ordering rather
    than a loss, and only the columns survive it.

    What is left out is the band's own MEMBER ROWS, never "everything inside
    the rectangle the band erases". Those are two different things: the
    rectangle is grown to swallow a rule or a strip, and excluding by
    rectangle hid from this check exactly the rows that growing it deleted.
    Anything else the erase removes is now reported as missing, which is what
    sends the conversion to the fallback.
    """
    members = set()
    for band in bands:
        members |= band.get("members") or set()
    lines = []
    for index in range(doc.page_count):
        for row in page_rows(doc[index]):
            if row_id(index, row) in members:
                continue
            lines.append({"text": row["text"], "pieces": [c["text"] for c in row["columns"]]})
    return lines


def docx_text(path, body_only):
    """Every word in the Word file, as one string.

    `body_only` leaves out `header*.xml` and `footer*.xml`, which is what the
    comparison wants when the bands were lifted into them. Everything else is
    read straight off the XML rather than through python-docx, so table cells,
    text boxes and anything else carrying a `w:t` is counted without having to
    know where it sits.
    """
    parts = []
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.startswith("word/") or not name.endswith(".xml"):
                continue
            leaf = name[len("word/"):]
            if body_only and (leaf.startswith("header") or leaf.startswith("footer")):
                continue
            if not (leaf == "document.xml" or leaf.startswith(("header", "footer", "footnotes", "endnotes"))):
                continue
            tree = ElementTree.fromstring(archive.read(name))
            for node in tree.iter():
                if node.tag == W_T and node.text:
                    parts.append(node.text)
                elif node.tag in BREAKS:
                    parts.append("\n")
    return "".join(parts)


def missing_from_docx(pdf_lines, docx_body_text):
    """PDF lines the Word file does not contain, in order. Empty is the pass.

    A piece of a line is present when its squashed characters appear, in order
    and unbroken, somewhere in the Word file's squashed text. Deleting a line
    is exactly what breaks that: its letters stop being next to each other.
    A piece shorter than COMPARE_MIN_CHARS is not evidence either way, because
    "1." and "LOW" appear all over a report, so it is not looked for.

    Three readings were tried, and the numbers are from the reference report,
    which loses nothing and therefore has to come back clean. Counting words
    reported 62 lines missing, every one a short token such as "1." whose count
    differs because the converter merged two table cells. Matching runs of
    words reported 38, every one a place where the converter's run boundaries
    fall inside text the PDF had spaced differently. Squashed characters per
    line reported 8, all of them two-column table rows the converter writes
    one column at a time. Squashed characters per column report 0, and still
    catch every deletion the tests below make.
    """
    haystack = compare_squash(docx_body_text)
    # Presence is not enough: three identical rows of a table against one in
    # the Word file is two rows lost, and a substring test calls it a pass. So
    # each distinct piece has to occur at least as often as the PDF prints it.
    # Occurrences are counted without overlap, which is the reading that
    # matches "how many times does the page show this".
    wanted = Counter()
    for line in pdf_lines:
        for piece in (line["pieces"] or [line["text"]]):
            squashed = compare_squash(piece)
            if len(squashed) >= COMPARE_MIN_CHARS:
                wanted[squashed] += 1
    have = {piece: haystack.count(piece) for piece in wanted}

    missing = []
    for line in pdf_lines:
        pieces = [compare_squash(piece) for piece in (line["pieces"] or [line["text"]])]
        looked_for = [p for p in pieces if len(p) >= COMPARE_MIN_CHARS]
        if any(have.get(p, 0) < wanted[p] for p in looked_for):
            missing.append(line["text"])
    return missing


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


def convert(pdf_path, docx_path, budget_seconds=None, line_breaks="pdf", font_dirs=()):
    """Read the PDF, decide the repairs, convert, and check nothing was lost.

    The two repairs delete part of the document and write something back, and
    a heuristic that deletes the wrong thing would leave a Word file that
    still looks like a report. So the result is compared against the PDF's own
    text, and a conversion that lost any of it is thrown away and done again
    with both repairs off. That second file keeps the bands in the body and
    may run to more pages than the PDF, which is said plainly rather than
    silently traded for a page count.
    """
    warnings = []
    doc = pymupdf.open(pdf_path)
    try:
        if doc.page_count == 0:
            raise ConvertError("the PDF has no pages")
        refuse_oversized(doc)
        pages = doc.page_count
        page_height = doc[0].rect.height
        content_left, content_right = content_bounds(doc)
        removed_links = drop_unsafe_pdf_links(doc)
        if removed_links:
            warnings.append(
                "%d link(s) with unsupported addresses were removed from the Word file." % removed_links
            )
        bands = []
        for edge, name in (("top", "header"), ("bottom", "footer")):
            band, reason = detect_band(doc, edge)
            if band:
                bands.append(band)
            elif reason:
                warnings.append(
                    "The running %s could not be lifted out safely (%s), so it stays in the page body "
                    "and the page count may differ from the PDF." % (name, reason)
                )
            else:
                warnings.append(
                    "No repeating %s was found, so the Word file has none and its page count may "
                    "differ from the PDF." % name
                )
        if bands and uniform_page_size(doc) is None:
            bands = []
            warnings.append(
                "This report mixes page sizes, so the running header and footer stay in the page body "
                "and the page count may differ from the PDF."
            )
        entries = detect_toc(doc, bands)
        band_pages = sorted({index for band in bands for index in band["pages"]})
        if bands:
            bare = [i for i in range(1, pages) if i not in band_pages]
            if bare:
                warnings.append(
                    "%d page(s) after the first carry no running header or footer in the PDF; "
                    "Word repeats one on every page but the first." % len(bare)
                )
        repaired_lines = body_lines(doc, bands)
        plain_lines = body_lines(doc, [])
        # Read before the bands are erased, so a panel that reaches into the
        # band zone is still described, and kept for the post-processing pass
        # that runs once the converter has produced a file.
        pictures = pdf_pictures(doc)
        families = fonts.wanted_families(doc, font_family) if font_dirs else set()
        panels, swatches = find_decoration(doc, bands)
        pairs = spaced_pairs(doc)
        aligned = flush_left_runs(doc, bands, content_left, content_right)
        typed_hyphens = typed_soft_hyphens(doc, bands)
        # Two inputs: the PDF as it stands, for the fallback, and a copy with
        # the bands erased, for the repaired pass.
        plain_pdf = docx_path + ".plain.pdf"
        doc.save(plain_pdf, garbage=3, deflate=True)
        stripped_pdf = plain_pdf
        if bands:
            strip_bands(doc, bands)
            stripped_pdf = docx_path + ".stripped.pdf"
            doc.save(stripped_pdf, garbage=3, deflate=True)
    finally:
        doc.close()

    part = docx_path + ".part"
    written = 0
    fell_back = False
    try:
        started = time.monotonic()
        run_pdf2docx(stripped_pdf, part)
        first_pass = time.monotonic() - started
        if not os.path.exists(part) or os.path.getsize(part) == 0:
            raise ConvertError("the converter produced no Word file")
        repair_warnings = []
        document = Document(part)
        written, toc_warnings = rebuild_toc(document, entries, content_left, content_right)
        repair_warnings.extend(toc_warnings)
        if bands:
            repair_warnings.extend(apply_bands(document, bands, page_height, content_left, content_right, pages))
        shaded = shade_run_of_paragraphs(document, panels)
        restore_swatches(document, swatches)
        align_paragraphs(document, aligned)
        fit_pictures(document, pictures)
        if line_breaks == "pdf":
            force_line_breaks(document, aligned, shaded)
        repair_text(document, pairs, shaded)
        document.save(part)
        missing = missing_from_docx(repaired_lines, docx_text(part, body_only=bool(bands)))
        checked_lines = repaired_lines
        if bands and not repaired_lines:
            # Everything on every page was a band member, so the check had
            # nothing to compare and would otherwise report a clean pass on a
            # document whose whole body was lifted into the header.
            missing = ["(the whole document was read as a running header or footer)"]

        if missing and (bands or written):
            # Doing it again costs about what the first pass cost, and the
            # server kills the child at its own timeout with a message that
            # says nothing useful. Better to stop here and say why.
            if budget_seconds is not None and time.monotonic() - started + first_pass > budget_seconds:
                raise ConvertError(
                    "The header and footer repair lost text and there was not enough time to convert "
                    "again. Export the PDF instead."
                )
            # Something the repairs touched is gone. Convert again with both
            # of them off and keep that file instead, whatever it costs in
            # page count: a Word file that reads wrong is recoverable, one
            # that is missing a finding is not.
            fell_back = True
            repair_warnings = [
                "The header and footer could not be lifted safely on this report, so the Word file "
                "keeps them in the page body and its page count may differ from the PDF."
            ]
            run_pdf2docx(plain_pdf, part)
            if not os.path.exists(part) or os.path.getsize(part) == 0:
                raise ConvertError("the converter produced no Word file")
            # The decoration is not a repair and cannot lose text, so it runs
            # on the fallback too.
            document = Document(part)
            shaded = shade_run_of_paragraphs(document, panels)
            restore_swatches(document, swatches)
            align_paragraphs(document, aligned)
            fit_pictures(document, pictures)
            if line_breaks == "pdf":
                force_line_breaks(document, aligned, shaded)
            repair_text(document, pairs, shaded)
            document.save(part)
            written = 0
            bands = []
            checked_lines = plain_lines
            missing = missing_from_docx(plain_lines, docx_text(part, body_only=False))

        warnings.extend(repair_warnings)
        if missing:
            # Still short after the fallback: this is the converter itself
            # dropping text, and nothing here can put it back. Name it.
            sample = "; ".join(truncate(line, 60) for line in missing[:2])
            warnings.append(
                "%d line(s) of the PDF could not be found in the Word file, starting with \"%s\". "
                "Compare the two before sending." % (len(missing), sample)
            )
        unsafe = unsafe_docx_targets(part)
        if unsafe:
            raise ConvertError(
                "the Word file came out with a link this server does not allow (%s)"
                % truncate(unsafe[0], 60)
            )
        embedded, skipped = ([], [])
        if families:
            embedded, skipped = fonts.embed(part, families, fonts.collect(font_dirs))
            for family, why in skipped:
                warnings.append(
                    "%s could not be embedded (%s), so on a computer without it Word will substitute "
                    "another font and some lines may wrap twice." % (family, why)
                )
        os.replace(part, docx_path)
    finally:
        for temporary in (plain_pdf, stripped_pdf):
            with contextlib.suppress(OSError):
                os.remove(temporary)

    if typed_hyphens:
        warnings.append(
            "%d invisible soft hyphen(s) that were typed into the report were removed." % typed_hyphens
        )
    if written:
        warnings.append("%d table-of-contents entries were rebuilt." % written)
    return {
        "ok": True,
        "pages": pages,
        "headerFooter": {
            "header": any(b["edge"] == "top" for b in bands),
            "footer": any(b["edge"] == "bottom" for b in bands),
            "pagesWithBands": len({index for band in bands for index in band["pages"]}),
        },
        "lineBreaks": line_breaks,
        "fontsEmbedded": embedded,
        "tocEntries": written,
        "textCheck": {"pdfLines": len(checked_lines), "missing": len(missing), "fellBack": fell_back},
        "warnings": warnings,
    }


def write_result(path, payload):
    with contextlib.suppress(OSError):
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True)


def cap_address_space():
    """Bound this process on Linux, where `resource` exists.

    The relay process is the cgroup's other tenant, so a conversion that runs
    away should be the one that dies, with a message, rather than leaving the
    kernel to choose. The limit is on address space rather than RSS because
    that is what `resource` offers, and PyMuPDF and OpenCV map far more than
    they touch: measured on the 120,000-shape document, 651 MB of RSS against
    a little over 2 GB mapped, which is why the number is 3 GB and not 768 MB.
    Below about 2.5 GB the import of OpenCV itself fails, so a tighter limit
    would refuse every export rather than only the runaway one. Windows has no
    `resource` module and relies on the page, shape and size bounds instead.

    On the 1 GB box this server is built for the limit is inert: the cgroup
    kills the child long before 3 GB of address space is mapped, and the
    existing "a SIGKILL we did not send is the memory killer" mapping turns
    that into a 422. It earns its place on a larger host, where nothing else
    would stop one export taking the machine.
    """
    try:
        import resource
    except ImportError:
        return False
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    want = ADDRESS_SPACE_LIMIT_BYTES
    if hard != resource.RLIM_INFINITY:
        want = min(want, hard)
    if soft != resource.RLIM_INFINITY and soft <= want:
        return False
    with contextlib.suppress(ValueError, OSError):
        resource.setrlimit(resource.RLIMIT_AS, (want, hard))
        return True
    return False


def main(argv):
    cap_address_space()
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = [a for a in argv[1:] if a.startswith("--")]
    if len(args) not in (3, 4):
        print("usage: convert.py [--line-breaks=pdf|word] [--fonts=DIR] <in.pdf> <out.docx> <result.json> [budget]",
              file=sys.stderr)
        return 2
    pdf_path, docx_path, result_path = args[0], args[1], args[2]
    # `pdf` reproduces the PDF's own line endings, which is what the report
    # is for; `word` lets Word re-flow, which reads better under editing.
    line_breaks = "pdf"
    for flag in flags:
        if flag.startswith("--line-breaks="):
            line_breaks = "word" if flag.split("=", 1)[1] == "word" else "pdf"
    # Directories holding the report's own fonts and the defaults the
    # browser compiler ships, so the families the PDF names can be found
    # as files and carried into the Word file.
    font_dirs = [flag.split("=", 1)[1] for flag in flags if flag.startswith("--fonts=")]
    # How long the caller will wait, so the decision to convert a second time
    # is made here rather than by a SIGKILL with a generic message.
    budget = None
    if len(args) == 4:
        with contextlib.suppress(ValueError):
            budget = max(1.0, float(args[3]))
    try:
        result = convert(pdf_path, docx_path, budget_seconds=budget, line_breaks=line_breaks,
                         font_dirs=font_dirs)
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
