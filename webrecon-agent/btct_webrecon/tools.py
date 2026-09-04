"""Auto-detect and fold in installed Kali recon tools. Every wrapper is guarded
by shutil.which and wrapped in try/except: a missing or misbehaving tool is
skipped with a note, never fatal. Output is normalized into the same Collector
as the built-in engine, tagged with its source tool.

Deliberately NOT auto-run: nuclei (slow, template-dependent) and full
directory brute-forcers without a wordlist. ffuf/feroxbuster/gobuster run only
when a wordlist is available (via BTCT_WORDLIST or a common Kali path)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import List, Optional
from urllib.parse import urlsplit

from .httputil import in_scope, registrable_domain
from .model import Collector, node_key

WORDLIST_ENV = "BTCT_WORDLIST"
COMMON_WORDLISTS = [
    "/usr/share/seclists/Discovery/Web-Content/common.txt",
    "/usr/share/wordlists/dirb/common.txt",
    "/usr/share/dirb/wordlists/common.txt",
]


def _run(cmd: List[str], timeout: float, stdin: Optional[str] = None) -> Optional[str]:
    try:
        p = subprocess.run(
            cmd, input=stdin, capture_output=True, text=True, timeout=timeout,
        )
        return p.stdout
    except (subprocess.SubprocessError, OSError):
        return None


def available_tools() -> List[str]:
    names = ["subfinder", "httpx", "katana", "gau", "waybackurls",
             "whatweb", "ffuf", "feroxbuster", "gobuster", "nuclei", "amass"]
    return [n for n in names if shutil.which(n)]


def run_subfinder(col: Collector, root: str, base_host: str, timeout: float = 60.0) -> int:
    if not shutil.which("subfinder"):
        return 0
    domain = registrable_domain(base_host)
    out = _run(["subfinder", "-d", domain, "-silent"], timeout)
    if not out:
        return 0
    root_key = node_key("root", root)
    n = 0
    for line in out.splitlines():
        host = line.strip().lower()
        if not host or "." not in host:
            continue
        node = col.add("subdomain", "https://" + host, source="subfinder", tags=["subdomain"])
        col.edge(root_key, node.key, "hierarchy")
        n += 1
    return n


def run_httpx(col: Collector, base_host: str, include_subdomains: bool, timeout: float = 90.0) -> int:
    """Probe every subdomain node with httpx to confirm liveness + grab title."""
    if not shutil.which("httpx"):
        return 0
    urls = [n.url for n in col.nodes() if n.type == "subdomain"]
    if not urls:
        return 0
    out = _run(["httpx", "-silent", "-json", "-status-code", "-title", "-content-type"],
               timeout, stdin="\n".join(urls))
    if not out:
        return 0
    enriched = 0
    for line in out.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        url = row.get("url") or row.get("input") or ""
        if not url:
            continue
        n = col.add("subdomain", url, source="httpx")
        if row.get("status_code") or row.get("status-code"):
            n.status = int(row.get("status_code") or row.get("status-code"))
        if row.get("title"):
            n.title = str(row["title"])[:200]
        ct = row.get("content_type") or row.get("content-type")
        if ct:
            n.content_type = str(ct).split(";")[0].strip().lower()
        _tag(n, "live")
        enriched += 1
    return enriched


def run_katana(col: Collector, root: str, base_host: str, include_subdomains: bool, timeout: float = 90.0) -> int:
    if not shutil.which("katana"):
        return 0
    out = _run(["katana", "-u", root, "-jsonl", "-silent", "-d", "3"], timeout)
    if not out:
        return 0
    root_key = node_key("root", root)
    n = 0
    for line in out.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        url = row.get("endpoint") or (row.get("request", {}) or {}).get("endpoint") or ""
        if not url or not in_scope(url, base_host, include_subdomains):
            continue
        path = urlsplit(url).path.lower()
        ntype = "api" if any(s in path for s in ("/api", "/graphql", "/rest")) else "endpoint"
        node = col.add(ntype, url, source="katana", tags=["crawled"])
        col.edge(root_key, node.key, "link")
        n += 1
    return n


def run_historical(col: Collector, root: str, base_host: str, include_subdomains: bool, timeout: float = 60.0) -> int:
    """gau or waybackurls: historical URLs from public archives."""
    tool = "gau" if shutil.which("gau") else ("waybackurls" if shutil.which("waybackurls") else None)
    if not tool:
        return 0
    domain = registrable_domain(base_host)
    out = _run([tool, domain], timeout, stdin=domain if tool == "waybackurls" else None)
    if not out:
        return 0
    root_key = node_key("root", root)
    n = 0
    for line in out.splitlines()[:3000]:
        url = line.strip()
        if not url.lower().startswith(("http://", "https://")):
            continue
        if not in_scope(url, base_host, include_subdomains):
            continue
        path = urlsplit(url).path.lower()
        ntype = "api" if any(s in path for s in ("/api", "/graphql", "/rest")) else "endpoint"
        node = col.add(ntype, url, source=tool, tags=["historical"])
        col.edge(root_key, node.key, "link")
        n += 1
        if n >= 2000:
            break
    return n


def run_whatweb(col: Collector, root: str, timeout: float = 30.0) -> int:
    if not shutil.which("whatweb"):
        return 0
    out = _run(["whatweb", "--no-errors", "--color=never", root], timeout)
    if not out:
        return 0
    root_node = col.node("root", root)
    techs = []
    for chunk in out.replace("\n", ",").split(","):
        c = chunk.strip()
        if not c or "http" in c.lower() or c.startswith("["):
            continue
        name = c.split("[")[0].strip()
        if name and len(name) < 40:
            techs.append(name)
    _tags(root_node, techs[:20])
    return len(techs)


def _wordlist() -> Optional[str]:
    env = os.environ.get(WORDLIST_ENV)
    if env and os.path.isfile(env):
        return env
    for path in COMMON_WORDLISTS:
        if os.path.isfile(path):
            return path
    return None


def run_dirbrute(col: Collector, root: str, timeout: float = 120.0) -> int:
    """Run ffuf/feroxbuster/gobuster only when a wordlist is available."""
    wl = _wordlist()
    if not wl:
        return 0
    root_key = node_key("root", root)
    lines: List[str] = []
    if shutil.which("feroxbuster"):
        out = _run(["feroxbuster", "-u", root, "-w", wl, "--silent", "-d", "1",
                    "--time-limit", f"{int(timeout)}s"], timeout + 10)
        if out:
            lines = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("http")]
    elif shutil.which("ffuf"):
        out = _run(["ffuf", "-u", root.rstrip("/") + "/FUZZ", "-w", wl, "-of", "json",
                    "-o", "/dev/stdout", "-s"], timeout)
        if out:
            try:
                for r in (json.loads(out).get("results") or []):
                    if r.get("url"):
                        lines.append(r["url"])
            except ValueError:
                pass
    elif shutil.which("gobuster"):
        out = _run(["gobuster", "dir", "-u", root, "-w", wl, "-q", "--no-error"], timeout)
        if out:
            for ln in out.splitlines():
                part = ln.strip().split()
                if part:
                    lines.append(root.rstrip("/") + "/" + part[0].lstrip("/"))
    n = 0
    for url in lines[:2000]:
        node = col.add("endpoint", url, source="dirbrute", tags=["brute"])
        col.edge(root_key, node.key, "hierarchy")
        n += 1
    return n


def _tag(node, tag: str) -> None:
    if tag and tag not in node.tags and len(node.tags) < 64:
        node.tags.append(tag)


def _tags(node, tags) -> None:
    for t in tags:
        _tag(node, str(t))
