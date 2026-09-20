#!/usr/bin/env python3
"""Carry the report's fonts into the Word file, so it reads the same anywhere.

A Word file names its fonts and expects the reader's machine to have them.
This one is made from a PDF and, since the owner asked for the PDF's line
endings to be reproduced exactly, a substituted font does not merely look
different: a line that fitted the column becomes one that does not, and the
page re-wraps. So the fonts go in the file.

The format is awkward but small. Each font is a part under `word/fonts/`
whose first 32 bytes are XORed with a key taken from the part's own GUID, the
relationship from `word/fontTable.xml` names it under `w:embedRegular` and
friends with that GUID as `w:fontKey`, and `word/settings.xml` has to say
`w:embedTrueTypeFonts`. `w:saveSubsetFonts` is deliberately left off: the
whole font goes in, so the file stays editable rather than carrying only the
glyphs this report happened to use.

**Licences are read, not assumed.** The OS/2 table's `fsType` says what the
foundry allows. 0 is installable, 8 is editable, 4 is preview and print, and
2 is restricted. Only the first three are embedded; a restricted font, or one
whose bitmap-embedding-only bit is set, is skipped and named in a warning so
whoever sends the file knows a reader without it will see something else.
"""

import os
import re
import struct
import uuid
import zipfile

CONTENT_TYPES = "[Content_Types].xml"
FONT_TABLE = "word/fontTable.xml"
SETTINGS = "word/settings.xml"
FONT_TABLE_RELS = "word/_rels/fontTable.xml.rels"
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
FONT_REL_TYPE = R_NS + "/font"
# OS/2 fsType. Bit 1 means the foundry forbids embedding outright; bit 9 means
# only a bitmap may be embedded, which a Word file cannot do.
FS_RESTRICTED = 0x0002
FS_BITMAP_ONLY = 0x0200
STYLE_ELEMENTS = {
    (False, False): "w:embedRegular",
    (True, False): "w:embedBold",
    (False, True): "w:embedItalic",
    (True, True): "w:embedBoldItalic",
}


def obfuscate(data, key):
    """Word's font obfuscation: the first 32 bytes XORed with the GUID's bytes.

    The key is the part's GUID written backwards as pairs of hex digits, which
    is the one detail every implementation gets wrong the first time.
    """
    nibbles = bytes.fromhex(key.strip("{}").replace("-", ""))
    mask = bytes(reversed(nibbles))
    head = bytes(b ^ mask[i % 16] for i, b in enumerate(data[:32]))
    return head + data[32:]


def read_font(path):
    """Family, weight, slant and licence, read out of the font's own tables."""
    try:
        from fontTools.ttLib import TTFont
    except ImportError:  # pragma: no cover - fontTools ships with pdf2docx
        return None
    try:
        with TTFont(path, lazy=True, fontNumber=0) as font:
            names = {}
            for record in font["name"].names:
                if record.nameID in (1, 2, 16, 17) and record.nameID not in names:
                    with_ = record.toUnicode()
                    names[record.nameID] = with_
            family = names.get(16) or names.get(1)
            style = (names.get(17) or names.get(2) or "").lower()
            os2 = font["OS/2"] if "OS/2" in font else None
            fs_type = int(getattr(os2, "fsType", 0) or 0)
            bold = bool(os2 and (os2.fsSelection & 0x20)) or "bold" in style
            italic = bool(os2 and (os2.fsSelection & 0x01)) or "italic" in style or "oblique" in style
    except Exception:  # noqa: BLE001 - a font we cannot read is a font we skip
        return None
    if not family:
        return None
    return {"path": path, "family": family.strip(), "bold": bold, "italic": italic, "fsType": fs_type}


def embeddable(entry):
    """Does the foundry allow this font to travel inside a document?"""
    fs = entry["fsType"]
    if fs & FS_BITMAP_ONLY:
        return False
    return not (fs & FS_RESTRICTED)


def collect(directories):
    """Every readable font under these directories, keyed by family."""
    found = {}
    for directory in directories:
        if not directory or not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if not name.lower().endswith((".ttf", ".otf")):
                continue
            entry = read_font(os.path.join(directory, name))
            if entry:
                found.setdefault(entry["family"], []).append(entry)
    return found


