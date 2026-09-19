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
- **Nothing automated covers the font upload path.** No test renders
  `AssetsPanel`, and the store action that carries the parsed family name has
  no test either. It was verified by hand in a browser once. A font whose
  metadata fails to parse degrades to the filename with the insert button
  disabled, which is the intended behaviour and also what a silent breakage
  would look like.
- **The render cache is per page load.** It is module state, so a browser
  reload starts empty. Persisting a few MB of SVG per workspace in IndexedDB is
  not obviously worth it on a 1 GB box.
- **The fonts are not content-hashed**, so every load revalidates 17 of them.
  See the cache headers above.
