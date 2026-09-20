# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────
# Stage 1: build the Vite client.
# ─────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3 AS client-build
WORKDIR /app

# Install client deps using the lockfile for reproducible builds.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the client source and build. No VITE_API_URL / VITE_WS_URL is set
# here: the client falls back to same-origin at runtime, which is what
# the single-container deployment uses.
COPY tsconfig.json vite.config.ts vite-env.d.ts index.html ./
COPY public ./public
COPY src ./src
COPY scripts ./scripts
# Type declarations for the pure server modules that src/test imports
# (scheduler, backup-format). `bun run build` runs tsc over the tests too,
# so the .d.mts files must exist here even though the server itself is
# built in a later stage.
COPY server/*.d.mts ./server/
COPY server/typst/*.d.mts ./server/typst/
RUN bun scripts/fonts.ts && bun run build

# `public/fonts` is dockerignored, so the fonts here were fetched from the
# CDN by the step above rather than copied from a developer's machine. A
# missing font is not visible at runtime (the static handler answers with
# index.html and the compiler reports a parser error), so fail the build
# instead. Keep this ahead of the gzip step below, which leaves a `.gz`
# sibling next to each font and would make the count 34.
RUN test "$(ls dist/fonts | wc -l)" -eq 17

# Precompress the compressible static files so the server can hand a
# `file.gz` sibling to any client that accepts gzip (see tryServeStatic).
# Compress both the small startup bundles and the optional report compiler,
# with zero per-request CPU spent compressing.
RUN cd dist && find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.wasm' -o -name '*.json' -o -name '*.otf' -o -name '*.ttf' \) -size +1k -exec gzip -k -9 {} \;

# ─────────────────────────────────────────────────────────────────────────
# Stage 2: install the server's runtime deps in isolation.
# ─────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3 AS server-deps
WORKDIR /server
COPY server/package.json server/bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# ─────────────────────────────────────────────────────────────────────────
# Stage 3: the typst compiler. It is only ever spawned when ENABLE_TYPST=1,
# but it ships by default so turning the flag on is a restart rather than a
# rebuild. The archive is pinned by version and by sha256.
# ─────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS report-bins

# THE TWO DIGESTS BELOW ARE TRUST-ON-FIRST-USE, recorded 2026-09-19.
# The project publishes no signed checksum file, so they were computed from
# the release artefacts the first build downloaded and cross-checked against
# the digest GitHub's own release API reports for the same assets. That makes
# them an integrity control (the build fails if those bytes ever change) and
# not an authenticity one.
#
# TO BUMP THE VERSION: change the ARG, run the build, let the sha256sum step
# fail and print the digest it saw. Before pasting that digest in, check it
# out of band against the release asset itself:
#
#   gh api repos/typst/typst/releases/tags/v<X> --jq '.assets[] | {name, digest}'
#
# Then update the date on this comment. The bump also invalidates a measured
# safety property, so it is not only a version change: re-run the SVG href
# checks in docs/typst-tab-2026-09.md. A staged SVG is never sized, and that
# is safe only because usvg resolves an href for exactly <image> and
# <feImage> and typst refuses http, file and out-of-root hrefs inside an SVG.
ARG TYPST_VERSION=0.14.2
ARG TARGETARCH

# A box that will never export can build without the export tools and save
# the measured size: `--build-arg WITH_REPORT_BINS=0`. The server still
# starts, the capabilities route reports both false, the buttons do not
# appear and the export routes answer 501.
ARG WITH_REPORT_BINS=1

RUN set -eu; \
    mkdir -p /out; \
    [ "${WITH_REPORT_BINS}" = "1" ] || exit 0; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    [ "${WITH_REPORT_BINS}" = "1" ] || exit 0; \
    case "${TARGETARCH:-amd64}" in \
      amd64) T=x86_64-unknown-linux-musl; \
        TS=a6044cbad2a954deb921167e257e120ac0a16b20339ec01121194ff9d394996d;; \
      arm64) T=aarch64-unknown-linux-musl; \
        TS=491b101aa40a3a7ea82a3f8a6232cabb4e6a7e233810082e5ac812d43fdcd47a;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1;; \
    esac; \
    curl -fsSL -o /tmp/typst.tar.xz "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${T}.tar.xz"; \
    echo "${TS}  /tmp/typst.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/typst.tar.xz -C /tmp; \
    install -m 0755 "/tmp/typst-${T}/typst" /out/typst; \
    rm -rf /tmp/typst.tar.xz "/tmp/typst-${T}"; \
    /out/typst --version

# ─────────────────────────────────────────────────────────────────────────
# Stage 3b: the Word converter's Python environment. The DOCX export turns
# the finished PDF into Word with pdf2docx (server/typst/pdf-to-docx), which
# needs a real Python. It is built on the runtime's own base image so the
# virtualenv's interpreter symlink resolves to the same /usr/bin/python3
# there, and it is copied over whole.
#
# TO BUMP A PIN: edit server/typst/pdf-to-docx/requirements.txt. The hashes
# are what `pip-compile --generate-hashes` produced for pdf2docx's whole
# dependency tree, so regenerate the file rather than editing one line:
#
#   docker run --rm oven/bun:1.3-slim sh -c 'apt-get update >/dev/null && \
#     apt-get install -y --no-install-recommends python3 python3-venv >/dev/null && \
#     python3 -m venv /v && /v/bin/pip install -q pip-tools && \
#     echo pdf2docx==<X> > /req.in && \
#     /v/bin/pip-compile --generate-hashes --no-header -o /dev/stdout /req.in'
#
# Then re-run server/typst/pdf-to-docx/test_convert.py and compare.ps1
# against a real report: the band and table-of-contents repairs are written
# against what pdf2docx produces, and a new version can change that.
# ─────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim AS pdf2docx-venv
ARG WITH_REPORT_BINS=1
COPY server/typst/pdf-to-docx/requirements.txt /tmp/requirements.txt
RUN set -eu; \
    mkdir -p /opt/pdf2docx; \
    [ "${WITH_REPORT_BINS}" = "1" ] || exit 0; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 python3-venv; \
    rm -rf /var/lib/apt/lists/*; \
    python3 -m venv /opt/pdf2docx; \
    /opt/pdf2docx/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes -r /tmp/requirements.txt; \
    /opt/pdf2docx/bin/python -I -c "import pdf2docx"; \
    find /opt/pdf2docx -depth -name __pycache__ -type d -exec rm -rf {} +; \
    /opt/pdf2docx/bin/python -c "import pdf2docx, pymupdf, docx"
# pip compiles everything it installs, which is bytecode for hundreds of
# modules the converter never loads; the line above throws that away and then
# imports once to put back only what it does load. The export child runs with
# -B, so without this it would recompile pymupdf, numpy and OpenCV on every
# export, on the one core it is allowed.

# ─────────────────────────────────────────────────────────────────────────
# Stage 4: minimal runtime image. Server code + server node_modules +
# the built client. Runs as a non-root user; persistent SQLite goes to
# /data which is the standard volume mount point.
# ─────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/dist \
    DB_PATH=/data/data.sqlite \
    BACKUP_DIR=/backups \
    PDF2DOCX_PYTHON=/opt/pdf2docx/bin/python

# Copy server source + its node_modules. Ownership is set as each layer is
# written: a later `chown -R … /app` would rewrite every file and duplicate
# the whole 55.6 MB dist layer in the image.
COPY --from=server-deps --chown=bun:bun /server/node_modules /app/server/node_modules
COPY --chown=bun:bun server/package.json /app/server/package.json
COPY --chown=bun:bun server/index.mjs   /app/server/index.mjs
COPY --chown=bun:bun server/auth.mjs    /app/server/auth.mjs
COPY --chown=bun:bun server/db.mjs      /app/server/db.mjs
COPY --chown=bun:bun server/yjs-data.mjs /app/server/yjs-data.mjs
COPY --chown=bun:bun server/assets.mjs  /app/server/assets.mjs
COPY --chown=bun:bun server/cmdlog.mjs  /app/server/cmdlog.mjs
COPY --chown=bun:bun server/scheduler.mjs     /app/server/scheduler.mjs
COPY --chown=bun:bun server/backup-format.mjs /app/server/backup-format.mjs
COPY --chown=bun:bun server/data-export.mjs   /app/server/data-export.mjs
COPY --chown=bun:bun server/backup.mjs        /app/server/backup.mjs
COPY --chown=bun:bun server/restore.mjs       /app/server/restore.mjs
COPY --chown=bun:bun server/history.mjs       /app/server/history.mjs
COPY --chown=bun:bun server/history-diff.mjs  /app/server/history-diff.mjs
COPY --chown=bun:bun server/retention.mjs     /app/server/retention.mjs

# The server-side report export (ENABLE_TYPST=1). The whole server/typst/
# directory is copied rather than a line per file, so a new module there
# cannot be forgotten; the cost is the .d.mts declarations, bake.check.mjs
# and the converter's developer tools, a few kilobytes the runtime never
# loads.
ARG WITH_REPORT_BINS=1
COPY --from=report-bins /out/ /usr/local/bin/
COPY --from=pdf2docx-venv /opt/pdf2docx /opt/pdf2docx
COPY --chown=bun:bun server/typst/ /app/server/typst/
# The crop and blur math the browser uses, imported by server/typst/bake.mjs
# rather than copied, so a redaction bakes with the same numbers the preview
# drew. The list comes from reading those imports and then the imports of
# each file named: blur-math and crop-math take only types (erased by Bun)
# and image-format takes nothing. cwd is /app/server, so ../../src/lib from
# /app/server/typst resolves here. A new src/lib import under server/typst/
# needs a name on this line.
COPY --chown=bun:bun src/lib/blur-math.ts src/lib/crop-math.ts src/lib/image-format.ts /app/src/lib/
# The Python the virtualenv's interpreter symlink points at. python3 is the
# smallest package that brings a working standard library on Debian trixie;
# python3-minimal alone leaves out modules pdf2docx imports.
RUN set -eu; \
    if [ "${WITH_REPORT_BINS}" = "1" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends python3; \
      rm -rf /var/lib/apt/lists/*; \
    fi
# Fail the build here rather than at somebody's first export. Skipped, not
# relaxed, when the export tools were deliberately left out.
RUN if [ "${WITH_REPORT_BINS}" = "1" ]; then typst --version && /opt/pdf2docx/bin/python -I -B -c "import pdf2docx; print('pdf2docx ok')"; \
    else echo "report tools left out (WITH_REPORT_BINS=0): server export is unavailable"; fi

# Copy the static client build.
COPY --from=client-build --chown=bun:bun /app/dist /app/dist

# Persistent volume for SQLite + Yjs + assets, and the backup folder the
# compose file bind-mounts from the host (created here so a run without the
# mount still has somewhere writable). Only these two need the recursive
# chown: everything under /app arrived owned by bun already.
RUN mkdir -p /data /backups && chown -R bun:bun /data /backups
VOLUME ["/data"]
USER bun

EXPOSE 8080

# Healthcheck hits /healthz on the configured port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

WORKDIR /app/server
CMD ["bun", "run", "index.mjs"]
