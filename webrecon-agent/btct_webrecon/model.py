"""The recon result model and the normalized "BTCT sitemap JSON v1" output.

A Collector accumulates nodes (deduped by their natural key) and edges (deduped
by source|target|kind) as the crawler, subdomain, API and external-tool
collectors run, then emits the document BTCT imports.
"""
from __future__ import annotations

import time
from typing import Dict, List, Optional, Tuple

NODE_TYPES = {"root", "subdomain", "page", "endpoint", "api", "js", "form", "external"}
EDGE_KINDS = {"link", "redirect", "hierarchy", "form-action", "api-ref"}


def node_key(ntype: str, url: str, method: str = "") -> str:
    """Stable natural key: matches computeNodeKey in the app (type|METHOD|url)."""
    return f"{ntype}|{(method or '').upper()}|{url}"


class Node:
    __slots__ = ("key", "type", "url", "method", "status", "content_type",
                 "title", "size", "params", "sources", "tags", "notes")

    def __init__(self, ntype: str, url: str, method: str = "") -> None:
        self.type = ntype if ntype in NODE_TYPES else "page"
        self.url = url
        self.method = (method or "").upper()
        self.key = node_key(self.type, url, self.method)
        self.status: Optional[int] = None
        self.content_type = ""
        self.title = ""
        self.size: Optional[int] = None
        self.params: List[str] = []
        self.sources: List[str] = []
        self.tags: List[str] = []
        self.notes = ""

    def to_json(self) -> dict:
        return {
            "key": self.key,
            "type": self.type,
            "url": self.url,
            "method": self.method,
            "status": self.status,
            "contentType": self.content_type,
            "title": self.title,
            "size": self.size,
            "params": self.params,
            "sources": self.sources,
            "tags": self.tags,
            "notes": self.notes,
        }


def _add_unique(dst: List[str], values) -> None:
    for v in (values or []):
        s = str(v).strip()
        if s and s not in dst and len(dst) < 64:
            dst.append(s)


class Collector:
    def __init__(self) -> None:
        self._nodes: Dict[str, Node] = {}
        self._edges: Dict[Tuple[str, str, str], str] = {}

    def node(self, ntype: str, url: str, method: str = "") -> Node:
        """Get-or-create a node, merging repeated observations onto one record."""
        key = node_key(ntype if ntype in NODE_TYPES else "page", url, method)
        n = self._nodes.get(key)
        if n is None:
            n = Node(ntype, url, method)
            self._nodes[key] = n
        return n

    def add(self, ntype: str, url: str, method: str = "", *, status: Optional[int] = None,
            content_type: str = "", title: str = "", size: Optional[int] = None,
            params=None, source: str = "", tags=None, notes: str = "") -> Node:
        n = self.node(ntype, url, method)
        if status is not None:
            n.status = status
        if content_type:
            n.content_type = content_type
        if title and not n.title:
            n.title = title
        if size is not None:
            n.size = size
        _add_unique(n.params, params)
        if source:
            _add_unique(n.sources, [source])
        _add_unique(n.tags, tags)
        if notes and not n.notes:
            n.notes = notes
        return n

    def edge(self, src_key: str, tgt_key: str, kind: str = "link", label: str = "") -> None:
        if not src_key or not tgt_key or src_key == tgt_key:
            return
        k = kind if kind in EDGE_KINDS else "link"
        self._edges[(src_key, tgt_key, k)] = label

    def has(self, ntype: str, url: str, method: str = "") -> bool:
        return node_key(ntype, url, method) in self._nodes

    def nodes(self) -> List[Node]:
        return list(self._nodes.values())

    def to_doc(self, target: str, scanned_at: Optional[int] = None) -> dict:
        return {
            "version": 1,
            "tool": "btct-webrecon",
            "target": target,
            "scannedAt": scanned_at if scanned_at is not None else int(time.time() * 1000),
            "nodes": [n.to_json() for n in self._nodes.values()],
            "edges": [
                {"source": s, "target": t, "kind": k, "label": label}
                for (s, t, k), label in self._edges.items()
            ],
        }
