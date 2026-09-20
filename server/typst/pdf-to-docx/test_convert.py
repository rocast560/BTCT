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
import sys

import pymupdf

# Isolated mode drops the script's own directory from the import path, and
# this file is run with it so it sees what the server's child process sees.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import convert  # noqa: E402

PAGE_WIDTH, PAGE_HEIGHT = 612.0, 792.0
LEFT, RIGHT = 54.0, 558.0


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


def check(condition, label, detail=""):
    print("%-5s %s%s" % ("ok" if condition else "FAIL", label, (" -- " + str(detail)) if detail else ""))
    return bool(condition)


def run_built_in():
    doc = build_pdf()
    passed = True

    left, right = convert.content_bounds(doc)
    passed &= check(abs(left - LEFT) < 2, "content left edge", left)
    passed &= check(abs(right - RIGHT) < 6, "content right edge", right)

    header = convert.detect_band(doc, "top")
    footer = convert.detect_band(doc, "bottom")
    passed &= check(header is not None, "a running header was found")
    passed &= check(footer is not None, "a running footer was found")
    if not header or not footer:
        return False

    passed &= check(header["pages"] == [1, 2, 3], "the cover carries no header", header["pages"])
    passed &= check(header["rule_under"], "the rule under the header joined the band")
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
    doc.close()
    return passed


def describe(path):
    doc = pymupdf.open(path)
    print("pages: %d" % doc.page_count)
    print("content bounds: %.1f .. %.1f" % convert.content_bounds(doc))
    bands = []
    for edge in ("top", "bottom"):
        band = convert.detect_band(doc, edge)
        if band is None:
            print("%s: no repeating band" % edge)
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
    sys.exit(0 if run_built_in() else 1)
