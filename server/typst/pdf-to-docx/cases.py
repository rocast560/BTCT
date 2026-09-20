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
