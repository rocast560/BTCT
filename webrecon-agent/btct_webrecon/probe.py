"""Built-in common-path probe: the stdlib "endpoints / dir brute" capability.
A modest, high-signal wordlist of interesting paths, probed against the root.
For a full wordlist run, install ffuf/feroxbuster/gobuster (see tools.py)."""
from __future__ import annotations

import time
from urllib.parse import urljoin, urlsplit

from .httputil import fetch
from .model import Collector, node_key

COMMON_PATHS = [
    "/admin", "/administrator", "/login", "/logout", "/register", "/dashboard",
    "/api", "/api/", "/api/v1", "/api/v2", "/rest", "/graphql", "/swagger-ui",
    "/swagger-ui.html", "/openapi.json", "/swagger.json", "/api-docs",
    "/actuator", "/actuator/health", "/actuator/env", "/health", "/status",
    "/metrics", "/debug", "/console", "/server-status", "/phpinfo.php",
    "/.env", "/.git/", "/.git/config", "/.svn/", "/.htaccess", "/web.config",
    "/config.json", "/config.php", "/backup", "/backup.zip", "/db.sql",
    "/wp-admin/", "/wp-login.php", "/xmlrpc.php", "/phpmyadmin/", "/adminer.php",
    "/uploads/", "/static/", "/assets/", "/files/", "/tmp/", "/private/",
    "/robots.txt", "/sitemap.xml", "/crossdomain.xml", "/.well-known/security.txt",
    "/favicon.ico", "/README.md", "/CHANGELOG.md", "/LICENSE", "/package.json",
    "/user", "/users", "/account", "/settings", "/profile", "/search",
]

# 2xx on one of these means a likely-sensitive exposure worth flagging.
SENSITIVE = {"/.env", "/.git/config", "/config.json", "/config.php", "/backup.zip",
             "/db.sql", "/actuator/env", "/phpinfo.php"}

INTERESTING = {200, 201, 204, 301, 302, 401, 403, 405, 500}


def probe_common_paths(col: Collector, root: str, timeout: float = 8.0, delay: float = 0.0) -> int:
    root_key = node_key("root", root)
    found = 0
    for path in COMMON_PATHS:
        res = fetch(urljoin(root, path), timeout=timeout)
        if delay:
            time.sleep(delay)
        if not res or res.status not in INTERESTING:
            continue
        p = urlsplit(urljoin(root, path)).path.lower()
        ntype = "api" if any(seg in p for seg in ("/api", "/graphql", "/swagger", "/openapi", "/actuator", "/api-docs")) else "endpoint"
        tags = ["probe"]
        if path in SENSITIVE and res.status in (200, 201):
            tags.append("sensitive")
        n = col.add(ntype, urljoin(root, path), status=res.status,
                    content_type=res.content_type, size=len(res.body),
                    source="probe", tags=tags)
        col.edge(root_key, n.key, "hierarchy")
        found += 1
    return found
