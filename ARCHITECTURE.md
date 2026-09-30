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
- **Inks.** Inks are per-ink settings in slots 0..`inkCount`-1, and slot order is print order. `SettingsStore.permuteInks(order)` reorders every per-ink setting in every section at once, so an ink's settings travel with it.
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
// src/plugins/splitting/types.ts (as built in Step 4)
interface SplitMethod<Sec extends SectionSchema, P> {
  id: string; label: string;
  section: Sec;                                   // its settings: a schema section with parent "split"
  dependsOn(ctx: SplitContext, values): unknown;  // extra cache-key inputs, e.g. ink colors
  prepare?(values, ctx, quality: "draft" | "final"): Promise<P>;  // optional worker job
  render(ctx, image: Target, out: Target, values, prepared?: P): void;  // GPU pass → coverage
}

// src/plugins/halftone/types.ts (as built in Step 5)
interface HalftoneMethod<Sec extends SectionSchema, P> {
  id: string; label: string;
  section: Sec;                    // its settings (parent "halftone"); per-ink ones use perInk
  glsl: string;                    // defines htSamplePoint(ink, p) and htInk(ink, p, coverage)
  prepareKey?(values, info: OutputInfo): string;  // optional worker job (e.g. a threshold map), cached by key
  prepare?(values, info: OutputInfo): Promise<P>;
  fromCoverage?: {                 // whole-image methods (Step 10: error diffusion)
    cell(values, ctx): number;     // output px per bitmap cell
    build(values, coverage, w, h, inkCount, purpose: "preview" | "export"): Promise<Uint8Array>;
  };
  uniforms(values, ctx: HalftoneContext, prepared?: P, bitmap?: CoverageBitmap): Record<string, UniformValue>;
}
```

- **Split methods (built).**
  - A method's settings live in its own schema section (`parent: "split"`, `visibleWhen` its method is chosen). Its file exports both the section and the method, and `plugins/splitting/registry.ts` lists them. `sections.ts` spreads `SPLIT_SECTIONS` into `SECTIONS`, so `ProjectSettings` stays fully typed.
  - Heavy CPU work goes in `prepare()`, which the pipeline runs in the background: first a quick draft, then the final result. While it runs, the last result from the same method keeps being shown.
  - `render()` is always a GPU pass.
  - **Ink Matching** (`inkMatching.ts`): the worker (`workers/inkMatch.worker.ts` → `engine/spectral/solver.ts`) solves a 3D lookup table over sRGB, a 17³ draft then 33³, with Levenberg–Marquardt in Lab against the same overlap table the preview uses. The table is lightly smoothed, uploaded as a 3D texture, and looked up per pixel with trilinear filtering.
  - **Tone Map** (`toneMap.ts` + `toneCurves.ts`): bands are turned into one 256-entry curve per ink on the CPU (the engine Advanced mode will reuse), and a GPU pass applies them by pixel lightness.
- `SplitContext` carries the GPU, inks, paper, and overlap table, so Ink Matching solves against exactly what the preview shows.
- **Detail Split (Step 8)** calls another registered `SplitMethod` for its base layers.
- **Whole-image analysis.** Luminance and Sobel gradient are computed once per adjusted image, lazily, through `HalftoneContext.analysis()`, and shared by every layer. The basic AM/FM types don't need it; structure-aware types will.
- **Halftone types (Step 10).**
  - Non-square AM grids (hex, noise, spiral, rings) share `plugins/halftone/lattice.ts`. A grid only defines `latToLattice`, `latFromLattice` and `latNearest` in GLSL (plus the same nearest-center search in TS). Exact tone comes from a threshold table measured by sampling the grid (`measureThresholds`), cached per grid + dot shape.
  - Whole-image methods (`fromCoverage`) are fed by the pipeline: it reads the coverage back at the method's cell size, the method builds a bitmap in a worker, and its GLSL draws from the bitmap texture. Export rebuilds the bitmap at full output resolution. `halftoneWorker(purpose)` keeps preview and export on separate workers.
  - **FM: stipple** (`fmStipple.ts` + `engine/halftone/stipple.ts`) has no grid: a ranked best-candidate point set in GPU buckets, per-dot shapes from hashed parameters, and a tone table measured on the CPU with the same dot formula (the TS and GLSL versions must be kept in step).
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

- **Implementation (Step 4).** `pipeline/pipeline.ts` holds one GPU render target per stage output, with shaders in `pipeline/stages/shaders.ts`. `engine/gl/gpu.ts` provides the target and fullscreen-pass helpers.
- **Caching.** Each stage caches its output with a key built from:
  - its own settings, as JSON
  - the version numbers of the stages it reads

  A run (at most one per animation frame) walks the stages in order and reruns only those whose key changed. Measured:
  - A Tone Map ink color change reruns only `mix`.
  - Solo/mute reruns only `mix`.
  - Invert/density rerun `layerOptions` and `mix`.
  - An Ink Matching ink color change reruns `mix` at once (old coverage, new colors), then `split` when the new lookup table arrives. `adjust` is never rerun for any of these.
- **Superseding.** `WorkerClient` drops superseded worker results, and the worker itself stops a superseded table build at the next slice.
- **Data between stages.**
  - Images are `SRGB8_ALPHA8` textures: linear-light values, sRGB-encoded storage, so there is no float-render extension to depend on.
  - Coverage is one `RGBA8` texture with one ink per channel.
  - The mixed output is an `SRGB8_ALPHA8` texture with mipmaps, so zoomed-out display averages in linear light.
- **Resolution.**
  - The pipeline runs on a working copy at full image resolution, capped at 4096 px on the long edge. Larger images are downscaled once with a 4×4 area filter in linear light. The mixed output is shown through mipmaps, so at any zoom the inked view is as sharp as the original, up to that resolution.
  - The "Original" view shows the full-size texture (up to 8192 px).
  - **Halftoned views (Step 5).** `pipeline/compositor.ts` draws AM/FM halftones straight into the canvas for the current view.
    - Each screen pixel takes up to 8×8 jittered samples. At each sample, every ink's halftone code decides at exact output resolution whether that point is inked, and the ink combination is looked up in the overlap table.
    - Samples are averaged in linear light, so zoomed-out views show the true average tone of the dots (measured ΔE ≤ 1 against smooth coverage for AM), and zoomed-in views show crisp, anti-aliased dots.
    - Only 3×3 samples are used while zooming or panning, then full quality once the view settles.
  - **Detail renders (halftone None, images over 4096 px).** When zoomed in beyond the working copy, the same passes (copy → adjust → split → layers → mix) re-run for just the visible area at full source resolution, after the view settles, and are drawn over the base texture.
  - **Output size.** Halftone sizes are in output pixels. `app/output.ts` gives output px per image px from the Export settings: Digital = Original / 2× / custom width; Print = print width × DPI.
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
  - An ink's transmittance per band is derived from its chosen color printed on white: `T² = R_ink / R_white`, so white paper × T² reproduces the swatch exactly (verified: every tested color round-trips to the same hex).
  - A pixel's color is `R_paper × Π T_i²` over the inks present, converted back to linear RGB.
  - Code: `engine/spectral/inkModel.ts`.
- **Opacity.** Per-ink opacity `a` blends toward the ink's own reflectance: `R = (1−a)·(R_below·T²) + a·R_ink`. The inks are applied in **print order**, so order matters only when opacity > 0.
- **Overlap table.** The overlap table has 2ⁿ entries (paper, each ink, every overlap), computed on the CPU in linear RGB (about 0.04 ms for 4 inks).
  - `OverlapTableCache` (`engine/spectral/overlapTable.ts`) rebuilds it only when the paper, ink colors, opacity, ink count or print order change.
- **Partial coverage (GPU).**
  - `mixInks()` in `engine/gl/inkShader.ts` averages the table entries weighted by coverage (Demichel weights: each ink covers its fraction of the pixel independently).
  - Converting a spectrum to color is linear, so this equals running the spectral model band by band on the averaged spectrum. It also still holds with opacity, because each print step is linear in the reflectance underneath.
  - It is cheaper than a 38-band loop per pixel, and it matches how a halftone looks from a distance, so smooth previews, halftoned previews, and zoomed-out views agree.
  - A binary (halftoned) pixel is a special case: exactly one table entry.
  - `mixCoverage()` is the same math on the CPU, for Ink Matching.
- **Color pipeline.**
  - Linear light throughout: mixing, resizing, and zoomed-out averaging (mipmaps built in linear light) all happen in linear light.
  - **Gamut compression.** `gamutCompress()` handles colors that fall outside sRGB (vivid overlaps). They are desaturated toward their own luminance just enough to fit, which keeps their hue, instead of having each channel clipped. Colors inside sRGB are untouched, so a solid ink always shows exactly the picked color.
- **Swappable model.** Rendering reads only the overlap table, so measured calibration (16 printed patches) can replace the spectral estimate later without changing the shader.
- **Test view.** The temporary ink mixing test is `ui/inkTestView.ts`. It shows the swatch grid and ramps with Spectral, Multiply and Split modes, and is to be removed or hidden in Step 14.

## 6b. Export (Step 6)

- `export/exporter.ts` renders the output pixel grid in 2048 px tiles.
  - For each tile, `Pipeline.renderRegion()` reruns copy → adjust → split → layer options for the matching image area (plus a margin), from the full-size source, at min(output, source) resolution. It is the same function the zoom detail view uses.
  - An output pass (`export/shaders.ts`) then writes either Digital color (the halftone method's GLSL with 2×2 samples per pixel, like the preview at 100%) or Riso layers (one ink per channel, 1 sample per pixel, so pure black/white; smooth for None).
- Strips of tiles stream into `export/png.ts` (our streaming PNG encoder: the browser's `CompressionStream("deflate")`, pHYs DPI, sRGB chunk; fflate's streaming zlib was dropped in Step 10 after it produced corrupt data) or into a canvas for JPG. Riso PNGs are zipped with fflate.
- File names: `Project.png` / `Project.jpg`; `Project_01_0078BF.png` … in print order, inside `Project_riso_layers.zip`.

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
| `ui/risoPresets.ts` | not used for now (ink presets deferred at user request); paper presets are in `app/paperPresets.ts` | Step 2 |
| `separation/neugebauer.ts` `solveCoverage`, `lut.ts` | starting point for Ink Matching (rewritten on spectral model) | Step 4 |
| `engine/grain.ts` min dot constant | min dot size default | Step 5 |
| `output/sizeUnits.ts`, `downloadBlob` | export sizing | Step 6 |
| `settings/presetStorage.ts`, undo snapshots | presets / undo | later |

Written fresh:
- **Void-and-cluster threshold maps and error diffusion.** The stipple tool only has best-candidate point lists.
- **The WebGL renderer, spectral model and overlap table.** The stipple tool has no GPU code and uses a multiply blend.
- **The schema system and pipeline cache.**
- **Zip, JPG, PNG DPI, tiling and PDF export.**
