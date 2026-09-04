"""Thin urllib helpers + scope math. stdlib only."""
from __future__ import annotations

import gzip
import io
import urllib.error
import urllib.request
from typing import Dict, NamedTuple, Optional
from urllib.parse import urlparse, urlsplit

USER_AGENT = "btct-webrecon/1.0 (+https://github.com/; authorized testing only)"
DEFAULT_MAX_BYTES = 2 * 1024 * 1024


class HttpResult(NamedTuple):
    status: int
    headers: Dict[str, str]
    body: bytes
    final_url: str

    @property
    def content_type(self) -> str:
        return (self.headers.get("content-type", "").split(";")[0]).strip().lower()

    def text(self, limit: int = DEFAULT_MAX_BYTES) -> str:
        return self.body[:limit].decode("utf-8", "replace")


def fetch(url: str, method: str = "GET", timeout: float = 10.0,
          max_bytes: int = DEFAULT_MAX_BYTES, data: Optional[bytes] = None,
          extra_headers: Optional[Dict[str, str]] = None) -> Optional[HttpResult]:
    """Fetch a URL, following redirects. Returns None only on a hard network
    error; HTTP error responses (4xx/5xx) come back as a normal result."""
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Encoding": "gzip"}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return _read(resp, max_bytes)
    except urllib.error.HTTPError as e:
        try:
            return _read(e, max_bytes, status=e.code, final_url=url)
        except Exception:
            return HttpResult(e.code, _lower_headers(getattr(e, "headers", {})), b"", url)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _lower_headers(h) -> Dict[str, str]:
    out: Dict[str, str] = {}
    try:
        for k, v in h.items():
            out[str(k).lower()] = str(v)
    except Exception:
        pass
    return out


def _read(resp, max_bytes: int, status: Optional[int] = None, final_url: Optional[str] = None) -> HttpResult:
    raw = resp.read(max_bytes + 1)
    hdrs = _lower_headers(resp.headers)
    if hdrs.get("content-encoding", "").lower() == "gzip":
        try:
            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read(max_bytes + 1)
        except Exception:
            pass
    code = status if status is not None else getattr(resp, "status", resp.getcode())
    furl = final_url or (resp.geturl() if hasattr(resp, "geturl") else "")
    return HttpResult(int(code), hdrs, raw[:max_bytes], furl or "")


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def registrable_domain(host: str) -> str:
    """Naive eTLD+1 (last two labels). Good enough for a scan's default scope;
    multi-part TLDs like co.uk over-broaden slightly, which is acceptable."""
    parts = [p for p in host.split(".") if p]
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def in_scope(url: str, base_host: str, include_subdomains: bool = True) -> bool:
    host = host_of(url)
    if not host:
        return False
    if host == base_host:
        return True
    if include_subdomains:
        base = registrable_domain(base_host)
        return host == base or host.endswith("." + base)
    return False


def scheme_of(url: str) -> str:
    try:
        return urlparse(url).scheme.lower()
    except ValueError:
        return ""
