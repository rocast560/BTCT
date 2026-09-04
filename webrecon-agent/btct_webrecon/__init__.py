"""btct-webrecon: a stdlib-only web reconnaissance agent for BTCT.

Maps a target website (crawl + link graph, subdomains, endpoints, API routes)
into the "BTCT sitemap JSON v1" document, which BTCT imports into a Web Map tab.
The core is self-contained (urllib + html.parser + crt.sh); it also auto-detects
and folds in installed Kali tools (subfinder, httpx, katana, gau, ffuf,
feroxbuster, gobuster, whatweb, nuclei) when present.

Only scan targets you are authorized to test.
"""

__version__ = "1.0.0"
