"""API surface discovery: OpenAPI/Swagger, GraphQL, and endpoints mined out of
linked JavaScript."""
from __future__ import annotations

import json
import re
from typing import Set
from urllib.parse import urljoin, urlsplit

from .httputil import fetch, in_scope
from .model import Collector, node_key

OPENAPI_PATHS = [
    "/openapi.json", "/swagger.json", "/swagger/v1/swagger.json",
    "/api-docs", "/v2/api-docs", "/v3/api-docs", "/api/swagger.json",
]
GRAPHQL_PATHS = ["/graphql", "/api/graphql", "/query"]

# URL-ish strings inside JS: quoted absolute paths and full URLs.
_JS_URL_RE = re.compile(r"""["'`](/(?:api|v\d+|rest|graphql|admin|internal)[A-Za-z0-9_\-/.]{0,180})["'`]""")
_JS_FULL_RE = re.compile(r"""["'`](https?://[A-Za-z0-9_\-./:]{4,200})["'`]""")


def detect_openapi(col: Collector, root: str, timeout: float = 10.0) -> None:
    for path in OPENAPI_PATHS:
        res = fetch(urljoin(root, path), timeout=timeout)
        if not res or res.status != 200 or "json" not in res.content_type:
            continue
        try:
            spec = json.loads(res.text())
        except (ValueError, TypeError):
            continue
        if not isinstance(spec, dict) or not (spec.get("paths") or spec.get("swagger") or spec.get("openapi")):
            continue
        doc = col.add("api", urljoin(root, path), status=res.status,
                      content_type=res.content_type, source="openapi", tags=["openapi", "spec"])
        paths = spec.get("paths") if isinstance(spec.get("paths"), dict) else {}
        for p, methods in list(paths.items())[:500]:
            full = urljoin(root, str(p))
            verbs = [m.upper() for m in methods] if isinstance(methods, dict) else ["GET"]
            for verb in verbs:
                n = col.add("api", full, method=verb, source="openapi", tags=["openapi"])
                col.edge(doc.key, n.key, "api-ref")
        return  # one spec is enough


def detect_graphql(col: Collector, root: str, timeout: float = 10.0) -> None:
    query = json.dumps({"query": "{__schema{queryType{name}}}"}).encode("utf-8")
    for path in GRAPHQL_PATHS:
        url = urljoin(root, path)
        res = fetch(url, method="POST", timeout=timeout, data=query,
                    extra_headers={"Content-Type": "application/json"})
        if not res or res.status not in (200, 400):
            continue
        body = res.text(limit=64 * 1024)
        if "__schema" in body or '"data"' in body or "errors" in body and "graphql" in body.lower():
            col.add("api", url, method="POST", status=res.status,
                    content_type=res.content_type, source="graphql", tags=["graphql"])
            return


def mine_js(col: Collector, js_urls: Set[str], root: str, base_host: str,
            include_subdomains: bool, timeout: float = 10.0, limit: int = 40) -> None:
    for js_url in list(js_urls)[:limit]:
        res = fetch(js_url, timeout=timeout)
        if not res or res.status != 200:
            continue
        text = res.text(limit=1024 * 1024)
        js_key = node_key("js", js_url)
        found = 0
        for m in _JS_URL_RE.findall(text):
            full = urljoin(root, m)
            n = col.add("api" if re.search(r"/(api|v\d+|graphql|rest)/", m) else "endpoint",
                        full, source="js", tags=["from-js"])
            col.edge(js_key, n.key, "api-ref")
            found += 1
            if found > 200:
                break
        for m in _JS_FULL_RE.findall(text):
            if in_scope(m, base_host, include_subdomains):
                path = urlsplit(m).path.lower()
                if any(seg in path for seg in ("/api", "/graphql", "/rest")) or re.search(r"/v\d+/", path):
                    n = col.add("api", m, source="js", tags=["from-js"])
                    col.edge(js_key, n.key, "api-ref")
