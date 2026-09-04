"""Built-in same-scope crawler (urllib + html.parser). Discovers pages, forms,
linked JavaScript, query parameters, and the link graph. Also seeds from
robots.txt and sitemap.xml. Returns the set of linked JS URLs for the API
collector to mine."""
from __future__ import annotations

import re
import time
from html.parser import HTMLParser
from typing import List, Optional, Set, Tuple
from urllib.parse import urldefrag, urljoin, urlsplit, parse_qs

from .httputil import fetch, host_of, in_scope
from .model import Collector, node_key


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: List[str] = []
        self.scripts: List[str] = []
        # (action, method, [input names])
        self.forms: List[Tuple[str, str, List[str]]] = []
        self.title = ""
        self._in_title = False
        self._cur_form: Optional[Tuple[str, str, List[str]]] = None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
        elif tag == "link" and a.get("href"):
            self.links.append(a["href"])
        elif tag == "script" and a.get("src"):
            self.scripts.append(a["src"])
        elif tag == "form":
            self._cur_form = (a.get("action", ""), (a.get("method", "GET") or "GET").upper(), [])
        elif tag in ("input", "textarea", "select") and self._cur_form is not None:
            if a.get("name"):
                self._cur_form[2].append(a["name"])
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "form" and self._cur_form is not None:
            self.forms.append(self._cur_form)
            self._cur_form = None
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and len(self.title) < 200:
            self.title += data.strip()


class CrawlOptions:
    def __init__(self, max_pages: int = 200, max_depth: int = 4,
                 include_subdomains: bool = True, delay: float = 0.0,
                 timeout: float = 10.0) -> None:
        self.max_pages = max_pages
        self.max_depth = max_depth
        self.include_subdomains = include_subdomains
        self.delay = delay
        self.timeout = timeout


def _clean(base: str, href: str) -> Optional[str]:
    href = (href or "").strip()
    if not href:
        return None
    low = href.lower()
    if low.startswith(("mailto:", "javascript:", "tel:", "data:", "#")):
        return None
    joined = urljoin(base, href)
    joined, _ = urldefrag(joined)
    if not joined.lower().startswith(("http://", "https://")):
        return None
    return joined


def _params(url: str) -> List[str]:
    try:
        return list(parse_qs(urlsplit(url).query).keys())[:32]
    except ValueError:
        return []


def _classify(url: str, content_type: str) -> str:
    path = urlsplit(url).path.lower()
    if path.endswith(".js") or content_type in ("application/javascript", "text/javascript"):
        return "js"
    if content_type == "application/json" or "/api/" in path or "/graphql" in path \
            or re.search(r"/v\d+/", path):
        return "api"
    if content_type.startswith("text/html") or path in ("", "/") or "." not in path.rsplit("/", 1)[-1]:
        return "page"
    return "endpoint"


def _seed_from_robots_sitemap(col: Collector, root: str, base_host: str, opts: CrawlOptions) -> List[str]:
    seeds: List[str] = []
    robots = fetch(urljoin(root, "/robots.txt"), timeout=opts.timeout)
    if robots and robots.status == 200:
        for line in robots.text().splitlines():
            line = line.strip()
            for prefix in ("Disallow:", "Allow:", "Sitemap:"):
                if line.lower().startswith(prefix.lower()):
                    val = line[len(prefix):].strip()
                    u = _clean(root, val)
                    if u and in_scope(u, base_host, opts.include_subdomains):
                        seeds.append(u)
    sm = fetch(urljoin(root, "/sitemap.xml"), timeout=opts.timeout)
    if sm and sm.status == 200:
        for m in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", sm.text()):
            u = _clean(root, m)
            if u and in_scope(u, base_host, opts.include_subdomains):
                seeds.append(u)
    return seeds


def crawl(col: Collector, root: str, opts: CrawlOptions) -> Set[str]:
    """Crawl from `root`, filling `col`. Returns the set of discovered JS URLs."""
    base_host = host_of(root)
    root_key = node_key("root", root)
    col.add("root", root, source="crawl")

    js_urls: Set[str] = set()
    seen: Set[str] = {urldefrag(root)[0]}
    queue: List[Tuple[str, int]] = [(root, 0)]
    for s in _seed_from_robots_sitemap(col, root, base_host, opts):
        if s not in seen:
            seen.add(s)
            queue.append((s, 1))

    pages_fetched = 0
    while queue and pages_fetched < opts.max_pages:
        url, depth = queue.pop(0)
        res = fetch(url, timeout=opts.timeout)
        pages_fetched += 1
        if opts.delay:
            time.sleep(opts.delay)
        if res is None:
            continue

        ntype = "root" if url == root else _classify(res.final_url or url, res.content_type)
        node = col.add(ntype, url, status=res.status, content_type=res.content_type,
                       size=len(res.body), params=_params(url), source="crawl")
        src_key = root_key if url == root else node.key

        # Redirect edge.
        if res.final_url and res.final_url != url and in_scope(res.final_url, base_host, opts.include_subdomains):
            dst = col.add(_classify(res.final_url, ""), res.final_url, source="crawl")
            col.edge(src_key, dst.key, "redirect")

        if not res.content_type.startswith("text/html"):
            continue

        parser = _PageParser()
        try:
            parser.feed(res.text())
        except Exception:
            continue
        if parser.title:
            node.title = parser.title[:200]

        for href in parser.links:
            u = _clean(url, href)
            if not u:
                continue
            if in_scope(u, base_host, opts.include_subdomains):
                child = col.add(_classify(u, ""), u, params=_params(u), source="crawl")
                col.edge(src_key, child.key, "link")
                if u not in seen and depth + 1 <= opts.max_depth and len(seen) < opts.max_pages * 4:
                    seen.add(u)
                    queue.append((u, depth + 1))
            else:
                ext = col.add("external", u, source="crawl")
                col.edge(src_key, ext.key, "link")

        for src in parser.scripts:
            u = _clean(url, src)
            if not u:
                continue
            js = col.add("js", u, source="crawl")
            col.edge(src_key, js.key, "link")
            if in_scope(u, base_host, opts.include_subdomains):
                js_urls.add(u)

        for action, method, inputs in parser.forms:
            target = _clean(url, action) or url
            form = col.add("form", target, method=method, params=inputs, source="crawl")
            col.edge(src_key, form.key, "form-action", label=method)

    return js_urls
