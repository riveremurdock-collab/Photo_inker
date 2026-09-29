# Photo Inker — Architecture

This document describes how Photo Inker is built.

- **What the app does:** [Docs/photo-inker-outline.md](Docs/photo-inker-outline.md) is the source of truth.
- **Build order:** set by the build plan.
- **Progress:** [BUILD_PROGRESS.md](BUILD_PROGRESS.md) tracks what is done.

## 1. Stack

- **Vite 5 + TypeScript 5 (strict, `noUncheckedIndexedAccess`).** No UI framework: plain TypeScript builds the DOM through a small set of control builders. This matches the earlier stipple tool, so code copies across cleanly. The side panel is built from the settings schema, so a framework would add little.
- **No runtime dependencies yet.**
  - Planned: `fflate` for zip (Step 6) and a small PDF writer (Step 13).
  - spectral.js math is vendored as source with its MIT notice, not installed, because it also has to be ported to GLSL.
- **Fully client-side.**
  - `vite.config.ts` uses `base: "./"`, so `dist/` works from any folder on any static host.
  - No server, accounts, or network calls.
- **WebGL2** handles per-pixel work (adjustments, per-pixel splitting, AM/threshold halftones, print simulation, mixing).
  - **Module Web Workers** handle heavy sequential algorithms (void-and-cluster maps, error diffusion, auto palette, Ink Matching LUT builds).
- Two TS projects:
  - `tsconfig.app.json` (DOM) covers the app.
  - `tsconfig.worker.json` (WebWorker lib) covers `src/workers/*.worker.ts` and everything they import.
  - Code a worker imports must not touch the DOM. `src/util/` is kept DOM-free for this reason.

## 2. Folder structure

```
src/
  main.ts               bootstrap: store + layout + preview + pipeline
  style.css             Kawa palette; layout
  app/                  store.ts (ProjectSettings + subscribe/commit), history later
  schema/               types.ts (SettingDef, SectionSchema), sections.ts (all sections), defaults.ts
  ui/
    layout.ts           header / preview / side panel shell
    controls/           slider, select, toggle, color, seed, curve… one builder per SettingDef kind
    sections/           custom UI a section needs beyond generated controls (palette list, histogram…)
    preview/            WebGL preview canvas, zoom/pan, eyedropper
  pipeline/
    stage.ts            StageId list, Stage interface
    coverage.ts         CoverageSet (inter-stage data)
    pipeline.ts         runner + per-stage cache + "which stages reran" log
    stages/             one file per stage
  plugins/
    splitting/          types.ts, registry.ts, one file per method (inkMatching.ts, toneMap.ts, …)
    halftone/           types.ts, registry.ts, one file per type (none.ts, amSquare.ts, fmBlueNoise.ts, …)
  engine/
    spectral/           spectral.ts (vendored, MIT), inkModel.ts, overlapTable.ts
    gl/                 context, program/texture helpers, shaders/*.glsl
  workers/              protocol.ts, workerClient.ts, yield.ts, *.worker.ts
  export/               digital.ts, riso.ts, tiles.ts, png (pHYs DPI), zip
  util/                 rng.ts, color.ts, math.ts (DOM-free)
```

## 3. Settings model

All app settings live in one typed **`ProjectSettings`** object held by `app/store.ts`. Each setting is defined **once** as a `SettingDef` (`src/schema/types.ts`):

| Field | Meaning |
|---|---|
| `kind` | `number`, `select`, `toggle`, `color`, `text`, `seed`, `curve` (more kinds added only when needed) |
| `key`, `label`, `help` | identity and UI text |
| `default` | the value used on a fresh project; every setting has one |
| `min`/`max`/`step`/`unit` or `options` | range or choices |
| `perInk` | stored as an array indexed by ink slot (always length `MAX_INKS` = 4, so adding or removing inks never loses values) |
| `stage` | overrides the section's stage; `null` = never affects the preview (export-only or UI-only) |
| `visibleWhen` | shown only when a predicate over the section's values is true (e.g. JPG quality only for JPG) |
| `display` | selects only: `segmented` buttons or `dropdown` |
| `modes` | show only in `digital` or `print` mode |
| `advanced` | hidden behind the section's Basic/Advanced toggle (Step 14) |

- **Sections.** Settings are grouped into `SectionSchema { id, title, stage, settings }`, declared with `defineSection()` in `src/schema/sections.ts`. `stage` is the pipeline stage that reruns when anything in the section changes (unless a setting overrides it).
- **Derived type.** `ProjectSettings` is derived from the schema by TypeScript (literal keys and option values), so `settings.upload.mode` is typed `"digital" | "print"` without a hand-written interface.
- **Plugin settings.** A splitting method or halftone type brings its own `schema`. The section shows the chosen plugin's controls, and its values are stored under `settings.split.methods[methodId]` / `settings.halftone.types[typeId]`, so switching methods keeps each method's settings.
- **Generated UI.** Controls are generated from the schema. Sections with special UI (palette list, histogram band handles, curve editors) add a custom builder, but their values still live in the settings object and are still described by `SettingDef`s.
- **Walking the schema.** Presets, save/load, and randomize (later) only walk the schema.
  - Defaults: `defaultsFor(schema)`.
  - Randomize: pick within `min`/`max`/`options`.
  - Save: JSON of `ProjectSettings` with a `version` field.
