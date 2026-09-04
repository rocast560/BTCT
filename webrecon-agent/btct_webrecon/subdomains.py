"""Subdomain enumeration via crt.sh certificate transparency (no API key)."""
from __future__ import annotations

import json
from typing import Set
from urllib.parse import quote

from .httputil import fetch, registrable_domain
from .model import Collector, node_key


def enumerate_crtsh(col: Collector, root: str, base_host: str, timeout: float = 20.0,
                    limit: int = 500) -> Set[str]:
    """Add subdomain nodes discovered from crt.sh. Returns the host set."""
    domain = registrable_domain(base_host)
    if not domain:
        return set()
    url = "https://crt.sh/?q=%25." + quote(domain) + "&output=json"
    res = fetch(url, timeout=timeout)
    hosts: Set[str] = set()
    if not res or res.status != 200:
        return hosts
    try:
        rows = json.loads(res.text(limit=8 * 1024 * 1024))
    except (ValueError, TypeError):
        return hosts
    for row in rows:
        name_value = str(row.get("name_value", "")) if isinstance(row, dict) else ""
        for name in name_value.split("\n"):
            h = name.strip().lower().lstrip("*.").strip()
            if not h or "*" in h:
                continue
            if h == domain or h.endswith("." + domain):
                hosts.add(h)
        if len(hosts) >= limit:
            break

    root_key = node_key("root", root)
    for h in sorted(hosts):
        n = col.add("subdomain", "https://" + h, source="crt.sh", tags=["subdomain"])
        col.edge(root_key, n.key, "hierarchy")
    return hosts
