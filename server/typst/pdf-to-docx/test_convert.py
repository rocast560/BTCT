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
    pdf_rows = [
        [{"base": 100.0, "y0": 92.0, "y1": 103.0, "key": convert.compare_squash("First block here")},
         {"base": 160.0, "y0": 152.0, "y1": 163.0, "key": convert.compare_squash("Second block here")}]
    ]
    document = rhythm_document(0.0, 0.0, 15.0)
    moved = convert.align_vertical_rhythm(document, pdf_rows, 792.0)
    after = convert.paragraph_metrics(document.paragraphs[1]._p)
    # 72 top margin, a 12 pt first box, then the gap that puts the second
    # baseline at 160: 160 - 0.8 x 15 - 84.
    passed &= check(moved == 1, "rhythm: one block was moved", moved)
    passed &= check(after is not None and abs(after["before"] - 64.0) < 0.3,
                    "rhythm: the spacing is what the PDF's baseline asks for", after and after["before"])

    # A gap the PDF makes negative comes out of the block above first.
    tight = [
        [{"base": 100.0, "y0": 92.0, "y1": 103.0, "key": convert.compare_squash("First block here")},
         {"base": 92.0, "y0": 84.0, "y1": 95.0, "key": convert.compare_squash("Second block here")}]
    ]
    document = rhythm_document(0.0, 20.0, 15.0)
    convert.align_vertical_rhythm(document, tight, 792.0)
    above = convert.paragraph_metrics(document.paragraphs[0]._p)
    below = convert.paragraph_metrics(document.paragraphs[1]._p)
    passed &= check(above is not None and above["after"] == 0.0,
                    "rhythm: the block above gives its spacing back first", above and above["after"])
    passed &= check(below is not None and below["before"] == 0.0 and below["line"] < 15.0,
                    "rhythm: a box too tall for its place is shortened", below and below["line"])

    # And a page that would end below its bottom margin keeps what it had.
    far = [
        [{"base": 100.0, "y0": 92.0, "y1": 103.0, "key": convert.compare_squash("First block here")},
         {"base": 900.0, "y0": 892.0, "y1": 903.0, "key": convert.compare_squash("Second block here")}]
    ]
    document = rhythm_document(2.0, 0.0, 15.0)
    moved = convert.align_vertical_rhythm(document, far, 792.0)
    kept = convert.paragraph_metrics(document.paragraphs[1]._p)
    passed &= check(moved == 0 and kept is not None and abs(kept["before"] - 2.0) < 0.05,
                    "rhythm: a correction past the bottom margin is refused", kept and kept["before"])

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
        compile_case(cases.HYPHENS, pdf_path)
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

        # A font the foundry forbids must be skipped rather than embedded.
        passed &= check(not font_tools.embeddable({"fsType": 0x0002}), "fonts: a restricted font is refused")
        passed &= check(not font_tools.embeddable({"fsType": 0x0200}), "fonts: a bitmap-only font is refused")
        passed &= check(font_tools.embeddable({"fsType": 0}), "fonts: an installable font is allowed")
        passed &= check(font_tools.embeddable({"fsType": 8}), "fonts: an editable font is allowed")

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