- **Commit pattern (from the stipple tool).**
  - Dragging a slider calls `preview(patch)`, which updates the preview but not undo history.
  - Releasing it calls `commit(patch)`, which records undo (later).
  - Both paths go through the same pipeline invalidation.

## 4. Plugin interfaces

Both plugin kinds follow the same shape: **settings schema in, ink coverage layers out.** Adding a method means adding one file and one line in its `registry.ts`.

```ts
// src/plugins/splitting/types.ts
interface SplitMethod<S> {
  id: string; label: string;
  schema: SettingDef[];
  split(input: SplitInput, settings: S, ctx: StageContext): Promise<CoverageSet>;
}

// src/plugins/halftone/types.ts
interface HalftoneMethod<S> {
  id: string; label: string; family: "none" | "am" | "fm";
  schema: SettingDef[];          // whole-image settings
  perInkSchema: SettingDef[];    // size, angle, density… stored per ink
  prepare?(analysis: ImageAnalysis, settings: S, ctx): Promise<void>;  // shared whole-image analysis
  render(coverage: CoverageSet, settings: S, ctx): Promise<CoverageSet>;
}
```

- A method decides internally whether it runs as a GPU pass or in a worker. The pipeline only sees the promise.
- `SplitInput` carries the adjusted image in linear light plus the inks and paper. Ink Matching also gets the shared ink model (§6), so what it solves for is exactly what the preview shows.
- **Detail Split (Step 8)** calls another registered `SplitMethod` for its base layers.
- **Whole-image analysis (luminance, and later edges and structure)** is computed once per adjusted image and passed to `prepare`, so every layer's halftone is built from the same data.
- **Minimum dot size and drop-out/round-up** are shared halftone settings, applied by the halftone stage around the plugin rather than by each plugin.

## 5. Pipeline

```
upload → fadeBorder → adjust → split → layerOptions → halftone → border → printSim ─┐
                                                                                   ├→ mix → display / export
                      palette + paper + print order + opacity → overlapTable ──────┘
```

| Stage | Input | Output | Main settings |
|---|---|---|---|
| upload | file | oriented, size-limited RGBA (full res + preview-res copy) | file, max size |
| fadeBorder | image | image with vignette to black/white | Border › Fade |
| adjust | image | adjusted linear-light image | Image Adjustments |
| split | image + inks | `CoverageSet` | Color Splitting method + its settings, palette |
| layerOptions | coverage | coverage | per-layer curves, levels, density, invert, knockout, trapping, total ink limit |
| halftone | coverage + analysis | coverage (binary or smooth for None) | Halftone type + per-ink settings, min dot |
| border | coverage | coverage (maybe larger canvas) | Border › Solid / Paper |
| printSim | coverage | coverage | Print Simulation (skipped for riso/standard exports) |
| overlapTable | palette, paper, order, opacity | 2ⁿ solid colors (linear RGB) | Palette, per-ink opacity |
| mix | coverage + overlap table | linear RGB → sRGB display | solo/mute (display only) |

- **Caching.** Each stage caches its output with a key built from:
  - a stable hash of the settings its `selectSettings()` returns
  - the version numbers of its input stages

  Changing a setting bumps only its own stage's key, so only that stage and those after it rerun. For example, changing an ink color changes the overlap table and the mix only. It changes `split` only when the current method reads ink colors (Ink Matching, Selective Color base ink), and the method declares that in its settings selector.
- **Superseding.** A newer request cancels an in-flight run (an `AbortSignal` on the main thread; `WorkerClient` drops superseded worker results).
- **Data between stages.** Stages pass a **`CoverageSet`**: one map per ink, 0 = no ink, 1 = full ink.
  - Max 4 inks, so on the GPU a CoverageSet is **one RGBA texture, one ink per channel** (RGBA16F/RGBA32F when available, RGBA8 otherwise).
  - A `Float32Array` CPU mirror exists only when a worker stage needs it.
- **Resolution.**
  - The preview runs the pipeline on a copy downscaled to screen resolution (long edge ≈ canvas size × devicePixelRatio).
  - At 100%+ zoom or for export, it runs at full resolution.
  - Full-resolution export processes **tiles** with an overlap margin wide enough for kernel stages (smoothing, trapping, blur). Whole-image algorithms that can't tile, such as error diffusion, run in a worker on the full coverage map, stored as 8-bit to save memory.
