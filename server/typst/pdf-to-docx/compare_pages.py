#!/usr/bin/env python3
"""Score two PDFs page against page and draw contact sheets of the pairs.

    compare_pages.py <reference.pdf> <candidate.pdf> <out-dir> [label]

A developer tool for `compare.ps1`, not part of the server and not part of
`bun run test`. It needs pymupdf and numpy, which the converter's virtualenv
already has.

The score is one minus the mean absolute difference of the two pages rendered
greyscale at SCORE_WIDTH pixels, so 1.000 is identical and a page of black
against a page of white is 0.000. It is a guide rail, not the acceptance test:
Word re-flows with its own metrics, so the eye on the contact sheet decides.
"""

import json
import os
import sys

import numpy as np
import pymupdf

SCORE_WIDTH = 200
SHEET_PAGE_WIDTH = 340
SHEET_COLUMNS = 5
SHEET_GAP = 8


def grey(page, width):
    scale = width / page.rect.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csGRAY, alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)


def colour(page, width):
    scale = width / page.rect.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)


def fit(array, shape):
    """Nearest-neighbour resize, so two pages of different size still compare."""
    if array.shape[:2] == shape:
        return array
    rows = (np.arange(shape[0]) * array.shape[0] // shape[0]).clip(0, array.shape[0] - 1)
    cols = (np.arange(shape[1]) * array.shape[1] // shape[1]).clip(0, array.shape[1] - 1)
    return array[rows][:, cols]


def score_pages(reference, candidate):
    scores = []
    for index in range(min(reference.page_count, candidate.page_count)):
        a = grey(reference[index], SCORE_WIDTH)
        b = fit(grey(candidate[index], SCORE_WIDTH), a.shape)
        scores.append(1.0 - float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean()) / 255.0)
    return scores


def write_sheet(reference, candidate, indexes, path):
    """One PNG: the reference pages along the top, the candidates beneath."""
    tops = [colour(reference[i], SHEET_PAGE_WIDTH) for i in indexes]
    bottoms = [colour(candidate[i], SHEET_PAGE_WIDTH) for i in indexes]
    top_height = max(a.shape[0] for a in tops)
    bottom_height = max(a.shape[0] for a in bottoms)
    height = top_height + bottom_height + SHEET_GAP * 3
    width = len(indexes) * (SHEET_PAGE_WIDTH + SHEET_GAP) + SHEET_GAP
    sheet = np.full((height, width, 3), 150, dtype=np.uint8)
    for order, (top, bottom) in enumerate(zip(tops, bottoms)):
        x = SHEET_GAP + order * (SHEET_PAGE_WIDTH + SHEET_GAP)
        sheet[SHEET_GAP : SHEET_GAP + top.shape[0], x : x + top.shape[1]] = top
        y = SHEET_GAP * 2 + top_height
        sheet[y : y + bottom.shape[0], x : x + bottom.shape[1]] = bottom
    pix = pymupdf.Pixmap(pymupdf.csRGB, width, height, bytes(sheet.tobytes()), 0)
    pix.save(path)


def main(argv):
    if len(argv) < 4:
        print("usage: compare_pages.py <reference.pdf> <candidate.pdf> <out-dir> [label]", file=sys.stderr)
        return 2
    reference = pymupdf.open(argv[1])
    candidate = pymupdf.open(argv[2])
    out_dir = argv[3]
    label = argv[4] if len(argv) > 4 else "sheet"
    os.makedirs(out_dir, exist_ok=True)

    scores = score_pages(reference, candidate)
    print("pages: reference %d, candidate %d" % (reference.page_count, candidate.page_count))
    print("page  similarity")
    for index, value in enumerate(scores):
        print("%4d  %.4f" % (index + 1, value))
    if scores:
        ordered = sorted(scores)
        print("worst %.4f  median %.4f  mean %.4f" % (ordered[0], ordered[len(ordered) // 2], sum(scores) / len(scores)))

    sheets = []
    shared = list(range(min(reference.page_count, candidate.page_count)))
    for start in range(0, len(shared), SHEET_COLUMNS):
        chunk = shared[start : start + SHEET_COLUMNS]
        path = os.path.join(out_dir, "%s-%02d.png" % (label, start // SHEET_COLUMNS + 1))
        write_sheet(reference, candidate, chunk, path)
        sheets.append(path)
    if len(shared) > SHEET_COLUMNS:
        worst = [i for i, _ in sorted(enumerate(scores), key=lambda kv: kv[1])[:SHEET_COLUMNS]]
        path = os.path.join(out_dir, "%s-worst.png" % label)
        write_sheet(reference, candidate, sorted(worst), path)
        sheets.append(path)

    with open(os.path.join(out_dir, "%s-scores.json" % label), "w", encoding="utf-8") as handle:
        json.dump(
            {
                "referencePages": reference.page_count,
                "candidatePages": candidate.page_count,
                "scores": [round(s, 4) for s in scores],
                "sheets": sheets,
            },
            handle,
            indent=1,
        )
    print("sheets: " + ", ".join(sheets))
    same = reference.page_count == candidate.page_count
    reference.close()
    candidate.close()
    return 0 if same else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
