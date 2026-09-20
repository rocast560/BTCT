# What the Typst report tab costs, measured (2026-09-19)

## What this is, and why it is behind a flag

BTCT used to have a Typst report tab. It was cut in the lightweight pass,
along with the graph canvas and the assistant, because the three
`@myriaddreamin/typst*` packages drag 29.3 MB of WebAssembly into the build and
the target box has 1 GB of RAM. The report is still the reason the notes exist,
so it is back, but only for a server started with `ENABLE_TYPST=1`. Everyone
else must keep paying nothing for it.

"Nothing" needs a number, so this is that number. Every figure below came out
of a command I ran on this machine; where I could not measure something I say
so instead of guessing.

## How I measured

- **Machine**: Windows 11, Docker Desktop on WSL2, Chrome 153 headless driven
  over raw CDP. Scripts lived in a scratch folder, never in the repo.
- **Before** is commit `5113732` ("Add design spec for the flag-gated Typst
  report tab"), the last commit with no feature code. I built it from a
  `git worktree` outside the repo so the working tree was never touched.
  **After** is `a530788`, the eighth and last task's parent.
- **Docker**: throwaway image tags (`btct-measure:before` / `:after`), throwaway
  containers run with `--memory 1g --cpus 2` (the target box, not a margin) and
  a throwaway volume each, published on `127.0.0.1` loopback ports. One at a
  time. Everything I created was removed afterwards.
- **Client builds** are `bun install && bun run build` in each tree. Image
  builds are a plain `docker build` of each tree.

## Results

| Metric | Before | After | Pass condition | Result |
|---|---|---|---|---|
| Entry bundle, gzipped bytes | 87,786 | 88,385 (+599) | within 1 KB | **PASS** |
| Flag-off idle memory, three samples | 25.99 / 25.84 / 25.79 MiB | 25.75 / 25.59 / 25.58 MiB | no measurable change | **PASS** |
| Flag-off requests for wasm, fonts, Typst chunks | n/a | 0 of 47 | zero | **PASS** |
| `dist/` bytes | 4,739,426 (230 files) | 43,066,989 (274 files) | recorded | +38,327,563 |
| Typst-only files in `dist/` | n/a | 38,292,537 raw, 16,965,056 gzipped | recorded | see breakdown |
| Image size (`docker images`) | 314MB | 494MB | recorded | +180MB |
| Flag-on first open of the tab | n/a | 17,072,528 B over 37 requests | recorded | about 17 MB, then cached |

### Entry bundle

```
$ (cd ../btct-measure-before && gzip -9 -c dist/assets/index-*.js | wc -c)
87786
$ gzip -9 -c dist/assets/index-*.js | wc -c
88385
```

599 bytes, which is the `typst` field in the feature switches, `features.ts`
itself, the store's `featuresLoaded` flag, `typstTabState`, the off notice, and
the three gated entry points. Under the 1 KB gate with room to spare. The
compiler is not in there, and the grep that proves it still finds nothing:

```
$ grep -l "typst_ts_web_compiler" dist/assets/index-*.js
(no output, exit 1)
```

### `dist/`

```
$ du -sb dist          # before / after
4739426  dist
43066989 dist
```

The Typst-only part of that, raw and gzipped at level 9:

| Group | Files | Raw | Gzipped |
|---|---|---|---|
| Compiler + renderer wasm | 2 | 29,297,603 | 11,122,880 |
| Default fonts (`dist/fonts/`) | 17 | 8,713,432 | 5,763,710 |
| Typst JS chunks | 20 | 281,502 | 78,466 |
| **Total** | **39** | **38,292,537** | **16,965,056** |

The JS list is every new chunk stem in the after build except `mutex-*.js`,
`preload-helper-*.js`, and the `AssetsPanel` / `FigureViewport` /
`PlaceScreenshotDialog` chunks. Those are not Typst cost: they are code that
already existed and that the chunker split out once a second tab started
importing it, and the flag-off browser session below fetches `mutex-*.js`,
`AssetsPanel` and `FigureViewport` while opening an ordinary note. Counting
them would have inflated the figure by 87 kB.

Half of the Typst JS is emitted twice. `typst.ts` ships browser and node entry
points, so `dist/` holds two `compiler-*.js`, two `renderer-*.js`, two
`esm-*.js`, four `wasm-pack-shim-*.js` and so on, of which one variant is ever
loaded. I counted all of them, because all of them are in the image.

### Image

```
$ docker images btct-measure:before --format '{{.Size}}'
314MB
$ docker images btct-measure:after --format '{{.Size}}'
494MB
```

`docker history` shows exactly two layers change, and they change by the same
amount:

```
before:  6.76MB  COPY /app/dist /app/dist
         26.6MB  RUN mkdir -p /data /backups && chown -R bun:bun /data /backups /app
after:   62.6MB  COPY /app/dist /app/dist
         82.4MB  RUN mkdir -p /data /backups && chown -R bun:bun /data /backups /app
```

Inside the containers, `du -sb /app/dist` reads 5,917,442 before and 61,528,590
after, so `dist` plus its precompressed `.gz` siblings grows by 55.6 MB. The
`chown -R` on the last line of the Dockerfile rewrites every file it touches
into a new layer, so it pays that 55.6 MB a second time. That is a
pre-existing property of the Dockerfile, not something this feature
introduced, but it is why the image grows by roughly twice what the feature
adds. Docker's own three size accountings disagree with each other here
(`docker images` says +180MB, summing the two changed history layers says
+111.6MB, `docker image inspect .Size` says +68.7MB); I trusted the `du` inside
the container and did not chase the rest.

### Flag-off idle memory

Each image run alone with `ENABLE_TYPST` unset, `--memory 1g --cpus 2`, two
idle minutes after `/healthz` answered, then three `docker stats --no-stream`
samples ten seconds apart:

```
before:  25.99MiB / 1GiB   25.84MiB / 1GiB   25.79MiB / 1GiB
after:   25.75MiB / 1GiB   25.59MiB / 1GiB   25.58MiB / 1GiB
```

The after image is 0.21 to 0.25 MiB *lower*, which is the honest way of saying
the difference is noise. Within one image the three samples already drift by
0.20 MiB (before) and 0.17 MiB (after) as the server settles, so a 0.2 MiB gap
between images is the same size as the drift inside each. That is the noise
floor I am calling it against: a difference smaller than the spread of
repeated samples of the same thing. This is also the result I expected, since
the server does not parse, read or serve anything differently with the flag
off. The feature is entirely client-side, and the client never asks for it.

### Flag-off network

Headless Chrome, clean profile, against the after image with the flag off
(`GET /api/settings` returned `"features":{"typst":false}`). I loaded the app,
opened the "Engagement Notes" page, typed into it, and opened the Assets tab.

```
window (149 events, 47 requests)
--- matching /wasm|\/fonts\/|[Tt]ypst/ : 0 ---
--- transferred total 0 B ---
```

Zero. The three entry points were absent from the overview, the sidebar and
the command palette, as expected.

### Flag-on first open

Same image, restarted with `ENABLE_TYPST=1`, fresh browser profile, empty
cache. I clicked the sidebar's Report row and let the preview paint.

| Group | Transferred (gzip, on the wire) |
|---|---|
| `typst_ts_web_compiler_bg-*.wasm` | 10,767,929 |
| `typst_ts_renderer_bg-*.wasm` | 355,437 |
| 17 fonts under `/fonts/` | 5,767,215 |
| JS chunks (TypstView, CodeMirror, the shims, the assets rail) | 181,947 |
| **Total, 37 requests** | **17,072,528 B (16.3 MiB)** |

So the honest headline is **about 17 MB on first open** (11.1 MB of wasm, 5.8
MB of fonts, 0.2 MB of JavaScript), not the 11 MB the plan guessed. One request, the dedicated worker's own script, never produced a
`Network.loadingFinished` event, so its 1,287 gzipped bytes are missing from
that total.

What happens on the second open depends on the path, and the two paths differ:

```
$ curl -sD - -o /dev/null .../assets/typst_ts_web_compiler_bg-D2mWRS72.wasm
Cache-Control: public, max-age=31536000, immutable
$ curl -sD - -o /dev/null .../fonts/NewCM10-Regular.otf
Cache-Control: no-cache
ETag: "586328-1789848150000"
$ curl -sD - -o /dev/null -H 'If-None-Match: "586328-1789848150000"' .../fonts/NewCM10-Regular.otf
HTTP/1.1 304 Not Modified
```

The wasm and the JS chunks have hashed filenames and are `immutable`, so they
are never requested again. The fonts are not hashed, so they get the server's
default `no-cache` plus a size-and-mtime ETag: a later load sends 17
conditional requests and gets 17 empty `304`s. That is 17 round trips rather
than 5.5 MB, and on a LAN it does not show, but it is not free the way the
wasm is. Giving the fonts hashed names would close it.

## What the browser pass found

These are not my numbers. They come from the Task 6 verification run against a
real server plus a scratch build, recorded in `task-6-verification.md`, and I
repeat them here so this document is the one place to look:

- First painted page **1256 ms** from the click (re-measured at 1279 ms, and
  1157 ms in a brand new browser context).
- Reopening a closed Report tab repaints from the render cache in **73 ms**,
  before any compile finishes.
- Collaboration between two browser contexts on the same report: **458 ms** one
  way, **471 ms** the other, with remote carets and selection ranges rendering.
- A redaction drawn with a real pointer drag survives into the exported PDF.
  Inflating the image XObject out of the 24,484-byte PDF, the redacted half of
  the figure measures 100% midtone with a standard deviation of 0, and the
  untouched half measures 127.5. The original pattern is not recoverable from
  the export.

My own flag-on run painted its first page **1050 ms** after the click, on a
document with no images, which is consistent with those.

## Things that did not work, or surprised me

- **The render cache never filled.** It was copied over with a write on
  `docKey` change, and in BTCT a mounted preview's `docKey` never changes,
  because switching workspaces empties the tab list and unmounts the preview
  instead of re-keying it. Every `get` missed and nothing was ever stored. The
  fix was an unmount-only effect that writes through refs. The 73 ms reopen
  above is the first measurement where the cache actually does anything.
- **`lib/assets.ts` is in the entry graph.** The old code read an uploaded
  font's family name there, with `await import('./typst-compiler')`. Vite emits
  a dynamic import's chunk *and* its wasm asset, so putting that back would
  have shipped 28 MB of WebAssembly into a flag-off build through a module the
  shell already loads. The family read moved into `TypstView`, which is itself
  a lazy chunk. This is the trap worth remembering: the gate is not "does the
  entry bundle contain the compiler", it is "can any module the shell loads
  reach it, even dynamically".
- **A persisted Report tab ignored the flag entirely.** Tabs live in
  `localStorage` independently of the feature switches, so a tab left open
  before the flag was turned off restored, mounted, and pulled the whole 36 MB
  payload on a server that reported `"typst":false`. It loaded cleanly, which
  is exactly why it was easy to miss. Pruning the tab was the wrong fix, since
  `features.typst` reads false for a moment on every boot and that would delete
  every flag-on operator's tab on every reload. The render is gated instead.
- **The gate was then fed the wrong flag.** The first version read the theme
  store's `loaded`, which also flips from the live `settingsPublic.theme`
  mirror. That mirror carries no feature data at all, so on a flag-on server an
  IndexedDB replay could make `loaded` true while `features.typst` was still
  the default false, and the operator would see "Report tab is turned off"
  flash, or stick. A separate `featuresLoaded`, set only inside the settings
  fetch, fixed it.
- **An 8px test pattern looks unredacted.** `pixelParams` floors the mosaic
  block at 8px, so a checkerboard with an 8px period maps each block onto one
  solid cell and a pixel test reports the image as untouched even though the
  redaction is applied correctly. The verification run lost time to this before
  regenerating the test image at 2px cells. Not a bug, but it will catch the
  next person too.
- **One feature of the old tab did not come back.** The removed version could
  expand the assets rail over the whole tab, with a `Maximize2` button in the
  panel header driving `assetsMax` / `toggleAssetsMax` / `hideAssets` in
  `TypstView` and `fullscreen` / `onToggleFullscreen` / `onHide` on the panel.
  Restoring it would have meant putting those three props on
  `AssetsPanel`'s new `typst` prop, and `AssetsPanel` is shared with the
  Assets Manager tab, so I left it out. The rail is still resizable by
  dragging its divider (double-click resets the default width) and still hides
  and shows from the Assets button in the tab's header, which is what the
  overlay was mostly used for. If it turns out to be missed, it is at git
  revision `8a549fb^`, in `src/components/typst/TypstAssetsPanel.tsx` and
  `src/components/typst/TypstView.tsx`.
- **The font build step was a no-op in Docker.** `scripts/fonts.ts` skips any
  font already on disk, and `public/fonts/` was gitignored but not
  dockerignored, so it rode into the build context and the script downloaded
  nothing. The image build printed `fonts: 17 files in /app/public/fonts` in
  0.3 s, which is what a working fetch and a skipped one look like from the
  outside. Fixed on 2026-09-19: `public/fonts` is dockerignored, the script
  runs at top level so a failure is a non-zero exit, each font is written
  under a `.partial` name and renamed, and the build asserts `dist/fonts`
  holds 17 files. See the proof build in the same day's fix wave.

## What the tab holds open, and when it lets go

While a Report tab is on screen the compiler worker holds the instantiated
compiler wasm (10.8 MB gzipped on the wire, 29.3 MB unpacked in `dist/`), the
renderer wasm, the 17 default faces it parsed at init, and one copy of the
bytes of every image in the workspace, as shadow files. The main thread holds
a second copy of those image bytes in `setTypstShadowFiles`, plus the rendered
SVG cache (capped at 4,000,000 chars, about 8 MB). I have not measured the
resident total in the tab process, so I am not going to quote a number for
it; what I can say is that it used to last for the life of the page. Closing
the tab freed none of it.

It now has a lease. `TypstView` calls `cancelTypstRelease()` when it mounts
and `scheduleTypstRelease()` when it unmounts, and five minutes later
`releaseTypstCompiler()` terminates the worker, rejects anything still in
flight, and drops the fonts and shadow files along with the bookkeeping that
says the worker already has them. The next compile starts a fresh worker and
re-sends both sets, which the tab's asset sync effect has already refilled on
mount.

Five minutes rather than "on unmount" because a pane renders only its active
tab: flicking between the report and a note unmounts the view every time. An
immediate release would turn every one of those switches back into the cold
open measured above, 1050 to 1256 ms to a painted page plus 17 font
revalidations, instead of the 73 ms repaint from the render cache. The render
cache is deliberately not part of the release, which is what makes that 73 ms
possible while the replacement worker is still starting.

## What is still open

- **Steps 2 to 4 of the plan are not implemented.** Server-side PDF and DOCX
  export, an MCP surface for the report, and a notes reader that pulls page
  content into the document are separate later steps. Today the only export is
  the browser's own PDF or SVG.
- **The cosmetic VFS error.** The first compile after the wasm engine boots
  logs one `tinymist-vfs::ProxyAccessModel::read_all failure ... Dummy
  AccessModel` per cold tab open, on a document that references an image. The
  shadow files are staged before the compile, but not inside the wasm
  instance's VFS until it finishes initializing. It self-corrects on the next
  compile and nothing is visibly wrong. It should be silenced.
- **The font upload path is covered at its ends, not in its middle.**
  `src/test/assets-panel-fonts.test.tsx` renders `AssetsPanel` and pins the
  routing: a dropped `.ttf` is rejected in the Assets Manager and handed to
  `onAddFont` in the report rail, and neither path loads the placement
  dialog. What is still untested is what sits between that callback and the
  record: `TypstView`'s `addFont`, which reads the family name through
  `getFontInfo` and swallows a parse failure in a bare `catch`, and the
  store's `addTypstAsset` write of `fontFamily`. Both were verified by hand
  in a browser once. A font whose metadata will not parse degrades to the
  filename with the insert button disabled, which is the intended behaviour
  and also exactly what a silent breakage would look like, so that `catch` is
  the line worth a test.
- **Two `loadTheme()` calls in the same tick start two retry chains.** The
  guard in the settings retry clears a pending timer, which covers a retry
  that is already scheduled, but two calls that race before either has failed
  each schedule their own chain. In practice this is React StrictMode in dev
  double-invoking the effect; production calls it once. Parked knowingly.
- **The render cache is per page load.** It is module state, so a browser
  reload starts empty. Persisting a few MB of SVG per workspace in IndexedDB is
  not obviously worth it on a 1 GB box.
- **The fonts are not content-hashed**, so every load revalidates 17 of them.
  See the cache headers above.

## Server export (step 2), measured in the container

Step 1 compiled the report in the browser. Step 2 adds two buttons that do it
on the server instead: **PDF (server)**, which runs the `typst` CLI, and
**DOCX**, which runs `pandoc`. The point of the second one is that people ask
for Word files. The point of doing either on the server is the same thing that
makes this feature worth the trouble: the screenshots get their crops and
redactions burned into the pixels before anything converts them.

That means two binaries in the image and a jimp bake in the process that also
relays Yjs for the whole team, on a box with 1 GB of RAM. So here are the
numbers, from a `btct-measure:step2` image built from this tree and run with
`--memory 1g --cpus 2`, against `btct-measure:step1` built from commit
`24c7941` in a `git worktree` outside the repo. Nothing used the repo's compose
files; every container, volume and image I made is gone.

### Image size

| | step 1 (`24c7941`) | step 2 | delta |
|---|---|---|---|
| `docker images` SIZE | 418MB | 691MB | +273MB |
| `du -sm /` inside a container from the image | 283 MiB | 488 MiB | **+205 MiB** |

The two disagree and the second one is the honest number. Summing
`docker history` layer sizes gives 296 MB for step 1 and 511 MB for step 2,
which matches `du`; `docker images` SIZE under the containerd image store
counts something else. Every layer is byte-identical between the two images
except four:

```
215MB      COPY /usr/local/bin/typst /usr/local/bin/pandoc /usr/local/bin/
152kB      COPY --chown=bun:bun server/typst/ /app/server/typst/
77.8kB     COPY --chown=bun:bun src/lib/blur-math.ts src/lib/crop-math.ts ...
4.1kB      RUN typst --version && pandoc --version | head -1
```

Inside the image:

```
$ docker run --rm --entrypoint sh btct-measure:step2 -c "ls -l /usr/local/bin/typst /usr/local/bin/pandoc"
-rwxr-xr-x 1 root root 163653648 /usr/local/bin/pandoc
-rwxr-xr-x 1 root root  50889504 /usr/local/bin/typst
```

204.6 MiB of binary for 205 MiB of image, so the modules themselves are
rounding error. pandoc is three times the size of typst, which I did not
expect and cannot do anything about: it is a statically linked Haskell binary
carrying every reader and writer it has.

Both archives are pinned by version **and** by sha256 in the `report-bins`
stage. Neither project publishes a checksum file, so I downloaded the four
release artefacts (amd64 and arm64 of each), computed the digests and put them
in the Dockerfile; the build now fails if those bytes ever change. The build
log shows the verification and the versions, in the fetch stage and again in
the runtime stage, because typst's musl build is static while pandoc's linux
release links against glibc and the runtime base image is not the one that
fetched it:

```
#43 1.983 /tmp/typst.tar.xz: OK
#43 5.695 /tmp/pandoc.tar.gz: OK
#43 6.906 typst 0.14.2 (b33de9de)
#43 6.911 pandoc 3.11
#49 [runtime 22/25] RUN typst --version && pandoc --version | head -1
#49 0.289 typst 0.14.2 (b33de9de)
#49 0.298 pandoc 3.11
```

pandoc 3.11 is the newest release, and it is the version every earlier
measurement in this plan was taken against, so it is what I pinned. typst is
0.14.2 for the same reason.

### With the flag off, nothing changed

Both images, no `ENABLE_TYPST`, healthcheck green, two minutes idle, then three
`docker stats --no-stream` samples ten seconds apart:

| sample | step 1 | step 2 |
|---|---|---|
| 1 | 25.80 MiB | 26.12 MiB |
| 2 | 25.77 MiB | 26.02 MiB |
| 3 | 26.06 MiB | 26.05 MiB |
| cgroup `memory.peak` | 38,383,616 B | 39,555,072 B |

I treat anything inside the spread of one container's own samples as noise, and
that spread is 0.29 MiB for step 1. The gap between the two means is 0.18 MiB,
smaller than that, so: no measurable change. The binaries cost disk, not memory,
because nothing ever execs them.

Then six requests at the flag-off step 2 container, with an account token and
without one:

```
noauth  POST /api/typst/x/export?format=pdf          -> 404 in 0.005849s
token   POST /api/typst/x/export?format=pdf          -> 404 in 0.003905s
noauth  POST /api/typst/ws-main/export?format=docx   -> 404 in 0.004894s
token   POST /api/typst/ws-main/export?format=docx   -> 404 in 0.004364s
noauth  GET  /api/typst/capabilities                 -> 404 in 0.004376s
token   GET  /api/typst/capabilities                 -> 404 in 0.004278s
```

`memory.peak` read 39,555,072 before those six requests and 39,555,072 after,
to the byte, and `memory.current` went down rather than up. Nothing under
`server/typst/` was loaded and jimp was not either.

### With the flag on, one export each

A workspace with a short report: one 1920x1080 screenshot with a pixelate
redaction over its left half in a figure slot, plus a second slot whose caption
is computed rather than a string literal. Seeded through the websocket the way
a client does, with the image uploaded through `POST /api/assets`.

| | PDF | DOCX |
|---|---|---|
| status | 200 | 200 |
| wall time | 0.653 s | 0.383 s |
| output | 63,890 B, `%PDF-1.7` | 12,989 B, a real zip |
| `X-Baked-Images` | 1 | 1 |
| `X-Export-Warnings` | absent | one note (below) |
| container peak | 175,947,776 B (167.8 MiB) | 160,522,240 B (153.1 MiB) |

The DOCX header decodes to exactly what the feature promises to say out loud:

```
["Figure slot 2 (line 31): the caption is computed, so the Word file shows \"Figure\" instead."]
```

A 4K screenshot (3840x2160, 8.3 MP, the largest thing the 10 MP per-image cap
admits from a real display) with the same redaction: 200 in 1.211 s, 148,047 B,
one baked image, container peak 391,639,040 B (373.5 MiB). That is the case the
per-image cap was chosen to keep working, and it works with room left.

### The redaction still holds, in the container

The proof is the same correlation test `server/typst/bake.check.mjs` uses. I ran
the unmodified script from the Windows runs against the container's output, so
the number is directly comparable, and an adapted copy against the 1920x1080
screenshot the timings above used:

| | embedded image | correlation with the original, blurred half | unblurred half | original bytes in the PDF |
|---|---|---|---|---|
| 200x100 reference | 1,112 B vs 6,960 B uploaded | **0.033** (limit 0.25) | 0 pixels changed | absent |
| 1920x1080 | 11,720 B vs 706,682 B uploaded | **-0.000** | 0 pixels changed | absent |

"Original bytes absent" is a 64-byte slice of the source PNG's IDAT data,
searched for in the whole PDF, with a control that finds the same slice in the
source file. The larger screenshot scores better because the pixelate block is
larger relative to the 1 px noise, which is what you would want.

What that test proves is narrower than it looks, and the comment at the top of
`bake.check.mjs` now says so. A bake that does nothing scores 1.000 and a token
blur scores 0.464, so it catches a no-op and it catches an obviously weak
stand-in. It does **not** catch a weakened bake: a 2 px pixelate block scores
0.236 and a gaussian path that keeps the blur but drops the downscale scores
0.161, and both pass. The block-size floor and the downscale are what actually
make the pixels unrecoverable, and they are guarded by the unit tests over
`src/lib/blur-math.ts`, not by this correlation.

### Many screenshots in one export, and the reason it needs a budget

This is where the numbers stop being comfortable. Each image below is
3600x2700 (9.72 MP, just under the 10 MP per-image cap), with a pixelate
redaction, so every one goes through jimp in the server process.

| screenshots | total MP | result | wall | container peak | cgroup reclaim events |
|---|---|---|---|---|---|
| 12 | 116.6 | 200 | 11.09 s | 968,105,984 B (923 MiB) | 0 |
| 13 | 126.4 | **422**, the budget | 10.64 s | 868,937,728 B (829 MiB) | 0 |
| 32, with `TYPST_EXPORT_MAX_TOTAL_MP=400` | 311.0 | 200 | 30.08 s | **1,073,741,824 B, the limit exactly** | 3454 |

The 422 reads `This report places about 126 MP of screenshots and the server
exports up to 120 MP at once. Export the PDF from the browser instead, or raise
TYPST_EXPORT_MAX_TOTAL_MP on a server with more memory.`

Two things to say honestly about that table. First, the refusal is not cheap:
it took 10.64 seconds and 829 MiB, because the budget is counted as images are
staged, so twelve of them were read and baked before the thirteenth crossed the
line. On Windows, where the same test ran with unbaked images, the same refusal
took 24 to 38 ms. The cost is the baking, not the check.

Second, the last row is what the default protects against. With the budget
raised to 400 MP the export did finish, and the container was pinned at its
1 GiB ceiling for the whole thirty seconds, reclaiming 3454 times to stay
alive. `OOMKilled` was false and the container never restarted, so I cannot
report a kill. I can report that there was no headroom left at all, and that
the only reason nothing died is that most of what the kernel reclaimed was page
cache.

### The bake is the expensive half, and it stalls the relay

The question the security review could not settle on Windows: crops and blurs
run in the server process, Bun does not hand the memory back between images,
and that process is the Yjs relay. On Windows twelve sequential 10 MP bakes
took the server from 226 MB to a 1557 MB peak. Under a cgroup, JavaScriptCore
might collect much harder. It does, and it still is not enough.

Twelve distinct 3160x3160 screenshots (9.99 MP each, 119.8 MP in total, just
under the default budget), exported to PDF, with the bun process's own `VmRSS`
sampled every 50 ms and `/healthz` polled alongside:

| set | status | wall | container peak | bun process RSS peak | `/healthz` |
|---|---|---|---|---|---|
| 4, blurred | 200 | 4.53 s | 723,935,232 B (690 MiB) | 576,580 kB (563 MiB) | worst poll 3.586 s |
| 8, blurred | 200 | 8.69 s | 935,960,576 B (893 MiB) | 778,596 kB (760 MiB) | one poll timed out at 5 s, next took 1.925 s |
| 12, blurred | 200 | 12.89 s | **1,073,741,824 B, the limit** | **1,004,752 kB (981 MiB)** | **two consecutive polls timed out at 5 s**, next took 0.112 s |
| 12, no blur | 200 | 2.13 s | 704,593,920 B (672 MiB) | 104,224 kB (102 MiB) | worst poll 5.7 ms, no failures |

Nothing was OOM-killed in any run: `OOMKilled=false`, `RestartCount=0`, and
`memory.events` recorded `oom 0 oom_kill 0` throughout. The memory does come
back, which is the one piece of good news against the Windows result: two
minutes after the twelve-image run the bun process was at 97,888 kB (95.6 MiB)
and the cgroup at 59,314,176 B, so this is live working set, not a leak.

The last row is the control and it is the whole finding. The same twelve
pictures, the same compile, nothing redacted: 2.13 seconds instead of 12.89,
102 MiB of bun instead of 981, and a relay that never missed a beat. Every bit
of the cost is the bake. And the bake is synchronous JavaScript on the main
thread, so it does not merely use memory, it stops the event loop: at four
images one health check waited 3.6 seconds, at eight one gave up after 5, and at
twelve two in a row gave up after 5. For a Yjs relay that means every editor in
the workspace stops syncing for roughly ten seconds while somebody exports a
Word file.

So, plainly: **server export of many large redacted screenshots is not safe on a
1 GB box yet.** One or two of them is fine and fast, which is the ordinary case
and the one the buttons exist for. A dozen at the top of the per-image cap sits
at the container's memory ceiling and stalls collaboration for seconds at a
time, and the 120 MP budget that admits it was set from the compiler's cost, not
from the bake's. The budget stops the box dying; it does not stop it stuttering.
I am not changing a limit here on my own; the numbers are the point.

### The two hostile inputs, re-checked on Linux

The full attack table was run on Windows. Path forms differ on Linux, so two
spot checks. `/data/data.sqlite` inside the container really does start
`SQLite format 3` and `/etc/passwd` really does start `root:x:0:0`, so both
targets are live.

| input | PDF | DOCX |
|---|---|---|
| asset record with `id: '../data.sqlite'`, as a font, report reads `/fonts/stolen.sqlite` | 422 in 23.6 ms, `file not found (searched at ./fonts/stolen.sqlite)` | 422 in 21.0 ms, `File './fonts/stolen.sqlite' not found in resource path` |
| the same id as an image, report reads `/assets/stolen.png` | 422, `file not found (searched at ./assets/stolen.png)` | (same path) |
| `#raw(read("/etc/passwd"))` | 422 in 19.6 ms, `file not found (searched at ./etc/passwd)` | 422 in 19.9 ms, `File './etc/passwd' not found in resource path` |

The record is skipped by `vetAssetRecord` before any filesystem call, so the
file is never staged and typst reports an unresolved path against its own line.
Grepping every one of those response bodies, and both successful exports, for
`SQLite format`, `root:x:0:0` and `daemon:x:` finds nothing. The paths in the
messages are relative: the scrubber did its job and no temp directory or
account name leaked. No `/tmp/btct-typst-*` directory was left behind by any
run.

### Clicking the buttons

Driven through headless Chrome over raw CDP against the flag-on container, with
the account token injected into `localStorage`.

| check | verdict | evidence |
|---|---|---|
| Report tab opens from the sidebar | PASS | the sidebar's Report row is present and opens the tab |
| `DOCX` and `PDF (server)` are there | PASS | the toolbar's export buttons read `["SVG","PDF","DOCX","PDF (server)"]` |
| clicking DOCX downloads the file | PARTIAL | Chrome began a download named `ws-main.docx` and then reported it `canceled` with nothing written, which is this headless setup and not the app: the anchor the app clicked carried a 12,989-byte blob of the right Word MIME type, which I saved and unzipped to `word/media/rId9.png`, byte-identical to the image in the same export fetched over `curl` |
| the info banner names the computed caption | PASS | `Exported, with 1 note(s):` then `Line 31: the caption is computed, so the Word file shows "Figure" instead.` The ruling I was working from said "with 1 note:"; the app says "note(s)" |
| a broken report shows the Typst error with its line | PASS | after pushing `#nope` into the shared doc, `PDF (server)` produced the red banner `Typst error at main.typ:26: unknown variable: nope` |
| the busy label while converting | COULD NOT CHECK | I looked 600 ms after the click and the buttons were already back; the export takes 383 ms, so there is nothing to catch at this size |
| with the flag off, neither button exists | PASS | against the flag-off container the sidebar has no Report row at all, so there is no tab and no toolbar |

### What the security review found, and how it was closed

Five rounds. The three criticals were real holes in code I wrote, and each was
demonstrated against the shipped argv before it was fixed.

**An asset record's `id` was joined straight onto `ASSETS_DIR`.** The id comes
out of the CRDT, which any account can write, so `../data.sqlite` read the
database and `../../proc/self/environ` read `AUTH_SECRET`, which is enough to
forge an admin token. With `kind: 'font'` the record also skipped the reference
filter and the bake, so the bytes were copied into the compile root verbatim
and `#read()` put them in the PDF the caller downloads. The fix is
`vet-asset.mjs`: a uuid-shaped id, a resolved path whose parent is `ASSETS_DIR`
itself, a matching row in the server's own `assets` inventory, and `kind` plus
workspace taken from that row rather than from the record.

**Pandoc read arbitrary files and fetched URLs.** `--sandbox` had been dropped
because it silently drops in-directory images, and the regex guard that
replaced it only matched `image("<literal>")`. So `#raw(read("../outside.txt"))`
worked, and `#let u = "http://127.0.0.1:8123/x.png"; #image(u)` made pandoc
issue the GET, which is SSRF from a box that may sit inside a client's network.
The fix is a two-step conversion: the reader runs with `--sandbox` and emits
JSON, a pure walker (`docx-ast.mjs`) checks every `Image` target resolves to a
regular file inside the staged `assets/` directory and replaces anything else
with a placeholder and a warning, and only that filtered AST reaches the
unsandboxed writer.

**One small PNG could take the whole box.** The 200 MB ceiling counted file
bytes, and a screenshot compresses: a 6000x6000 PNG that encodes to 0.81 MB
costs 2192 MB of RSS to decode. The fix is to read dimensions from the header
before anything decodes (`image-size.mjs`, covering PNG, JPEG, GIF and all
three WebP chunk kinds), a 10 MP per-image cap, and a total-pixel budget per
export. The cap started at 30 MP in the ruling and the measurement refused it:
jimp costs about 50 MB of peak per megapixel, so 25 MP is 1361 MB. 10 MP is the
first round number above a 4K screenshot, which has to keep working.

Then SVG, which has no pixel dimensions to read and so was exempt from all of
that. A reviewer built a 604 KB SVG with a 12000x12000 PNG in a `data:` URI and
took the typst child to 431 MB; moving the same bitmap behind an `<feImage>`
filter primitive took it to 994 MB. A staged SVG now has to be UTF-8, at most
2 MB, free of entity declarations, free of `<image>` and `<feImage>` (a
namespace prefix does not help), and free of any `data:` URI anywhere in the
file. Fourteen shapes were tried against that; the refusals come back in 7 to
17 ms with the server's memory unmoved, and an ordinary logo still exports.

That exemption rests on a version-dependent fact, which is why it is written
into the invariant: usvg resolves an href for exactly two elements, `<image>`
and `<feImage>`, and a reviewer measured nine other href-taking elements
loading nothing; typst itself refuses http, file and out-of-root hrefs inside
an SVG, which is what leaves a `data:` URI as the only remaining payload. Bump
`TYPST_VERSION` in the Dockerfile and those checks have to be run again.

The last round replaced the decoded-pixel budget, which only counted images
with a crop or a blur on them, with one that counts every staged raster. The
common case is a report full of placed screenshots that nobody redacted, and
that had no total bound at all: 32 unredacted 9.87 MP screenshots took the
typst child to 922 MB, because it holds every decoded bitmap while it writes
the PDF's image streams, at roughly 3 bytes per pixel. 120 MP is about 360 MB
in the child, which leaves the 1 GB box room for the relay and one bake.

### Things that surprised me

- **Pandoc's `--sandbox` silently drops images that are right there in the
  working directory.** It is not a working-directory rule: the manual says IO
  is limited to "reading the files specified on the command line", and an image
  referenced from inside the document is not on the command line. The result is
  a Word file with every figure missing and nothing on stderr. That single fact
  is why the DOCX path is a two-step conversion rather than one pandoc call.
- **`typst -j 1` moves layout onto the main thread, whose stack is smaller.** I
  added `-j 1` so an export could not take both cores from the relay, and a
  3000-section document that compiles fine at the default job count now dies
  with `thread 'main' has overflowed its stack`. 2000 sections are fine. So
  server PDF export has a document-size ceiling somewhere between them, which
  is mapped to a sentence telling the operator to export from the browser.
- **jimp's "bilinear" resize point-samples.** Writing the redaction proof, the
  first synthetic pattern (a period-2 checkerboard, downscaled by exactly 10)
  came out uniformly white, which would have made a no-op bake look perfect.
  jimp 1.6.1 interpolates only at fractional source positions, so an
  integer stride samples one phase of the pattern forever. The same thing
  happens against the reference implementation this was ported from, so it is a
  property of the library. The check now uses a seeded non-periodic pattern
  with no period a fixed kernel can exploit.
- **50 MB of peak per megapixel**, measured on the ladder from 3.7 MP to 25 MP,
  which is what set the per-image cap at 10 MP instead of the 30 I first chose.
  A 5K screenshot is refused, and the message sends the operator to the browser
  export, which is the honest answer on this hardware.

### What is still open, on the server export

- **The bake stalls the relay and sits at the memory ceiling** for a report
  with a dozen large redacted screenshots. Numbers above. Both halves are the
  same cause: a synchronous jimp pass per image in the process that relays Yjs.
  The obvious fixes are to move the bake into a child process or a worker, or
  to lower the total budget to something the bake can afford rather than
  something the compiler can. Neither is mine to choose here.
- **Step 3 of the Word conversion is not sandboxed.** The confinement is the
  AST filter plus an `lstat` per target. Nothing else in a pandoc AST makes the
  docx writer read a file as far as I can tell, and `RawBlock` and `RawInline`
  are dropped before it sees the tree, but that is reasoning rather than a
  sandbox.
- **`docker images` SIZE and the filesystem disagree** on this host by about
  115 MiB per image. I used the filesystem number and said so; I did not chase
  the containerd accounting.
- **The download could not be captured through Chrome's own download path** in
  this headless setup, so the click-through proves the bytes from the anchor
  the app clicked rather than from a file Chrome wrote.
