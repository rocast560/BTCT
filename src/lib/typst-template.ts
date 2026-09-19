// ─────────────────────────────────────────────────────────────────────────
// Starter document shown the first time a workspace's Typst report is opened.
//
// Ships with the `image-placeholder` helper pre-defined: screenshots are
// assigned to declared figure slots from the Assets rail rather than pasted
// at the caret, so captions and numbering stay consistent. An unfilled slot
// renders as a labelled grey box, making a missing screenshot obvious in the
// PDF instead of silently absent.
//
// The helper text is imported from `typst-placeholders` rather than copied,
// so the slot parser and the document it seeds can never disagree about the
// helper's signature.
// ─────────────────────────────────────────────────────────────────────────

import { PLACEHOLDER_HELPER } from './typst-placeholders';

export const DEFAULT_TYPST_TEMPLATE = `#set page(margin: 1.5cm)
#set text(font: "New Computer Modern", size: 11pt)
#set heading(numbering: "1.1")

${PLACEHOLDER_HELPER}

#align(center)[
  #text(size: 20pt, weight: "bold")[Engagement Report] \\
  #text(size: 11pt)[Been There, Conquered That]
]

= Executive Summary

Write a high-level summary of the engagement here. Typst renders this
preview locally: no internet required.

= Findings

== Example Finding

#table(
  columns: (auto, 1fr),
  [*Severity*], [High],
  [*CVSS*], [8.1],
  [*Affected*], [10.0.0.5],
)

Describe the finding, its impact, and remediation steps.

#image-placeholder("Proof of exploitation")
`;
