"""The Typst sources test_convert.py compiles, one per behaviour it pins.

Kept beside the test rather than inside it because they are documents, not
code: each one is a shape that made the converter delete part of a report, and
reading them is how you see what the thresholds in convert.py are for.
"""

# Every page's bottom rows are a table row whose only difference from the row
# above is a number, and digit blanking made them all the same text. Two of
# them landed at the same height and were lifted out as a running footer, so
# `Host-111` left the Word file and `Host-073` became the footer of every
# page. Nothing here may be detected as a band.
TABLE = """
#set page(paper: "a4", margin: 2cm)
#set text(size: 10pt)
= Open ports
#table(
  columns: (auto, auto, 1fr),
  table.header([*Host*], [*Address*], [*Finding*]),
  ..range(1, 121).map(i => (
    [Host-#{ if i < 100 { "0" } }#i],
    [10.0.0.#i],
    [Open port finding number #i],
  )).flatten(),
)
"""

# A real running header with the same first body line under it on every page.
# The line sits about 12 pt below the header, inside the glue that holds the
# lines of one band together, so it was deleted from all four pages and
# pasted into the Word header. The header must be lifted and the body line
# must stay where it is.
FIRST_BODY_LINE = """
#set page(
  paper: "us-letter",
  margin: 1in,
  header: align(left)[Acme Security Assessment],
  footer: align(center)[#context counter(page).display()],
)
#set text(size: 11pt)
#for i in range(4) [
  #lorem(300)
  #pagebreak(weak: true)
]
"""

# Odd and even pages carry different headers. Both cleared the old quorum, so
# every page's Word header read "Acme Security Assessment Contoso Consulting
# Group". Word can express this and this script does not, so the edge has to
# be declined and said out loud.
ODD_EVEN = """
#set page(
  paper: "a4",
  margin: 2cm,
  header: context {
    if calc.odd(counter(page).get().first()) [Acme Security Assessment]
    else [Contoso Consulting Group]
  },
)
#set text(size: 11pt)
#for i in range(4) [
  = Section #(i + 1)
  #lorem(120)
  #pagebreak(weak: true)
]
"""

# The shape the whole feature exists for: a cover with no band, a running
# header and footer with a page number, and a table of contents with dot
# leaders. Both repairs have to run, and nothing may be reported.
REPORT = """
#set page(
  paper: "us-letter",
  margin: (x: 2cm, y: 2.2cm),
  header: context {
    if counter(page).get().first() > 1 [
      #grid(columns: (1fr, 1fr), align(left)[Acme Security Assessment], align(right)[Contoso Ltd])
      #line(length: 100%, stroke: 0.5pt)
    ]
  },
  footer: context {
    if counter(page).get().first() > 1 {
      grid(columns: (1fr, 1fr),
        align(left)[CONFIDENTIAL],
        align(right)[#(counter(page).get().first() - 1)])
    }
  },
)
#set text(size: 11pt)
#align(center + horizon)[#text(size: 28pt)[Acme Security Assessment] \\ Prepared for Contoso]
#pagebreak()
= Table of contents
#for (title, page) in (("Introduction", 3), ("Scope of the engagement", 4),
                       ("Findings and remediation", 5), ("Appendix A: methodology", 6)) [
  #box(width: 100%)[#title #box(width: 1fr, repeat[.]) #page]
]
#pagebreak()
= Introduction
#lorem(120)
#pagebreak()
= Scope of the engagement
#lorem(120)
#pagebreak()
= Findings and remediation
#lorem(120)
#pagebreak()
= Appendix A: methodology
#lorem(120)
"""

# The same, with titles in three scripts. `squash` used to reduce a Cyrillic
# title to the empty string, which matched nothing, and an entry that matched
# nothing was deleted along with the rest of its stretch.
MIXED_SCRIPT_TOC = """
#set page(paper: "a4", margin: 2cm)
#set text(size: 11pt, font: "Libertinus Serif")
= Table of contents
#for (title, page) in (("Introduction", 2), ("Глава первая", 3),
                       ("Κεφάλαιο δύο", 4), ("Conclusions", 5)) [
  #box(width: 100%)[#title #box(width: 1fr, repeat[.]) #page]
]
#pagebreak()
= Introduction
#lorem(60)
#pagebreak()
= Глава первая
#lorem(60)
#pagebreak()
= Κεφάλαιο δύο
#lorem(60)
#pagebreak()
= Conclusions
#lorem(60)
"""

