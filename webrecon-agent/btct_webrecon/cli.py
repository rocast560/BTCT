"""btct-webrecon command line: crawl a target, then emit or ship a BTCT sitemap
document.

Examples:
  python3 -m btct_webrecon https://example.com --emit-json > map.json
  python3 -m btct_webrecon https://example.com --ship \
      --server https://btct.example --token btct_ing_... --map "Example"

Only scan targets you are authorized to test.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from . import __version__
from .apidetect import detect_graphql, detect_openapi, mine_js
from .crawler import CrawlOptions, crawl
from .httputil import host_of
from .model import Collector
from .probe import probe_common_paths
from .subdomains import enumerate_crtsh
from . import tools


def _norm_target(target: str) -> str:
    t = target.strip()
    if not t.lower().startswith(("http://", "https://")):
        t = "https://" + t
    return t.rstrip("/") if t.count("/") <= 2 else t


def run_scan(target: str, args, log=lambda *_: None) -> dict:
    start = time.time()
    deadline = start + max(15, args.timeout)
    req_timeout = min(15.0, max(4.0, args.timeout / 6.0))
    base_host = host_of(target)
    col = Collector()

    def time_left() -> bool:
        return time.time() < deadline

    log(f"[*] crawling {target} (max {args.max_pages} pages, depth {args.depth})")
    opts = CrawlOptions(max_pages=args.max_pages, max_depth=args.depth,
                        include_subdomains=not args.no_subdomains, delay=args.rate,
                        timeout=req_timeout)
    js_urls = set()
    if not args.no_crawl:
        js_urls = crawl(col, target, opts)
    log(f"    {len(col.nodes())} nodes after crawl, {len(js_urls)} JS files")

    if not args.no_probe and time_left():
        log("[*] probing common paths")
        probe_common_paths(col, target, timeout=req_timeout, delay=args.rate)

    if not args.no_api and time_left():
        log("[*] detecting API surface (openapi / graphql / js)")
        detect_openapi(col, target, timeout=req_timeout)
        detect_graphql(col, target, timeout=req_timeout)
        mine_js(col, js_urls, target, base_host, not args.no_subdomains, timeout=req_timeout)

    if not args.no_subdomains and time_left():
        log("[*] enumerating subdomains (crt.sh)")
        hosts = enumerate_crtsh(col, target, base_host, timeout=min(25.0, args.timeout))
        log(f"    {len(hosts)} subdomains")

    if not args.no_tools:
        found = tools.available_tools()
        if found:
            log(f"[*] external tools available: {', '.join(found)}")
        if time_left():
            tools.run_subfinder(col, target, base_host)
        if time_left():
            tools.run_httpx(col, base_host, not args.no_subdomains)
        if time_left():
            tools.run_katana(col, target, base_host, not args.no_subdomains)
        if time_left():
            tools.run_historical(col, target, base_host, not args.no_subdomains)
        if time_left():
            tools.run_whatweb(col, target)
        if time_left():
            tools.run_dirbrute(col, target, timeout=min(120.0, max(20.0, deadline - time.time())))

    doc = col.to_doc(target)
    log(f"[+] done: {len(doc['nodes'])} nodes, {len(doc['edges'])} edges in {time.time() - start:.1f}s")
    return doc


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="btct_webrecon", description="Map a target website for BTCT.")
    p.add_argument("target", help="target URL or host (https:// assumed)")
    p.add_argument("--emit-json", action="store_true", help="print the document to stdout")
    p.add_argument("--ship", action="store_true", help="POST the document to the BTCT ingest endpoint")
    p.add_argument("--server", help="BTCT base URL (for --ship)")
    p.add_argument("--token", help="ingest bearer token (for --ship)")
    p.add_argument("--workspace", help="target workspace id (for --ship)")
    p.add_argument("--site-map-id", help="existing web map id to merge into (for --ship)")
    p.add_argument("--map", dest="name", help="name for a new web map (for --ship)")
    p.add_argument("--max-pages", type=int, default=200, help="crawl page budget (default 200)")
    p.add_argument("--depth", type=int, default=4, help="crawl depth (default 4)")
    p.add_argument("--rate", type=float, default=0.0, help="delay between requests in seconds")
    p.add_argument("--timeout", type=float, default=120.0, help="overall wall-clock budget in seconds")
    p.add_argument("--no-crawl", action="store_true")
    p.add_argument("--no-probe", action="store_true", help="skip the common-path probe")
    p.add_argument("--no-api", action="store_true", help="skip API/JS detection")
    p.add_argument("--no-subdomains", action="store_true", help="skip subdomain enumeration")
    p.add_argument("--no-tools", action="store_true", help="skip external tool wrappers")
    p.add_argument("--quiet", action="store_true", help="suppress progress on stderr")
    p.add_argument("--version", action="version", version=f"btct-webrecon {__version__}")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    target = _norm_target(args.target)

    def log(*a):
        if not args.quiet:
            print(*a, file=sys.stderr, flush=True)

    doc = run_scan(target, args, log=log)

    if args.ship:
        if not args.server or not args.token:
            print("--ship requires --server and --token", file=sys.stderr)
            return 2
        from .shipper import ship
        try:
            res = ship(args.server, args.token, doc, workspace=args.workspace,
                       site_map_id=args.site_map_id, name=args.name)
            log(f"[+] shipped: {res}")
        except Exception as e:  # noqa: BLE001 - report and exit non-zero
            print(f"ship failed: {e}", file=sys.stderr)
            return 1

    if args.emit_json or not args.ship:
        json.dump(doc, sys.stdout)
        sys.stdout.write("\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
