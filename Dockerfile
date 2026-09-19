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
# Stage 3: minimal runtime image. Server code + server node_modules +
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
    BACKUP_DIR=/backups

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