# What a report can put in front of a client who opens the Word file. Only the
# last two may survive into `word/_rels/`.
LINKS = """
#set page(paper: "a4", margin: 2cm)
#set text(size: 11pt)
= Links
- #link("FILE://attacker.example/share/x")[Read the appendix]
- #link("smb://attacker.example/share/y")[Share]
- #link("javascript:alert(1)")[Script]
- #link("ms-msdt:/id PCWDiagnostic")[Diagnostic]
- #link("\\\\\\\\attacker.example\\\\share\\\\z")[UNC]
- #link("https://example.com/ok")[Normal link]
- #link("mailto:team@example.com")[Mail us]
"""

# A running header, a per-page DISTINCT finding title just under it, and a
# repeating full-width rule below the title. The rule is a band decoration, so
# the erased rectangle used to be grown to reach it, and that rectangle is the
# whole page width: all eight titles were deleted, with the text check blind
# to it because it excluded the same rectangle from both sides.
RULE_OVER_TITLES = """
#set page(
  paper: "a4",
  margin: 2cm,
  header: align(left)[Acme Security Assessment],
)
#set text(size: 11pt)
#for i in range(8) [
  #v(2pt)
  #text(size: 13pt, weight: "bold")[Finding #(i + 1): unique title #(i + 1)]
  #v(1pt)
  #line(length: 100%, stroke: 0.6pt)
  #lorem(80)
  #pagebreak(weak: true)
]
"""

# Every page holds one line of text and nothing else, so the gap between the
# candidate and the body cannot be measured anywhere. That used to count as a
# pass, and the one line on each page was lifted into the Word header while
# the text check, left with nothing to compare, reported success.
NOTHING_BUT_A_BAND = """
#set page(paper: "a4", margin: 2cm)
#set text(size: 11pt)
#for i in range(4) [
  Quarterly review of the control set
  #pagebreak(weak: true)
]
"""

# A justified paragraph that hyphenates at a line end, plus a real hyphen at a
# line end. Typst writes its own break hyphens as U+00AD and the real one as
# U+002D, so the first must disappear from the Word file and the second must
# not.
HYPHENS = """
#set page(paper: "a4", margin: (x: 2cm, y: 2cm))
#set text(size: 11pt, lang: "en")
#set par(justify: true)
= Hyphenation
{{OUR_COMPANY}} employed a custom, heuristic risk assessment system to measure
overall criticality, and the likelihood ratings were assigned appropriately by
the assessment team throughout the engagement so that every finding carries a
defensible rating.

Affects a small number of users and results in the disclosure of non-critical
information such as verification that a user exists on the system.
"""

# A code block on a grey panel holding two strings a space would change, and
# the same two shapes in prose where the PDF shows a real gap. The marker
# repair has to fix the prose and leave the command alone: the text check
# squashes whitespace, so a space added inside a command is invisible to it.
CODE_AND_MARKERS = """
#set page(paper: "a4", margin: 2cm)
#set text(size: 11pt)
= Remediation
#block(fill: rgb(235, 235, 235), inset: 10pt, width: 100%)[
  #text(font: "DejaVu Sans Mono", size: 9pt)[
    ./deploy 1.{{X}} \\
    check version1.2.3
  ]
]

Then apply the following, in order:

+ {{X}} must be rebuilt first.
+ version1.2.3 is the baseline.
"""

# Cheap for typst, expensive for the converter: 120,000 one-point rectangles
# a page. It has to be refused before pdf2docx is started.
SHAPES = """
#set page(paper: "a4", margin: 0cm)
#for p in range(2) {
  for i in range(120000) {
    place(
      dx: calc.rem(i, 560) * 1pt,
      dy: calc.rem(i * 7, 800) * 1pt,
      rect(width: 1pt, height: 1pt, fill: rgb(20, 60, 200)),
    )
  }
  pagebreak(weak: true)
}
"""
