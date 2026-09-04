"""Ship a normalized document to the BTCT ingest endpoint (bearer token)."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Optional


def ship(server: str, token: str, doc: dict, workspace: Optional[str] = None,
         site_map_id: Optional[str] = None, name: Optional[str] = None,
         timeout: float = 20.0) -> dict:
    """POST the document to <server>/api/webrecon/ingest. Raises on failure."""
    url = server.rstrip("/") + "/api/webrecon/ingest"
    payload = dict(doc)
    if workspace:
        payload["workspaceId"] = workspace
    if site_map_id:
        payload["siteMapId"] = site_map_id
    if name:
        payload["name"] = name
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        raise RuntimeError(f"ingest failed ({e.code}): {detail[:300]}") from e
