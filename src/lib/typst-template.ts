// ─────────────────────────────────────────────────────────────────────────
// Starter document for a new report.
//
// Shared by the client and the server (the server seeds it on
// `POST /api/documents`), so this file must stay free of DOM and Node
// imports. The `image-placeholder` helper below is the canonical definition
// from `lib/typst-placeholders.ts`, inlined as text so the server doesn't
// pull the placeholder module in.
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_WORKSPACE_NAME = 'Untitled report';

export const DEFAULT_TYPST_TEMPLATE = `#set page(margin: 1.5cm)
#set text(font: "New Computer Modern", size: 11pt)
#set heading(numbering: "1.1")

#let image-placeholder(caption, path: none, height: 2.2in) = figure(
  block(
    width: 90%,
    height: height,
    fill: luma(245),
    stroke: 1pt + luma(180),
    radius: 4pt,
    clip: true,
    inset: 0pt,
    align(center + horizon,
      if path == none {
        text(fill: luma(120), style: "italic", size: 11pt)[
          \\[ {{TODO: Insert screenshot here}} \\]
        ]
      } else {
        image(path, width: 100%, height: 100%, fit: "cover")
      },
    ),
  ),
  caption: caption,
)

#align(center)[
  #text(size: 20pt, weight: "bold")[Engagement Report] \\
  #text(size: 11pt)[Typst Studio]
]

= Executive Summary

Write a high-level summary of the engagement here. Typst renders this
preview locally, with no internet required.

= Findings

== Example Finding

#table(
  columns: (auto, 1fr),
  [*Severity*], [High],
  [*CVSS*], [8.1],
  [*Affected*], [10.0.0.5],
)

Describe the finding, its impact, and remediation steps. Drop a screenshot
into the Assets rail, frame it, blur anything sensitive, and place it into
one of the figure slots below.

#image-placeholder("Proof of exploitation")

#image-placeholder("Redacted credentials", height: 3in)
`;