def wanted_families(doc, font_family):
    """The families the PDF actually uses, by the name Word will ask for."""
    families = set()
    for index in range(doc.page_count):
        for block in doc[index].get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    name = font_family(span.get("font"))
                    if name:
                        families.add(name)
    return families


def embed(docx_path, families, available):
    """Put the fonts in the file. Returns (embedded families, skipped names)."""
    chosen = []
    skipped = []
    for family in sorted(families):
        entries = available.get(family)
        if not entries:
            # The family Word is asked for may be spelled with a space the
            # font file does not have, or the other way about.
            flat = family.replace(" ", "").lower()
            entries = next((v for k, v in available.items() if k.replace(" ", "").lower() == flat), None)
        if not entries:
            skipped.append((family, "no font file for it was staged"))
            continue
        usable = [e for e in entries if embeddable(e)]
        if not usable:
            skipped.append((family, "its licence does not allow embedding"))
            continue
        chosen.append((family, usable))
    if not chosen:
        return [], skipped

    parts = {}
    table_rows = []
    rels = []
    for family, entries in chosen:
        rows = []
        for entry in entries:
            style = STYLE_ELEMENTS[(entry["bold"], entry["italic"])]
            if any(row.startswith("<" + style) for row in rows):
                continue
            key = "{%s}" % str(uuid.uuid4()).upper()
            rid = "rIdFont%d" % (len(parts) + 1)
            name = "fonts/font%d.odttf" % (len(parts) + 1)
            with open(entry["path"], "rb") as handle:
                parts["word/" + name] = obfuscate(handle.read(), key)
            rels.append((rid, name))
            rows.append('<%s r:id="%s" w:fontKey="%s" w:subsetted="false"/>' % (style, rid, key))
        if rows:
            table_rows.append('<w:font w:name="%s">%s</w:font>' % (escape(family), "".join(rows)))
    if not table_rows:
        return [], skipped
    rewrite(docx_path, parts, table_rows, rels)
    return [family for family, _ in chosen], skipped


def escape(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")


def rewrite(docx_path, parts, table_rows, rels):
    """Write the package back with the font parts and the three edits."""
    with zipfile.ZipFile(docx_path) as archive:
        existing = {item.filename: archive.read(item.filename) for item in archive.infolist()}

    types = existing[CONTENT_TYPES].decode("utf-8")
    if "odttf" not in types:
        types = types.replace(
            "</Types>",
            '<Default Extension="odttf" '
            'ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/></Types>',
        )
    existing[CONTENT_TYPES] = types.encode("utf-8")

    table = existing.get(FONT_TABLE, b"").decode("utf-8")
    if not table.strip():
        table = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<w:fonts xmlns:w="%s" xmlns:r="%s"></w:fonts>' % (W_NS, R_NS))
    if 'xmlns:r=' not in table:
        table = table.replace("<w:fonts ", '<w:fonts xmlns:r="%s" ' % R_NS, 1)
    # A family already in the table keeps its own element and gains the
    # embed children, rather than being declared twice.
    for row in table_rows:
        name = re.search(r'w:name="([^"]+)"', row).group(1)
        children = row[row.index(">") + 1 : row.rindex("</w:font>")]
        pattern = re.compile(r'(<w:font w:name="%s"[^>]*>)' % re.escape(name))
        if pattern.search(table):
            table = pattern.sub(lambda m: m.group(1) + children, table, count=1)
        else:
            table = table.replace("</w:fonts>", row + "</w:fonts>")
    existing[FONT_TABLE] = table.encode("utf-8")

    relationships = existing.get(FONT_TABLE_RELS, b"").decode("utf-8")
    if not relationships.strip():
        relationships = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         "</Relationships>")
    added = "".join(
        '<Relationship Id="%s" Type="%s" Target="%s"/>' % (rid, FONT_REL_TYPE, target) for rid, target in rels
    )
    existing[FONT_TABLE_RELS] = relationships.replace("</Relationships>", added + "</Relationships>").encode("utf-8")

    settings = existing.get(SETTINGS, b"").decode("utf-8")
    if "embedTrueTypeFonts" not in settings:
        settings = re.sub(r"(<w:settings[^>]*>)", r"\1<w:embedTrueTypeFonts/>", settings, count=1)
    existing[SETTINGS] = settings.encode("utf-8")
    existing.update(parts)

    with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in existing.items():
            archive.writestr(name, data)