- **Debug log.** A debug flag (`?debug` in the URL) logs which stages reran and how long each took.

## 6. Rendering engine

This follows the outline's Rendering Engine section.

- **Spectral colors.**
  - Every ink and the paper get a 38-band reflectance curve (380–750 nm).
  - Curves are generated with the spectral.js method: blend premade R/G/B base reflectance curves weighted by the color's linear RGB.
  - The curves are converted back to color through CIE XYZ.
  - The base curves and CIE tables are vendored in `engine/spectral/spectral.ts` with the MIT notice.
- **Transparent layering.**
  - Riso ink behaves like a transparent film.
  - An ink's transmittance per band is derived from its chosen color printed on white: `T = sqrt(R_ink)`, so white paper × T² reproduces the swatch.
  - A pixel's color is `R_paper × Π T_i²` over the inks present, converted back to linear RGB.
- **Opacity.** Per-ink opacity `a` blends toward the ink's own reflectance: `R = (1−a)·(R_below·T²) + a·R_ink`. The inks are applied in **print order**, so order matters only when opacity > 0.
- **Overlap table.** The overlap table has 2ⁿ entries (paper, each ink, every overlap), computed on the CPU in linear RGB. It is rebuilt only when the palette, paper, print order or opacity changes.
- **Partial coverage.**
  - Binary halftoned pixels are a table lookup.
  - Partial pixels (dot edges, None halftone, pre-halftone previews) run the spectral mix in the fragment shader: the ink curves are uploaded as uniforms, and coverage is interpolated per band.
  - Exact formulas and GLSL are settled in Step 3.
- **Color pipeline.**
  - Linear light throughout: mixing, resizing, and zoomed-out averaging (mipmaps built in linear light) all happen in linear light.
  - The final conversion is linear → sRGB with soft-knee gamut compression instead of a hard clip.
- **Swappable model.** Rendering reads only the overlap table and the shader's ink model, so measured calibration can replace the spectral estimate later.

## 7. Website embedding

- `npm run build:site` builds into `../kawa_website/public/photo-inker-app/`, the same way the stipple tool builds into `stipple-app/`. The site can embed it with an iframe to `/photo-inker-app/index.html`, like `src/pages/stipple-tool.astro`.
- Fonts (`/fonts/...`) and the favicon (`/images/logos/...`) are the site's own files. In `npm run dev`, a small Vite plugin serves them from `../kawa_website/public` so local looks the same as the site.

## 8. Workers

- **Protocol.** `workers/protocol.ts` defines one envelope for all workers: `{ requestId, payload }` in and `progress | done | error` out.
- **Client.** `workers/workerClient.ts` is a generalized copy of the stipple tool's client.
  - Each `run()` supersedes the previous one, and stale replies are ignored.
  - Large buffers are sent as transferables.
- **Yielding.** Long worker loops call `yieldToEventLoop()` (`workers/yield.ts`, a MessageChannel trick from the stipple tool) between chunks, so a newer request can cancel them.

## 9. Code reused from the stipple tool

Code is copied in, never linked, and each file notes where it came from.

| Stipple tool | Photo Inker | When |
|---|---|---|
| `engine/rng.ts` | `util/rng.ts` | Step 0 |
| `color/colorSpace.ts` | `util/color.ts` (+ hex helpers) | Step 0 |
| `state/stippleWorkerClient.ts`, `worker/messages.ts` | `workers/workerClient.ts`, `protocol.ts` (generic) | Step 0 |
| MessageChannel yield in `separation/lut.ts` | `workers/yield.ts` | Step 0 |
| `style.css` palette variables | `style.css` | Step 0 |
| `ui/preview.ts` zoom/pan math | preview canvas (rewritten for WebGL + devicePixelRatio) | Step 1 |
| `panel.ts` `<details>` sections, slider row (preview/commit) | control builders | Step 1 |
| `ui/imageLoad.ts`, upload drop zone, `crop.ts` downscale | upload stage (adds max size, multi-step downscale) | Step 1 |
| `ui/risoPresets.ts` | palette ink presets | Step 2 |
| `separation/neugebauer.ts` `solveCoverage`, `lut.ts` | starting point for Ink Matching (rewritten on spectral model) | Step 4 |
| `engine/grain.ts` min dot constant | min dot size default | Step 5 |
| `output/sizeUnits.ts`, `downloadBlob` | export sizing | Step 6 |
| `settings/presetStorage.ts`, undo snapshots | presets / undo | later |

Written fresh:
- **Void-and-cluster threshold maps and error diffusion.** The stipple tool only has best-candidate point lists.
- **The WebGL renderer, spectral model and overlap table.** The stipple tool has no GPU code and uses a multiply blend.
- **The schema system and pipeline cache.**
- **Zip, JPG, PNG DPI, tiling and PDF export.**
