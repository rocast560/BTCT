# btct-webrecon

A stdlib-only web reconnaissance agent for BTCT. It maps a target website
(crawl and link graph, subdomains, endpoints, API routes) into the "BTCT
sitemap JSON v1" document, which BTCT imports into a **Web Map** tab.

The core is self-contained (Python 3, `urllib` + `html.parser` + crt.sh, no
third-party packages). It also auto-detects and folds in installed tools when
they are present, so a full Kali box produces a richer map with the same command.

> Only scan targets you are authorized to test. This tool sends real requests
> to the target and to public services (crt.sh). It respects the scope you give
> it (the target host and its subdomains) and never scans anything else.

## Requirements

Python 3.8+. No packages to install. Copy the `btct_webrecon/` folder to your
box (or the whole `webrecon-agent/` directory) and run it as a module.

## Usage

Emit the document to a file, then import it in BTCT (Web Map tab, "Import"):

```
python3 -m btct_webrecon https://example.com --emit-json > example.json
```

Ship it straight to BTCT (admin enables ingest and gives you the token):

```
python3 -m btct_webrecon https://example.com --ship \
    --server https://btct.example --token btct_ing_... --map "Example"
```

Merge into an existing map instead of creating one with `--site-map-id <id>`.

### Options

| Flag | Meaning |
|---|---|
| `--emit-json` | print the document to stdout (default when not shipping) |
| `--ship` | POST the document to `<server>/api/webrecon/ingest` |
| `--server`, `--token` | BTCT base URL and ingest bearer token (for `--ship`) |
| `--workspace` | target workspace id (for `--ship`) |
| `--map` | name for a new web map (for `--ship`) |
| `--site-map-id` | merge into an existing map instead of creating one |
| `--max-pages` | crawl page budget (default 200) |
| `--depth` | crawl depth (default 4) |
| `--rate` | delay between requests, in seconds |
| `--timeout` | overall wall-clock budget, in seconds (default 120) |
| `--no-probe`, `--no-api`, `--no-subdomains`, `--no-tools`, `--no-crawl` | turn off a phase |
| `--quiet` | suppress progress on stderr (stdout stays clean JSON) |

## What it collects

- **Crawl and link graph**: same-scope pages, forms (with input names as
  parameters), linked JavaScript, redirects, and off-scope links (as `external`
  nodes). Seeds from `robots.txt` and `sitemap.xml`.
- **Endpoints and paths**: a built-in high-signal common-path probe. Install a
  wordlist (`BTCT_WORDLIST=...` or a common Kali path) plus `ffuf`,
  `feroxbuster`, or `gobuster` for a full brute-force pass.
- **API surface**: OpenAPI/Swagger specs, a GraphQL introspection probe, and
  endpoints mined out of linked JavaScript.
- **Subdomains**: crt.sh certificate transparency (no API key). Also uses
  `subfinder` when present, and `httpx` to confirm liveness and grab titles.

### Auto-detected external tools

Each runs only if installed, and a failure never aborts the scan:
`subfinder`, `httpx`, `katana`, `gau` / `waybackurls`, `whatweb`, and
`ffuf` / `feroxbuster` / `gobuster` (with a wordlist). `nuclei` is intentionally
not auto-run (slow and template-dependent).

## Output format

The document is the seam every BTCT recon producer shares:

```json
{
  "version": 1,
  "tool": "btct-webrecon",
  "target": "https://example.com",
  "scannedAt": 1730000000000,
  "nodes": [
    { "key": "endpoint|GET|https://example.com/login",
      "type": "page|subdomain|endpoint|api|js|form|external|root",
      "url": "...", "method": "GET", "status": 200, "contentType": "text/html",
      "title": "...", "size": 1234, "params": ["id"], "sources": ["crawl"],
      "tags": ["login"], "notes": "" }
  ],
  "edges": [
    { "source": "<node key>", "target": "<node key>",
      "kind": "link|redirect|hierarchy|form-action|api-ref", "label": "" }
  ]
}
```

Re-running against the same map merges by each node's `key`, so nodes are
updated in place rather than duplicated.

## Tests

```
python3 -m unittest discover -s tests
```
