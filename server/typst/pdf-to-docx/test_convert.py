#!/usr/bin/env python3
"""Checks for convert.py's readers, against a PDF this file builds itself.

    <venv>/python -I -B test_convert.py          the built-in document
    <venv>/python -I -B test_convert.py a.pdf    plus a real report

Run by hand. It is deliberately not part of `bun run test`: the server's test
suite runs under Bun with no Python, and this needs pymupdf. It needs neither
Word nor the converter's output, because everything it checks is a pure
function of the PDF: which bands repeat, where they sit, what the page-number
offset is, and which lines read as a table of contents.

With a PDF argument it prints what it found there instead of asserting, which
is the quickest way to see why a real report behaves the way it does.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from xml.etree import ElementTree

import pymupdf
from docx import Document
from docx.shared import Pt

# Isolated mode drops the script's own directory from the import path, and
# this file is run with it so it sees what the server's child process sees.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import convert  # noqa: E402

PAGE_WIDTH, PAGE_HEIGHT = 612.0, 792.0
LEFT, RIGHT = 54.0, 558.0
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
# The run children that put something on the page. A run of none of these is
# a bookmark or a field boundary, and what font it names does not show.
VISIBLE_RUN_CHILDREN = tuple(W + tag for tag in ("t", "tab", "br", "sym", "noBreakHyphen",
                                                 "softHyphen", "instrText"))


def build_pdf():
    """Four pages: a bare cover, then three with a header, footer and a list.

    Page 1 (index 1) carries the table of contents. Printed page numbers start
    at 1 on index 1, which is the offset the converter has to work out so Word
    prints the same numbers.
    """
    doc = pymupdf.open()
    for index in range(4):
        page = doc.new_page(width=PAGE_WIDTH, height=PAGE_HEIGHT)
        if index == 0:
            page.insert_text((200, 400), "COVER", fontsize=30)
            continue
        page.insert_text((LEFT, 46), "ACME Security Assessment", fontsize=10)
        page.insert_text((RIGHT - 60, 46), "Contoso Ltd", fontsize=10)
        page.draw_line((LEFT, 53), (RIGHT, 53), width=1)
        page.draw_rect(pymupdf.Rect(0, 770, PAGE_WIDTH, PAGE_HEIGHT), fill=(0.95, 0.95, 0.95))
        page.insert_text((250, 785), "CONFIDENTIAL", fontsize=9)
        page.insert_text((RIGHT - 10, 785), str(index), fontsize=9)
        page.insert_text((LEFT, 90), "Body text on page %d." % index, fontsize=11)
    toc = doc[1]
    leader = " . " * 40
    toc.insert_text((LEFT, 150), "1. Introduction" + leader + "1", fontsize=11)
    toc.insert_text((LEFT + 16, 170), "1.1", fontsize=11)
    toc.insert_text((LEFT + 38, 170), "Scope" + leader + "2", fontsize=11)
    toc.insert_text((LEFT, 190), "2. Findings" + leader + "3", fontsize=11)
    return pymupdf.open("pdf", doc.tobytes())


def solid_leader_pdf():
    """One page whose dot leader is set with no space between the dots."""
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((LEFT, 150), "A title" + "." * 40 + "7", fontsize=11)
    return pymupdf.open("pdf", doc.tobytes())


def check(condition, label, detail=""):
    line = "%-5s %s%s" % ("ok" if condition else "FAIL", label, (" -- " + str(detail)) if detail else "")
    # A Windows console is cp1252 and some of these labels carry Cyrillic or
    # CJK, which would end the run with an encoding error rather than a result.
    print(line.encode("ascii", "backslashreplace").decode("ascii"))
    return bool(condition)


def run_built_in():
    doc = build_pdf()
    passed = True

    left, right = convert.content_bounds(doc)
    passed &= check(abs(left - LEFT) < 2, "content left edge", left)
    passed &= check(abs(right - RIGHT) < 6, "content right edge", right)

    header, header_reason = convert.detect_band(doc, "top")
    footer, footer_reason = convert.detect_band(doc, "bottom")
    passed &= check(header_reason is None and footer_reason is None, "neither edge was declined",
                    (header_reason, footer_reason))
    passed &= check(header is not None, "a running header was found")
    passed &= check(footer is not None, "a running footer was found")
    if not header or not footer:
        return False

    passed &= check(header["pages"] == [1, 2, 3], "the cover carries no header", header["pages"])
    passed &= check(header["rule_under"], "the rule under the header joined the band")
    if header["rule_under"]:
        rule = header["rule_under"]
        passed &= check(abs(rule["x0"] - LEFT) < 2 and abs(rule["x1"] - RIGHT) < 2,
                        "the rule's own ends were measured", (rule["x0"], rule["x1"]))
        passed &= check(convert.border_eighths(rule["width"]) == str(int(round(rule["width"] * 8))),
                        "the rule's weight comes from the stroke", convert.border_eighths(rule["width"]))
        passed &= check(convert.border_eighths(0.0) == "6" and convert.border_eighths(40.0) == "96",
                        "a border weight stays inside what Word accepts")
        passed &= check(convert.band_paint_span(header, 0.0, RIGHT) == (rule["x0"], rule["x1"]),
                        "the header paragraph is indented to the rule")
    passed &= check(header["bottom"] >= 53.0, "the header band reaches the rule", header["bottom"])
    passed &= check(len(header["columns"]) == 2, "the header has a left and a right piece", len(header["columns"]))
    passed &= check(
        all(column["page_offset"] is None for column in header["columns"]),
        "no page number in the header",
    )

    passed &= check(footer["strip_behind"] is not None, "the filled strip joined the footer band")
    passed &= check(footer["top"] <= 771.0, "the footer band reaches the strip", footer["top"])
    numbered = [c for c in footer["columns"] if c["page_offset"] is not None]
    passed &= check(len(numbered) == 1, "exactly one footer piece is a page number", len(numbered))
    if numbered:
        passed &= check(numbered[0]["page_offset"] == 0, "the page-number offset", numbered[0]["page_offset"])
        passed &= check(
            [part["kind"] for part in numbered[0]["parts"]] == ["page"],
            "the page number is the whole piece",
            numbered[0]["parts"],
        )

    entries = convert.detect_toc(doc, [header, footer])
    passed &= check(len(entries) == 3, "three table-of-contents entries", len(entries))
    if len(entries) == 3:
        passed &= check([e["title"] for e in entries] == ["1. Introduction", "1.1 Scope", "2. Findings"],
                        "the titles", [e["title"] for e in entries])
        passed &= check([e["number"] for e in entries] == ["1", "2", "3"], "the page numbers")
        passed &= check(len(entries[1]["segments"]) == 2, "the numbered entry keeps its two columns")
        passed &= check(abs(entries[1]["x0"] - (LEFT + 16)) < 2, "the sub-entry is indented", entries[1]["x0"])
        pitch = convert.toc_line_pitch(entries)
        passed &= check(pitch is not None and abs(pitch - 20) < 2, "the line pitch", pitch)
        # The fixture writes " . " at 11 pt, so a dot advances about 3.1 pt
        # and the next one starts about two spaces later: what Word has to add
        # to its own leader is the pair of spaces between them.
        extras = [e.get("leader_extra", 0.0) for e in entries]
        passed &= check(all(5.0 < extra < 7.5 for extra in extras),
                        "the leader's extra spacing was measured", [round(e, 2) for e in extras])
        solid = convert.leader_spacing(pymupdf.open("pdf", solid_leader_pdf().tobytes())[0])
        passed &= check(solid and all(value < 0.2 for value in solid.values()),
                        "a solid leader asks for no extra spacing", solid)

    # Nothing outside a band may be taken for one.
    body_before = doc[2].get_text().count("Body text")
    convert.strip_bands(doc, [header, footer])
    after = doc[2].get_text()
    passed &= check("ACME Security Assessment" not in after, "the header text is gone")
    passed &= check("CONFIDENTIAL" not in after, "the footer text is gone")
    passed &= check(after.count("Body text") == body_before, "the body text survived")

    # The same pure helpers the rest of the script leans on.
    passed &= check(convert.normalize("Page  12 of 34") == "Page # of #", "digit runs normalize away")
    passed &= check(convert.font_family("ABCDEF+Poppins-Bold") == "Poppins", "font family")
    passed &= check(convert.font_family("ArialMT") == "Arial", "font family, no separator")
    passed &= check(convert.TOC_LINE.match("A title . . . . . . . 12") is not None, "a spaced dot leader")
    passed &= check(convert.TOC_LINE.match("Not a leader ... 12") is None, "an ellipsis is not a leader")
    passed &= check(convert.squash("Глава 1") == "глава1",
                    "squash keeps Cyrillic", convert.squash("Глава 1"))
    passed &= check(convert.squash("第一章") == "第一章", "squash keeps CJK")
    doc.close()
    passed &= run_comparison_checks()
    passed &= run_rhythm_checks()
    return passed


def rhythm_document(before, after, line, text="Second block here"):
    """A two-paragraph document whose spacing the vertical pass can rewrite."""
    document = Document()
    section = document.sections[0]
    section.top_margin = Pt(72)
    section.bottom_margin = Pt(72)
    first = document.add_paragraph()
    convert.set_spacing(first._p, before=0.0, after=0.0, line=12.0)
    first.add_run("First block here")
    second = document.add_paragraph()
    convert.set_spacing(second._p, before=before, after=after, line=line)
    second.add_run(text)
    return document


def exact_table(document, heights, widths, indent=0.0):
    """A table whose rows and cells are the sizes a PDF grid would give them."""
    table = document.add_table(rows=len(heights), cols=len(widths))
    properties = table._tbl.find(convert.qn("w:tblPr"))
    node = convert.OxmlElement("w:tblInd")
    node.set(convert.qn("w:w"), str(indent * 20.0))     # the float the converter writes
    node.set(convert.qn("w:type"), "dxa")
    properties.append(node)
    for span, row in zip(heights, table.rows):
        node = convert.OxmlElement("w:trHeight")
        node.set(convert.qn("w:val"), str(int(round(span * 20))))
        node.set(convert.qn("w:hRule"), "exact")
        row._tr.get_or_add_trPr().append(node)
        for width, cell in zip(widths, row.cells):
            node = convert.OxmlElement("w:tcW")
            node.set(convert.qn("w:w"), str(int(round(width * 20))))
            node.set(convert.qn("w:type"), "dxa")
            cell._tc.get_or_add_tcPr().insert(0, node)
    return table


def fill_cell(cell, text, before, line, after=0.0):
    paragraph = cell.paragraphs[0]
    convert.set_spacing(paragraph._p, before=before, after=after, line=line)
    paragraph.add_run(text)
    return paragraph


def pdf_line(text, base, x0, x1, ascent=9.0):
    return {"key": convert.compare_squash(text), "base": base, "x0": x0, "x1": x1,
            "y0": base - ascent, "y1": base + ascent / 4.0}


def cell_top_border(cell, width):
    borders = convert.OxmlElement("w:tcBorders")
    top = convert.OxmlElement("w:top")
    top.set(convert.qn("w:val"), "single")
    top.set(convert.qn("w:sz"), str(width * 8.0))
    borders.append(top)
    cell._tc.get_or_add_tcPr().append(borders)


def run_cell_checks():
    """Text inside a table, paired with the PDF by geometry rather than order."""
    passed = True

    # The rule the whole pass rests on, measured on Word's own render of the
    # reference report: a cell's content starts below its top border and its
    # top margin, and the first paragraph's spacing before is not dropped.
    document = Document()
    table = exact_table(document, [20.0], [100.0, 200.0])
    cell = table.rows[0].cells[0]
    passed &= check(convert.cell_content_top(cell._tc, 50.0) == 50.0,
                    "cells: a cell with no border and no margin starts at its row's top")
    cell_top_border(cell, 0.75)
    passed &= check(abs(convert.cell_content_top(cell._tc, 50.0) - 50.75) < 0.01,
                    "cells: a cell's top border insets its content",
                    convert.cell_content_top(cell._tc, 50.0))

    # The grid, which is the PDF's own: exact row heights and cell widths,
    # offset by the table's indent.
    grid = convert.table_grid(table._tbl, 100.0, 54.0)
    passed &= check(grid is not None and len(grid) == 1 and len(grid[0]["cells"]) == 2,
                    "cells: the grid is one rectangle per cell", grid and len(grid[0]["cells"]))
    passed &= check(abs(grid[0]["y1"] - 120.0) < 0.01 and abs(grid[0]["cells"][1]["x0"] - 154.0) < 0.01
                    and abs(grid[0]["cells"][1]["x1"] - 354.0) < 0.01,
                    "cells: rows and columns are measured from the table's corner",
                    grid and (grid[0]["y1"], grid[0]["cells"][1]["x0"]))
    indented = exact_table(Document(), [20.0], [100.0], indent=9.0)
    passed &= check(abs(convert.table_grid(indented._tbl, 0.0, 54.0)[0]["cells"][0]["x0"] - 63.0) < 0.01,
                    "cells: the table's indent moves the whole grid")
    loose = exact_table(Document(), [20.0], [100.0])
    loose.rows[0]._tr.find(convert.qn("w:trPr")).find(
        convert.qn("w:trHeight")).set(convert.qn("w:hRule"), "atLeast")
    passed &= check(convert.table_grid(loose._tbl, 0.0, 0.0) is None,
                    "cells: a row Word is free to size has no grid")

    # A list marker and the text beside it are two columns of one row and one
    # line of one cell.
    merged = convert.merged_lines([pdf_line("1.", 100.0, 60.0, 68.0),
                                   pdf_line("{{STEP}}", 100.0, 74.0, 140.0),
                                   pdf_line("and more", 113.0, 60.0, 150.0)])
    passed &= check(len(merged) == 2 and merged[0]["key"] == convert.compare_squash("1.{{STEP}}"),
                    "cells: two columns on one baseline read as one line", [m["key"] for m in merged])

    # End to end. Two cells of one row, each holding text the PDF put on its
    # own baseline, and the pair reads down one column and then the next in
    # the file while the PDF reads across.
    document = Document()
    table = exact_table(document, [34.5], [108.0, 396.0])
    left = fill_cell(table.rows[0].cells[0], "{{DATE}}", before=9.2, line=15.4)
    right = fill_cell(table.rows[0].cells[1], "The description runs to two lines here", before=2.4, line=14.8)
    right._p.find(convert.qn("w:r")).append(convert.OxmlElement("w:br"))
    right.add_run("second line of it")
    lines = [pdf_line("The description runs to two lines here", 263.4, 170.0, 500.0),
             pdf_line("{{DATE}}", 270.8, 60.0, 120.0),
             pdf_line("second line of it", 278.2, 170.0, 300.0)]
    moved, undo = convert.align_table_cells(table._tbl, 251.55, 54.0, lines)
    got_left = convert.paragraph_metrics(left._p)
    got_right = convert.paragraph_metrics(right._p)
    passed &= check(moved == 2 and len(undo) == 2, "cells: both cells of the row moved", (moved, len(undo)))
    passed &= check(abs(251.55 + got_left["before"] + 0.8 * got_left["line"] - 270.8) < 0.05,
                    "cells: the date column lands on the PDF's baseline",
                    got_left and 251.55 + got_left["before"] + 0.8 * got_left["line"])
    passed &= check(abs(251.55 + got_right["before"] + 0.8 * got_right["line"] - 263.4) < 0.05,
                    "cells: and so does the description beside it",
                    got_right and 251.55 + got_right["before"] + 0.8 * got_right["line"])
    passed &= check(abs(got_right["line"] - 14.8) < 0.05,
                    "cells: a cell of several lines is set at the PDF's own pitch", got_right["line"])
    height = table.rows[0]._tr.find(convert.qn("w:trPr")).find(convert.qn("w:trHeight"))
    passed &= check(height.get(convert.qn("w:val")) == "690",
                    "cells: and the row keeps its height, so no rule moves",
                    height.get(convert.qn("w:val")))
    convert.restore(undo)
    passed &= check(abs(convert.paragraph_metrics(left._p)["before"] - 9.2) < 0.05,
                    "cells: the undo puts the spacing back")

    # A line whose centre is in the next column belongs to that cell, whatever
    # the file's reading order says.
    document = Document()
    table = exact_table(document, [20.0], [108.0, 396.0])
    first = fill_cell(table.rows[0].cells[0], "Name", before=1.8, line=15.4)
    fill_cell(table.rows[0].cells[1], "{{NAME}}", before=1.8, line=15.4)
    moved, _ = convert.align_table_cells(
        table._tbl, 100.0, 54.0,
        [pdf_line("{{NAME}}", 112.0, 170.0, 260.0), pdf_line("Name", 112.0, 60.0, 90.0)])
    passed &= check(moved == 2 and abs(100.0 + convert.paragraph_metrics(first._p)["before"]
                                       + 0.8 * convert.paragraph_metrics(first._p)["line"] - 112.0) < 0.05,
                    "cells: a cell takes the line whose centre is inside it", moved)

    # The refusal: a correction that would push a cell's last line past the
    # bottom Word clips an exact row at gives the whole table back.
    document = Document()
    table = exact_table(document, [20.0, 20.0], [200.0])
    kept = fill_cell(table.rows[0].cells[0], "Row one", before=1.0, line=12.0)
    fill_cell(table.rows[1].cells[0], "Row two", before=1.0, line=12.0)
    moved, undo = convert.align_table_cells(
        table._tbl, 100.0, 54.0,
        [pdf_line("Row one", 120.0, 60.0, 120.0), pdf_line("Row two", 131.0, 60.0, 120.0)])
    passed &= check(moved == 0 and undo == []
                    and abs(convert.paragraph_metrics(kept._p)["before"] - 1.0) < 0.05,
                    "cells: a table whose text would be clipped is given back", (moved, undo))

    # A nested table inside a cell is placed inside that cell.
    document = Document()
    outer = exact_table(document, [40.0], [300.0])
    holder = outer.rows[0].cells[0]
    convert.set_spacing(holder.paragraphs[0]._p, before=0.0, after=0.0, line=1.0)
    inner = exact_table(document, [20.0], [150.0, 150.0], indent=6.0)
    holder._tc.append(inner._tbl)
    one = fill_cell(inner.rows[0].cells[0], "Techniques", before=1.9, line=11.7)
    two = fill_cell(inner.rows[0].cells[1], "Mitigations", before=1.9, line=11.7)
    moved, _ = convert.align_table_cells(
        outer._tbl, 100.0, 54.0,
        [pdf_line("Techniques", 113.0, 70.0, 130.0), pdf_line("Mitigations", 113.0, 230.0, 300.0)])
    passed &= check(moved == 2
                    and abs(101.0 + convert.paragraph_metrics(one._p)["before"]
                            + 0.8 * convert.paragraph_metrics(one._p)["line"] - 113.0) < 0.05
                    and abs(convert.paragraph_metrics(two._p)["before"]
                            - convert.paragraph_metrics(one._p)["before"]) < 0.05,
                    "cells: a nested table's own cells are placed too", moved)
    return passed


def anchor_row(text, base, y0, y1, x0=54.0, x1=300.0):
    """One page row in the shape `page_anchor_rows` hands the vertical pass."""
    return {"key": convert.compare_squash(text), "base": base, "y0": y0, "y1": y1,
            "x0": x0, "x1": x1, "text": text,
            "columns": [{"x0": x0, "x1": x1, "y0": y0, "y1": y1, "base": base, "text": text}]}


def run_rhythm_checks():
    """The vertical pass: its layout model, and what it refuses to do."""
    passed = True

    # The model itself, which is the whole of the correction.
    metrics = convert.paragraph_metrics(rhythm_document(6.0, 3.0, 15.0).paragraphs[1]._p)
    passed &= check(metrics is not None and abs(metrics["before"] - 6.0) < 0.05
                    and abs(metrics["after"] - 3.0) < 0.05 and abs(metrics["line"] - 15.0) < 0.05,
                    "rhythm: spacing is read back in points", metrics)
    inherited = Document().add_paragraph("no spacing of its own")
    passed &= check(convert.paragraph_metrics(inherited._p) is None,
                    "rhythm: a paragraph without an exact line height is not modelled")

    rows = [{"base": 100.0, "y0": 92.0, "y1": 103.0, "key": "a"},
            {"base": 116.0, "y0": 108.0, "y1": 119.0, "key": "b"}]
    line, floor = convert.wanted_line_height(rows, 19.6)
    passed &= check(abs(line - 16.0) < 0.01, "rhythm: the line height is the PDF's own pitch", line)
    passed &= check(abs(floor - 10.0) < 0.01, "rhythm: the floor holds the row's ascent", floor)
    single, single_floor = convert.wanted_line_height(rows[:1], 19.6)
    passed &= check(abs(single - 19.6) < 0.01, "rhythm: one row keeps the converter's height", single)
    passed &= check(single_floor <= single, "rhythm: the floor never raises a height", single_floor)
    passed &= check(abs(convert.first_baseline_target(rows, 16.0) - 100.0) < 0.01,
                    "rhythm: an even block is placed on its first line")
    staggered = [dict(rows[0]), dict(rows[1], base=120.0)]
    passed &= check(convert.first_baseline_target(staggered, 16.0) > 100.0,
                    "rhythm: an uneven block straddles its lines")

    # The correction, end to end on a document whose PDF says where to put it.
    pdf_rows = [[anchor_row("First block here", 100.0, 92.0, 103.0),
                 anchor_row("Second block here", 160.0, 152.0, 163.0)]]
    document = rhythm_document(0.0, 0.0, 15.0)
    moved = convert.align_vertical_rhythm(document, pdf_rows, 792.0)
    after = convert.paragraph_metrics(document.paragraphs[1]._p)
    # 72 top margin, a 12 pt first box, then the gap that puts the second
    # baseline at 160: 160 - 0.8 x 15 - 84.
    passed &= check(moved == 1, "rhythm: one block was moved", moved)
    passed &= check(after is not None and abs(after["before"] - 64.0) < 0.3,
                    "rhythm: the spacing is what the PDF's baseline asks for", after and after["before"])

    # A gap the PDF makes negative comes out of the block above first.
    tight = [[anchor_row("First block here", 100.0, 92.0, 103.0),
              anchor_row("Second block here", 92.0, 84.0, 95.0)]]
    document = rhythm_document(0.0, 20.0, 15.0)
    convert.align_vertical_rhythm(document, tight, 792.0)
    above = convert.paragraph_metrics(document.paragraphs[0]._p)
    below = convert.paragraph_metrics(document.paragraphs[1]._p)
    passed &= check(above is not None and above["after"] == 0.0,
                    "rhythm: the block above gives its spacing back first", above and above["after"])
    passed &= check(below is not None and below["before"] == 0.0 and below["line"] < 15.0,
                    "rhythm: a box too tall for its place is shortened", below and below["line"])

    # And a page that would end below its bottom margin keeps what it had.
    far = [[anchor_row("First block here", 100.0, 92.0, 103.0),
            anchor_row("Second block here", 900.0, 892.0, 903.0)]]
    document = rhythm_document(2.0, 0.0, 15.0)
    moved = convert.align_vertical_rhythm(document, far, 792.0)
    kept = convert.paragraph_metrics(document.paragraphs[1]._p)
    passed &= check(moved == 0 and kept is not None and abs(kept["before"] - 2.0) < 0.05,
                    "rhythm: a correction past the bottom margin is refused", kept and kept["before"])

    # A table stands as tall as its rows plus the border under the last one,
    # and the converter writes that width as "12.0", which is not an integer.
    document = Document()
    table = document.add_table(rows=2, cols=1)
    for order, row in enumerate(table.rows):
        properties = row._tr.get_or_add_trPr()
        node = convert.OxmlElement("w:trHeight")
        node.set(convert.qn("w:val"), "400")
        node.set(convert.qn("w:hRule"), "exact")
        properties.append(node)
        if order:
            borders = convert.OxmlElement("w:tcBorders")
            bottom = convert.OxmlElement("w:bottom")
            bottom.set(convert.qn("w:val"), "single")
            bottom.set(convert.qn("w:sz"), "12.0")
            borders.append(bottom)
            row.cells[0]._tc.get_or_add_tcPr().append(borders)
    metrics = convert.table_metrics(table._tbl)
    passed &= check(metrics is not None and abs(metrics["height"] - 41.5) < 0.05,
                    "rhythm: a table is its rows plus its last border", metrics and metrics["height"])
    for row in table.rows:
        row._tr.find(convert.qn("w:trPr")).find(convert.qn("w:trHeight")).set(convert.qn("w:hRule"), "atLeast")
    passed &= check(convert.table_metrics(table._tbl) is None,
                    "rhythm: a table Word is free to size is not modelled")

    passed &= run_cell_checks()

    # A word the typesetter broke keeps its hyphen where the line still ends.
    document = Document()
    first = document.add_paragraph()
    first.add_run("Therefore, the company also em")
    second = document.add_paragraph()
    second.add_run("ployed a custom system")
    broken = {(convert.compare_squash("Therefore, the company also em")[-convert.PAIR_WINDOW:],
               convert.compare_squash("ployed a custom system")[:convert.PAIR_WINDOW])}
    added = convert.restore_break_hyphens(document, broken)
    ends = list(first._p.iter(convert.qn("w:t")))[-1]
    passed &= check(added == 1 and ends.text.endswith("em-"),
                    "rhythm: the break hyphen came back", (added, ends.text[-6:]))
    convert.restore_break_hyphens(document, broken)
    passed &= check(ends.text.endswith("em-") and not ends.text.endswith("em--"),
                    "rhythm: and only once", ends.text[-6:])
    elsewhere = Document()
    one = elsewhere.add_paragraph()
    one.add_run("a line that was not broken")
    elsewhere.add_paragraph().add_run("and the next one")
    passed &= check(convert.restore_break_hyphens(elsewhere, broken) == 0,
                    "rhythm: a line end the PDF did not break gets nothing")

    # A code panel's accent bar stands off the text by the panel's padding.
    document = Document()
    paragraph = document.add_paragraph("nmap -sV")
    convert.left_border(paragraph, {"fill": (0.4, 0.4, 0.4), "width": 7.2, "space": 9.0})
    left = paragraph._p.find(convert.qn("w:pPr")).find(convert.qn("w:pBdr")).find(convert.qn("w:left"))
    passed &= check(left.get(convert.qn("w:sz")) == "48" and left.get(convert.qn("w:space")) == "9",
                    "rhythm: the accent bar's width and stand-off come from the PDF",
                    (left.get(convert.qn("w:sz")), left.get(convert.qn("w:space"))))
    convert.left_border(paragraph, {"fill": (0.4, 0.4, 0.4), "width": 7.2, "space": 90.0})
    left = paragraph._p.find(convert.qn("w:pPr")).find(convert.qn("w:pBdr")).find(convert.qn("w:left"))
    passed &= check(left.get(convert.qn("w:space")) == "31",
                    "rhythm: a stand-off stays inside what Word accepts", left.get(convert.qn("w:space")))

    # A tab is already a gap, so the space repair may not add one across it.
    document = Document()
    paragraph = document.add_paragraph()
    paragraph.add_run("2.1")
    paragraph.add_run("\t")
    paragraph.add_run("NON-DISCLOSURE STATEMENT")
    nodes = list(paragraph._p.iter(convert.qn("w:t")))
    passed &= check(convert.adjacent_text(paragraph._p) == [],
                    "rhythm: a tab between two runs is not a run boundary",
                    len(convert.adjacent_text(paragraph._p)))
    convert.repair_text(document, {(convert.compare_squash("2.1")[-8:],
                                    convert.compare_squash("NON-DISC")[:8])})
    passed &= check(nodes[1].text == "NON-DISCLOSURE STATEMENT",
                    "rhythm: the title after a tab keeps its place", nodes[1].text[:12])
    joined = document.add_paragraph()
    joined.add_run("1.")
    joined.add_run("{{STEP}}")
    pieces = list(joined._p.iter(convert.qn("w:t")))
    convert.repair_text(document, {(convert.compare_squash("1.")[-8:],
                                    convert.compare_squash("{{STEP}}")[:8])})
    passed &= check(pieces[1].text.startswith(" "),
                    "rhythm: a run boundary with no tab still gets its space", pieces[1].text)

    # A page count the converter did not write one section per is left alone.
    document = rhythm_document(2.0, 0.0, 15.0)
    passed &= check(convert.align_vertical_rhythm(document, pdf_rows + pdf_rows, 792.0) == 0,
                    "rhythm: sections and pages have to line up")
    return passed


def run_comparison_checks():
    """The text check, on text rather than on documents.

    These are the shapes it has to be blind to (a re-flow) and the one shape
    it has to see (a line that is gone).
    """
    passed = True
    line = lambda text: {"text": text, "pieces": [text]}  # noqa: E731

    joined = "The quick brown fox\njumped over the lazy dog"
    passed &= check(
        convert.missing_from_docx([line("The quick brown"), line("fox jumped over")], joined) == [],
        "a line joined to its neighbour is not missing",
    )
    passed &= check(
        convert.missing_from_docx([line("em-"), line("ployed a custom system")], "employed a custom system") == [],
        "a word broken across two lines is not missing",
    )
    passed &= check(
        convert.missing_from_docx([line("Title . . . . . . . . 12")], "Title\t12") == [],
        "a dot leader drawn from a tab stop is not missing",
    )
    passed &= check(
        convert.missing_from_docx([line("1. {{RECOMMENDATION}}")], "1.{{RECOMMENDATION}}") == [],
        "a space the converter did not write is not missing",
    )
    gone = convert.missing_from_docx(
        [line("Host-111 is vulnerable"), line("Host-112 is vulnerable")],
        "Host-112 is vulnerable",
    )
    passed &= check([g for g in gone] == ["Host-111 is vulnerable"], "a dropped paragraph is caught", gone)
    passed &= check(
        convert.missing_from_docx([{"text": "TECHNIQUES MITIGATIONS", "pieces": ["TECHNIQUES", "MITIGATIONS"]}],
                                  "TECHNIQUES\n{{T}}\nMITIGATIONS\n{{M}}") == [],
        "two columns written one after the other are not missing",
    )
    passed &= check(
        convert.missing_from_docx([{"text": "LOW", "pieces": ["LOW"]}], "nothing here") == [],
        "a piece too short to be evidence is not reported",
    )
    # Presence is not enough: three identical rows against one is two rows
    # lost, and a substring test calls that a pass.
    thrice = [line("Host-200 is vulnerable")] * 3
    passed &= check(convert.missing_from_docx(thrice, "Host-200 is vulnerable") != [],
                    "three identical lines against one copy are reported")
    passed &= check(
        convert.missing_from_docx(thrice, "Host-200 is vulnerable " * 3) == [],
        "three identical lines against three copies are not",
    )
    # A soft hyphen is where typst broke the word, so the PDF's two lines have
    # to match the one word the Word file writes.
    passed &= check(
        convert.missing_from_docx([line("em­"), line("ploying a custom system")],
                                  "employing a custom system") == [],
        "a word broken at a soft hyphen is not missing",
    )
    passed &= check(convert.compare_squash("em­ploying") == "employing",
                    "a soft hyphen counts as nothing", convert.compare_squash("em­ploying"))
    return passed


# ── the document cases ────────────────────────────────────────────────────
# These compile a Typst source and run the whole of convert() on it, which
# needs the typst CLI on PATH. They are the ones that pin behaviour rather
# than a function: every one of them is a document that lost content.


def compile_case(source, pdf_path):
    with open(pdf_path + ".typ", "w", encoding="utf-8") as handle:
        handle.write(source)
    fonts = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "dist", "fonts")
    args = ["typst", "compile", "--ignore-system-fonts"]
    if os.path.isdir(fonts):
        args += ["--font-path", fonts]
    args += [pdf_path + ".typ", pdf_path]
    subprocess.run(args, check=True, capture_output=True)


def run_case(source, workdir, name):
    """Compile, convert, and hand back what `result.json` says."""
    pdf_path = os.path.join(workdir, name + ".pdf")
    docx_path = os.path.join(workdir, name + ".docx")
    compile_case(source, pdf_path)
    result = convert.convert(pdf_path, docx_path)
    return result, docx_path


def squashed_docx(path, body_only):
    return convert.compare_squash(convert.docx_text(path, body_only=body_only))


def face_entry(path, family, **extra):
    """A staged face as `fonts` describes one, for the refusal checks."""
    entry = {"path": path, "family": family, "subfamily": "Regular", "postscript": "",
             "full": "", "typoFamily": "", "typoSubfamily": "", "bold": False,
             "italic": False, "fsType": 0, "damaged": False, "postscriptOutlines": False,
             "licenceText": "This Font Software is licensed under the SIL Open Font License"}
    entry.update(extra)
    return entry


def one_family_plan(family, entry):
    """A plan holding one family of one face, which is all a refusal needs."""
    return {"faces": {family: entry}, "missing": [], "families": {family: {(False, False): entry}},
            "byFamily": {family.lower(): family}, "byFace": {}}


def run_font_conversion_checks(font_tools, font_dir, workdir):
    """A PostScript-outline face is redrawn, and only where it may be.

    The redrawn face is what a reader will be shown, so the checks are on the
    bytes that go in the file rather than on the decision to make them: it
    has to parse, it has to have quadratic outlines and no PostScript ones,
    and every advance width has to be the number it was, because the line
    endings in this Word file are the PDF's and a width that moved is a line
    that wraps twice.
    """
    import io

    from fontTools.ttLib import TTFont

    passed = True
    source = next((os.path.join(font_dir, n) for n in sorted(os.listdir(font_dir))
                   if n.lower().endswith(".otf")), None)
    if source is None:
        print("SKIP  no OpenType font was staged, so the conversion is untested")
        return passed
    entry = font_tools.read_font(source)
    passed &= check(entry["postscriptOutlines"], "fonts: the staged .otf reads as PostScript outlines")
    passed &= check(font_tools.licence_of(entry) is not None,
                    "fonts: and its licence is one this recognises", font_tools.licence_of(entry))

    data = font_tools.to_truetype(source)
    passed &= check(data is not None, "fonts: it converts")
    if data is None:
        return passed
    before, after = TTFont(source, fontNumber=0), TTFont(io.BytesIO(data), fontNumber=0)
    try:
        passed &= check("glyf" in after and "CFF " not in after,
                        "fonts: the converted face has quadratic outlines and no PostScript ones")
        passed &= check(after.sfntVersion == "\000\001\000\000",
                        "fonts: and says so in its header", repr(after.sfntVersion))
        moved = [g for g in before.getGlyphOrder() if before["hmtx"][g][0] != after["hmtx"][g][0]]
        passed &= check(not moved, "fonts: every advance width is the number it was",
                        (len(moved), len(before.getGlyphOrder())))
        vertical = [(t, f) for t, f in (("hhea", "ascent"), ("hhea", "descent"), ("hhea", "lineGap"),
                                        ("OS/2", "sTypoAscender"), ("OS/2", "sTypoDescender"),
                                        ("OS/2", "usWinAscent"), ("OS/2", "usWinDescent"),
                                        ("head", "unitsPerEm"))
                    if getattr(before[t], f) != getattr(after[t], f)]
        passed &= check(not vertical, "fonts: and so is every vertical metric", vertical)
        passed &= check(all(t in after for t in ("GPOS", "GSUB", "kern") if t in before),
                        "fonts: the kerning and shaping tables came across")
        passed &= check(all(before["name"].getDebugName(i) == after["name"].getDebugName(i)
                            for i in (1, 2, 6)),
                        "fonts: and it still calls itself what it did",
                        (after["name"].getDebugName(1), after["name"].getDebugName(2)))
    finally:
        before.close()
        after.close()

    # It goes in the file, in the slot its own subfamily names.
    target = os.path.join(workdir, "converted.docx")
    blank = Document()
    blank.add_paragraph("x")
    blank.save(target)
    family = entry["family"]
    embedded, refused, redrawn = font_tools.embed(target, one_family_plan(family, entry))
    passed &= check(embedded == [family] and redrawn == [family],
                    "fonts: a PostScript-outline face is carried, redrawn", (embedded, redrawn))
    with zipfile.ZipFile(target) as archive:
        table = archive.read("word/fontTable.xml").decode("utf-8")
    slot = font_tools.STYLE_ELEMENTS[(entry["bold"], entry["italic"])]
    passed &= check(('<w:font w:name="%s">' % family) in table and ("<" + slot) in table,
                    "fonts: under its own name and in its own slot", slot)

    # And only where it may be: the option off, an unreadable licence, and a
    # margin too thin to redraw anything in.
    embedded, refused, redrawn = font_tools.embed(target, one_family_plan(family, entry),
                                                  convert_outlines=False)
    passed &= check(embedded == [] and "turned off" in refused[0][1],
                    "fonts: with conversion off it is refused", refused)
    unreadable = dict(entry, licenceText="All rights reserved, Example Type Foundry")
    embedded, refused, redrawn = font_tools.embed(target, one_family_plan(family, unreadable))
    passed &= check(embedded == [] and "does not clearly allow" in refused[0][1],
                    "fonts: a licence this cannot read is refused", refused)
    embedded, refused, redrawn = font_tools.embed(target, one_family_plan(family, entry),
                                                 convert_seconds=0.0)
    passed &= check(embedded == [] and "not enough time" in refused[0][1],
                    "fonts: and so is a margin too thin to redraw it in", refused)
    return passed


RUN_FONTS = W + "rFonts"
RUN_STYLE = {W + "b": "bold", W + "i": "italic"}


def run_flag(properties, tag):
    node = properties.find(tag)
    if node is None:
        return False
    return (node.get(W + "val") or "true").lower() not in ("0", "false", "off")


def run_font_naming_checks(font_tools, docx_path, font_dir, result):
    """Every run names a family Word can resolve, and the table agrees.

    This is what the whole change is for, so it is asserted on the file
    rather than on the functions: the name in a run has to be a family name
    out of some staged font file's own name table, the bold and italic bits
    have to be the ones that file states in name ID 2, and there has to be
    one `w:font` for each of those families carrying the faces it declares.
    """
    passed = True
    staged = font_tools.collect([font_dir])
    by_family = {}
    for entry in staged:
        by_family.setdefault(entry["family"], {})[(entry["bold"], entry["italic"])] = entry
    with zipfile.ZipFile(docx_path) as archive:
        parts = [n for n in archive.namelist()
                 if re.match(r"word/(document|header\d*|footer\d*)\.xml$", n)]
        table = ElementTree.fromstring(archive.read("word/fontTable.xml"))
        runs = []
        for part in sorted(parts):
            for paragraph in ElementTree.fromstring(archive.read(part)).iter(W + "p"):
                for run in paragraph.iter(W + "r"):
                    drawn = [child.tag for child in run if child.tag in VISIBLE_RUN_CHILDREN]
                    if drawn:
                        runs.append((part, run))

    bare = [part for part, run in runs
            if (run.find(W + "rPr") is None
                or run.find(W + "rPr").find(RUN_FONTS) is None
                or not run.find(W + "rPr").find(RUN_FONTS).get(W + "ascii"))]
    passed &= check(not bare, "fonts: every run that draws something names a font", bare[:3])

    wrong = []
    for _, run in runs:
        properties = run.find(W + "rPr")
        fonts_node = properties.find(RUN_FONTS) if properties is not None else None
        if fonts_node is None:
            continue
        name = fonts_node.get(W + "ascii")
        slots = by_family.get(name)
        if slots is None:
            wrong.append((name, "no staged file calls itself that"))
            continue
        want = (run_flag(properties, W + "b"), run_flag(properties, W + "i"))
        if want not in slots:
            wrong.append((name, "no face of it is %s" % (want,)))
        for attribute in (W + "hAnsi", W + "cs"):
            if fonts_node.get(attribute) != name:
                wrong.append((name, "%s disagrees" % attribute.split("}")[1]))
    passed &= check(not wrong, "fonts: every run names a family out of a font file, with its own flags",
                    wrong[:3])

    declared = {}
    for node in table.iter(W + "font"):
        slots = [child.tag.split("}")[1] for child in node if child.tag.startswith(W + "embed")]
        if slots:
            declared[node.get(W + "name")] = sorted(slots)
    named = sorted({fonts_node.get(W + "ascii") for _, run in runs
                    for properties in [run.find(W + "rPr")] if properties is not None
                    for fonts_node in [properties.find(RUN_FONTS)] if fonts_node is not None})
    passed &= check(sorted(declared) == sorted(result["fontsEmbedded"]),
                    "fonts: one w:font per carried family", (sorted(declared), result["fontsEmbedded"]))
    for family, slots in declared.items():
        want = sorted(font_tools.STYLE_ELEMENTS[style].split(":")[1]
                      for style in by_family.get(family, {})
                      if font_tools.carriable(by_family[family][style]))
        passed &= check(slots == want, "fonts: %s carries the faces its files declare" % family,
                        (slots, want))
    passed &= check(all(name in declared or name not in by_family for name in named),
                    "fonts: no run names a carried family the table left out", named)
    return passed


def run_documents():
    import cases

    if shutil.which("typst") is None:
        print("SKIP  the document cases need the typst CLI on PATH")
        return True
    passed = True
    workdir = tempfile.mkdtemp(prefix="btct-convert-test-")
    try:
        # 1. A long table whose rows differ only by numbers.
        result, path = run_case(cases.TABLE, workdir, "table")
        passed &= check(result["textCheck"]["missing"] == 0, "table: no line of the report was lost",
                        result["textCheck"])
        passed &= check(not result["headerFooter"]["header"] and not result["headerFooter"]["footer"],
                        "table: no table row was mistaken for a band", result["headerFooter"])
        body = squashed_docx(path, body_only=False)
        passed &= check(body.count("host111") == 1 and body.count("host073") == 1,
                        "table: Host-111 and Host-073 each appear once",
                        (body.count("host111"), body.count("host073")))

        # 2. A repeated first body line under a real running header.
        result, path = run_case(cases.FIRST_BODY_LINE, workdir, "firstline")
        passed &= check(result["textCheck"]["missing"] == 0, "first line: nothing was lost", result["textCheck"])
        passed &= check(result["headerFooter"]["header"] and result["headerFooter"]["footer"],
                        "first line: the real header and footer were lifted", result["headerFooter"])
        opener = convert.compare_squash("Lorem ipsum dolor sit amet, consectetur adipiscing elit")
        passed &= check(opener in squashed_docx(path, body_only=True),
                        "first line: the body line is still in the body")
        with zipfile.ZipFile(path) as archive:
            bands = "".join(
                archive.read(n).decode("utf-8", "replace")
                for n in archive.namelist()
                if n.startswith("word/header") or n.startswith("word/footer")
            )
        passed &= check("Lorem ipsum dolor" not in bands, "first line: it was not pasted into a header")
        passed &= check("Acme Security Assessment" in bands, "first line: the real header was")

        # 3. Odd and even headers.
        result, _ = run_case(cases.ODD_EVEN, workdir, "oddeven")
        passed &= check(result["textCheck"]["missing"] == 0, "odd/even: nothing was lost", result["textCheck"])
        passed &= check(not result["headerFooter"]["header"], "odd/even: the header was declined")
        passed &= check(any("alternates" in w for w in result["warnings"]),
                        "odd/even: the warning says why", result["warnings"])

        # 4. The shape the repairs exist for: both must run, and say nothing.
        result, _ = run_case(cases.REPORT, workdir, "report")
        passed &= check(result["textCheck"]["missing"] == 0, "report: nothing was lost", result["textCheck"])
        passed &= check(not result["textCheck"]["fellBack"], "report: no fallback was needed")
        passed &= check(result["headerFooter"]["header"] and result["headerFooter"]["footer"],
                        "report: header and footer were lifted", result["headerFooter"])
        # The rebuild only engages when the converter keeps the entries as
        # separate paragraphs. On a page this sparse it merges the whole list
        # into one, and then the repair declines and says so, which is the
        # right answer: the list is ugly and complete. The reference report is
        # dense enough that its 27 entries are rebuilt.
        expected = ("rebuilt", "could not be found in the converted file")
        noise = [w for w in result["warnings"] if not any(e in w for e in expected)]
        passed &= check(noise == [], "report: no warning beyond the table of contents", noise)

        # 5. A table of contents in three scripts.
        result, path = run_case(cases.MIXED_SCRIPT_TOC, workdir, "scripts")
        passed &= check(result["textCheck"]["missing"] == 0, "scripts: nothing was lost", result["textCheck"])
        passed &= check(not result["textCheck"]["fellBack"], "scripts: no fallback was needed")
        body = squashed_docx(path, body_only=False)
        for title in ("Глава первая",
                      "Κεφάλαιο δύο"):
            passed &= check(convert.compare_squash(title) in body, "scripts: %r survived" % title)

        # 6. Links.
        result, path = run_case(cases.LINKS, workdir, "links")
        targets = []
        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                if name.endswith(".rels"):
                    for rel in ElementTree.fromstring(archive.read(name)):
                        if rel.get("TargetMode") == "External":
                            targets.append(rel.get("Target"))
        passed &= check(sorted(targets) == ["https://example.com/ok", "mailto:team@example.com"],
                        "links: only http(s) and mailto survive", targets)
        passed &= check(any("unsupported addresses" in w for w in result["warnings"]),
                        "links: the removal is reported", result["warnings"])
        passed &= check(convert.unsafe_docx_targets(path) == [], "links: the output check agrees")

        # 7. A repeating rule under the header with a distinct title above it.
        #    The rectangle that gets erased is the whole page width, so growing
        #    it to reach the rule used to delete every title on every page,
        #    with the text check blind to it.
        result, path = run_case(cases.RULE_OVER_TITLES, workdir, "rule")
        passed &= check(result["textCheck"]["missing"] == 0, "rule: nothing was lost", result["textCheck"])
        body = squashed_docx(path, body_only=False)
        kept = [i + 1 for i in range(8) if convert.compare_squash("unique title %d" % (i + 1)) in body]
        passed &= check(kept == list(range(1, 9)), "rule: every finding title survived", kept)
        passed &= check(result["headerFooter"]["header"], "rule: the header was still lifted")

        # 8. A document whose every page is nothing but the candidate.
        result, _ = run_case(cases.NOTHING_BUT_A_BAND, workdir, "bandonly")
        passed &= check(result["textCheck"]["missing"] == 0, "band only: nothing was lost", result["textCheck"])
        passed &= check(result["textCheck"]["pdfLines"] > 0, "band only: there was something to check",
                        result["textCheck"])
        passed &= check(not result["headerFooter"]["header"], "band only: the header was declined")
        passed &= check(any("told apart from the body" in w for w in result["warnings"]),
                        "band only: the warning says why", result["warnings"])

        # 9. Soft hyphens are the typesetter's line breaks and have to go;
        #    a real hyphen at a line end is part of the word and must stay.
        result, path = run_case(cases.HYPHENS, workdir, "hyphens")
        passed &= check(result["textCheck"]["missing"] == 0, "hyphens: nothing was lost", result["textCheck"])
        text = convert.docx_text(path, body_only=False)
        passed &= check("­" not in text, "hyphens: no soft hyphen reached the Word file",
                        text.count("­"))
        passed &= check("non-critical" in text, "hyphens: a real hyphen survived")
        passed &= check("employed" in text or "employ" in text, "hyphens: the broken word was joined")

        # 10. The marker repair must not reach into code. A space inserted
        #     into a command is invisible to the text check, which squashes
        #     whitespace, so this is the only thing that catches it.
        result, path = run_case(cases.CODE_AND_MARKERS, workdir, "code")
        passed &= check(result["textCheck"]["missing"] == 0, "code: nothing was lost", result["textCheck"])
        text = convert.docx_text(path, body_only=False)
        passed &= check("./deploy 1.{{X}}" in text, "code: the command kept its marker unspaced")
        passed &= check("check version1.2.3" in text, "code: the command kept its version unspaced")
        passed &= check("1. {{X}} must be rebuilt" in text, "prose: the list marker got its space back")
        passed &= check("2. version1.2.3 is the baseline" in text,
                        "prose: a version number inside a word was left alone")

        # 11. Line breaks. The default reproduces the PDF's own line endings
        #     with manual breaks; `word` lets Word re-flow. Neither may put a
        #     break inside code or inside a table cell.
        pdf_path = os.path.join(workdir, "breaks.pdf")
        compile_case(cases.HYPHENS, pdf_path)
        forced = os.path.join(workdir, "breaks-pdf.docx")
        flowed = os.path.join(workdir, "breaks-word.docx")
        result = convert.convert(pdf_path, forced)
        passed &= check(result["lineBreaks"] == "pdf", "breaks: pdf is the default", result["lineBreaks"])
        passed &= check(result["textCheck"]["missing"] == 0, "breaks: nothing was lost", result["textCheck"])
        other = convert.convert(pdf_path, flowed, line_breaks="word")
        passed &= check(other["lineBreaks"] == "word", "breaks: word mode is available")
        with zipfile.ZipFile(forced) as archive:
            forced_xml = archive.read("word/document.xml").decode("utf-8")
        with zipfile.ZipFile(flowed) as archive:
            flowed_xml = archive.read("word/document.xml").decode("utf-8")
        passed &= check(forced_xml.count("<w:br/>") > flowed_xml.count("<w:br/>"),
                        "breaks: pdf mode adds manual breaks",
                        (forced_xml.count("<w:br/>"), flowed_xml.count("<w:br/>")))

        result, path = run_case(cases.CODE_AND_MARKERS, workdir, "codebreaks")
        with zipfile.ZipFile(path) as archive:
            body = archive.read("word/document.xml").decode("utf-8")
        panel = body[body.find("deploy") - 900 : body.find("deploy") + 400] if "deploy" in body else ""
        passed &= check("<w:br/>" not in panel, "breaks: none inside a code panel")

        # 12. Fonts. The parts have to be there, obfuscated with the key the
        #     table names, and de-obfuscate to the file they came from.
        import fonts as font_tools

        font_dir = os.path.join(workdir, "fonts")
        os.makedirs(font_dir, exist_ok=True)
        source = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "dist", "fonts")
        if os.path.isdir(source):
            for name in sorted(os.listdir(source)):
                if name.lower().endswith((".ttf", ".otf")):
                    shutil.copyfile(os.path.join(source, name), os.path.join(font_dir, name))
        pdf_path = os.path.join(workdir, "fontcase.pdf")
        docx_path = os.path.join(workdir, "fontcase.docx")
        # Set in a family the Word file can actually carry, whichever one of
        # the staged files that turns out to be. typst's own default is an
        # OpenType face with PostScript outlines, which Word declines, and a
        # test that read the default would be testing the refusal twice.
        staged = font_tools.collect([font_dir])
        carried = next((e for e in staged if font_tools.carriable(e)), None)
        prelude = '#set text(font: "%s")\n' % carried["family"] if carried else ""
        compile_case(prelude + cases.HYPHENS, pdf_path)
        result = convert.convert(pdf_path, docx_path, font_dirs=[font_dir])
        if not result["fontsEmbedded"]:
            print("SKIP  no font file matched the families this PDF names")
        else:
            with zipfile.ZipFile(docx_path) as archive:
                names = archive.namelist()
                parts = [n for n in names if n.startswith("word/fonts/")]
                table = archive.read("word/fontTable.xml").decode("utf-8")
                rels = archive.read("word/_rels/fontTable.xml.rels").decode("utf-8")
                settings = archive.read("word/settings.xml").decode("utf-8")
                types = archive.read("[Content_Types].xml").decode("utf-8")
                passed &= check(bool(parts), "fonts: a font part was written", parts)
                passed &= check("<w:embedTrueTypeFonts/>" in settings, "fonts: settings say they are embedded")
                passed &= check("odttf" in types, "fonts: the content type is declared")
                keys = re.findall(r'<w:embed\w+ r:id="(\w+)" w:fontKey="([^"]+)"', table)
                passed &= check(bool(keys), "fonts: the table names a key per face", len(keys))
                same = 0
                for rid, key in keys:
                    target = re.search(r'Id="%s"[^>]*Target="([^"]+)"' % rid, rels)
                    if not target:
                        continue
                    raw = font_tools.obfuscate(archive.read("word/" + target.group(1)), key)
                    if raw[:4] in (bytes([0, 1, 0, 0]), b"OTTO", b"true"):
                        for name in os.listdir(font_dir):
                            with open(os.path.join(font_dir, name), "rb") as handle:
                                if handle.read() == raw:
                                    same += 1
                                    break
                passed &= check(same == len(keys), "fonts: every part is its source font, obfuscated",
                                (same, len(keys)))
            passed &= check(result["textCheck"]["missing"] == 0, "fonts: nothing was lost")
            passed &= run_font_naming_checks(font_tools, docx_path, font_dir, result)

        # A font the foundry forbids must be skipped rather than embedded.
        passed &= check(not font_tools.embeddable({"fsType": 0x0002}), "fonts: a restricted font is refused")
        passed &= check(not font_tools.embeddable({"fsType": 0x0200}), "fonts: a bitmap-only font is refused")
        passed &= check(font_tools.embeddable({"fsType": 0}), "fonts: an installable font is allowed")
        passed &= check(font_tools.embeddable({"fsType": 8}), "fonts: an editable font is allowed")
        # Preview-and-print is refused for Word's reason, not the foundry's:
        # a document carrying one opens read-only and cannot be exported.
        passed &= check(not font_tools.embeddable({"fsType": 0x0004}),
                        "fonts: a preview-and-print font is refused")
        passed &= check("read-only" in font_tools.refusal([face_entry(__file__, "Locked", fsType=0x0004)]),
                        "fonts: and the reason says why")

        # Name ID 2 decides which of Word's four slots a face fills, and both
        # of the ways of misreading it lose a face.
        for subfamily, want in (("Regular", (False, False)), ("Bold", (True, False)),
                                ("Italic", (False, True)), ("Bold Italic", (True, True)),
                                ("BoldItalic", (True, True)), ("BoldOblique", (True, True)),
                                ("Book", (False, False)), ("Oblique", (False, True)),
                                ("SemiBold", (False, False)), ("SemiBoldItalic", (False, True))):
            passed &= check(font_tools.style_of(subfamily) == want,
                            "fonts: %r is %s" % (subfamily, want), font_tools.style_of(subfamily))

        # A font file cut short parses lazily and would be embedded whole.
        whole = [name for name in sorted(os.listdir(font_dir)) if name.lower().endswith((".ttf", ".otf"))]
        if whole:
            with open(os.path.join(font_dir, whole[0]), "rb") as handle:
                raw = handle.read()
            hurt_dir = os.path.join(workdir, "hurtfonts")
            os.makedirs(hurt_dir, exist_ok=True)
            hurt = os.path.join(hurt_dir, whole[0])
            with open(hurt, "wb") as handle:
                handle.write(raw[: len(raw) // 3])
            entry = font_tools.read_font(hurt)
            passed &= check(entry is None or entry.get("damaged"),
                            "fonts: a truncated font is read as damaged", entry and entry["family"])
            passed &= check(font_tools.read_font(os.path.join(font_dir, whole[0])).get("damaged") is False,
                            "fonts: a whole font is not")
            hurt_entry = dict(face_entry(hurt, "Hurt"), damaged=True)
            _, refused, _ = font_tools.embed(None, one_family_plan("Hurt", hurt_entry))
            passed &= check([why for _, why in refused] == ["the font file is damaged"],
                            "fonts: and it says the file is damaged", refused)

        passed &= run_font_conversion_checks(font_tools, font_dir, workdir)

        # And there is a bound on the bytes a Word file may carry.
        huge = face_entry(os.path.join(font_dir, whole[0]) if whole else __file__, "Huge")
        keep = font_tools.MAX_FONT_BYTES
        font_tools.MAX_FONT_BYTES = 1
        try:
            embedded, refused, _ = font_tools.embed(None, one_family_plan("Huge", huge))
        finally:
            font_tools.MAX_FONT_BYTES = keep
        passed &= check(embedded == [] and refused and "may take" in refused[0][1],
                        "fonts: a face over the byte cap is refused", refused)

        # 12b. A budget too small for the fidelity passes skips them, says so,
        #      and still checks that the Word file kept the PDF's text.
        pdf_path = os.path.join(workdir, "budget.pdf")
        compile_case(cases.REPORT, pdf_path)
        tight = convert.convert(pdf_path, os.path.join(workdir, "budget.docx"), budget_seconds=0.001)
        passed &= check(convert.CROWDED_OUT in tight["warnings"],
                        "budget: a thin margin skips the layout passes", tight["warnings"][:1])
        passed &= check(tight["textCheck"]["missing"] == 0,
                        "budget: the text check still runs", tight["textCheck"])
        roomy = convert.convert(pdf_path, os.path.join(workdir, "roomy.docx"), budget_seconds=600)
        passed &= check(convert.CROWDED_OUT not in roomy["warnings"],
                        "budget: a real margin keeps them", roomy["warnings"])
        passed &= check(roomy["pages"] == tight["pages"],
                        "budget: skipping them does not move the page count",
                        (roomy["pages"], tight["pages"]))
        passed &= check(convert.affordable(time.monotonic(), None, 999.0),
                        "budget: no budget means no limit")

        # 13. Too many shapes for the converter.
        pdf_path = os.path.join(workdir, "shapes.pdf")
        compile_case(cases.SHAPES, pdf_path)
        started = time.perf_counter()
        try:
            convert.convert(pdf_path, os.path.join(workdir, "shapes.docx"))
            passed &= check(False, "shapes: the document was refused")
        except convert.ConvertError as err:
            spent = time.perf_counter() - started
            passed &= check("too complex" in str(err), "shapes: the document was refused", err)
            passed &= check(spent < 1.0, "shapes: refused in under a second", "%.3f s" % spent)

        # 14. A paragraph the converter dropped, simulated by taking one out of
        #    the PDF's side of the comparison's counterpart.
        result, path = run_case(cases.REPORT, workdir, "report2")
        text = convert.docx_text(path, body_only=True)
        cut = text.replace("Scope of the engagement", "", 1)
        doc = pymupdf.open(os.path.join(workdir, "report2.pdf"))
        lines = convert.body_lines(doc, [])
        doc.close()
        passed &= check(convert.missing_from_docx(lines, cut) != [],
                        "a heading removed from the Word file is caught")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    return passed


def describe(path):
    doc = pymupdf.open(path)
    print("pages: %d" % doc.page_count)
    print("content bounds: %.1f .. %.1f" % convert.content_bounds(doc))
    bands = []
    for edge in ("top", "bottom"):
        band, reason = convert.detect_band(doc, edge)
        if band is None:
            print("%s: no repeating band%s" % (edge, (" (declined: %s)" % reason) if reason else ""))
            continue
        bands.append(band)
        print(
            "%s: y %.1f..%.1f on %d page(s), rule=%s strip=%s"
            % (edge, band["top"], band["bottom"], len(band["pages"]), band["rule_under"], band["strip_behind"])
        )
        for column in band["columns"]:
            print(
                "   x %.1f..%.1f %s %.1fpt offset=%s %s"
                % (
                    column["x0"],
                    column["x1"],
                    column["font"],
                    column["size"],
                    column["page_offset"],
                    [p.get("text", "<PAGE>") for p in column["parts"]],
                )
            )
    entries = convert.detect_toc(doc, bands)
    print("table-of-contents entries: %d" % len(entries))
    for entry in entries[:40]:
        print("   p%-3d x%.1f  %-52s %s" % (entry["page_index"], entry["x0"], entry["title"][:52], entry["number"]))
    doc.close()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        describe(sys.argv[1])
        sys.exit(0)
    ok = run_built_in()
    ok = run_documents() and ok
    sys.exit(0 if ok else 1)
