# Build Progress

## Steps

| Step | Name | Status |
|---|---|---|
| 0 | Setup and architecture | ✅ Done |
| 1 | Upload, modes, and preview canvas | ✅ Done |
| 2 | Palette (basic) | ✅ Done |
| 3 | Rendering engine core | ✅ Done |
| 4 | Image adjustments, color splitting (basic), shared layer options | ✅ Done |
| 5 | Halftone (basic) | ✅ Done |
| 6 | Export (basic) | ✅ Done |
| — | *End of basic build: overall report* | ✅ Given 2026-09-29 |
| 7 | Full palette options | ✅ Done |
| 8 | Remaining color splitting methods | ✅ Done |
| 9 | Complete shared layer options | ✅ Done |
| 10 | Remaining halftone types | ✅ Done |
| 11 | Border | ✅ Done |
| 12 | Print simulation | ✅ Done |
| 13 | Full export options | ✅ Done |
| 14 | Performance and polish | ⏳ Next |

## Decisions

### Step 0
- **Stack:** plain TypeScript + Vite 5, no UI framework. This matches the stipple tool (`../stipple tool`), so code copies across cleanly.
- **Dependencies:** none at runtime. spectral.js math will be vendored as source with its MIT notice, so it can also be ported to GLSL.
- **Coverage data:** a `CoverageSet` holds up to 4 inks, stored as one RGBA texture (one ink per channel) on the GPU.
- **Static hosting:** `base: "./"` means `dist/` works from any folder on a static host.
- **Spec folder:** the spec lives at `Docs/` (capital D); the build plan says `docs/`. Left as is.

### Step 1
- **Website build:** `npm run build:site` builds into `../kawa_website/public/photo-inker-app/`, like the stipple tool. The site page, an iframe like `stipple-tool.astro`, hasn't been created yet.
- **Dev assets:** in dev, the site's fonts and favicon are served from `../kawa_website/public`.
- **Upload limits:**
  - Max 50 megapixels and 100 MB. Larger images are rejected with a message giving the size and limit.
  - HEIC gets its own message.
  - When a new upload fails, the current image stays.
- **Phone orientation:** handled by the browser decoder (`createImageBitmap` with `imageOrientation: "from-image"`). Browsers that reject the options fall back to an `<img>` element.
- **Preview renderer:**
  - The WebGL2 canvas is viewport-sized; zoom and pan are shader uniforms.
  - The image is an sRGB texture with mipmaps, so zoomed-out display averages in linear light.
  - The display texture is capped at 8192 px on its long edge (or the GPU limit if lower). Only images bigger than that are downscaled for display, and only for display.
- **Zoom scale:** 100% = 1 image pixel per physical screen pixel.
  - Pixels are drawn crisp (nearest-neighbor) at 200% and above.
  - Zoom range: a quarter of fit-to-screen up to 3200%.
- **Controls:**
  - Wheel/trackpad zoom around the cursor; drag to pan; two-finger pinch on touch.
  - Double-click switches between 100% and fit.
  - Keys: 0 = fit, 1 = 100%, +/− zoom.
- **Project name:** follows the uploaded file's name until the user types their own.
- **Schema additions:** a `text` kind, a per-setting `stage` override (`null` = doesn't affect the preview), `visibleWhen`, and `display: "segmented"` for selects.
- **Per-ink values:** always arrays of length 4.
- **Sample settings:** so mode switching can be seen, Export has two real settings from the spec: Digital › Format (PNG/JPG) and Print › Resolution (600 DPI).

### Step 2
- **Storage:** inks are ordinary per-ink settings, stored in slots 0–3 with an `inkCount`. Slot order is print order.
  - **Reorder:** reordering or removing an ink moves that slot's values in every per-ink setting in every section (`SettingsStore.permuteInks`), so each ink keeps its halftone angle, density, and other settings when it moves.
  - **Remove:** a removed ink's settings go to the unused end slot.
  - **Add:** a new ink's slot is reset to defaults and given the first standard color not already used.
- **Defaults:** 3 inks (Blue #0078bf, Fluorescent Pink #ff48b0, Yellow #ffe800) on Natural paper (#f6f3ec). This is a riso CMY analog, so a color photo looks reasonable right away once splitting exists.
- **Ink identity:** inks have no names; they are identified by their hex code. This was requested: Riso ink approximations and names will come later. Export file names will use the hex code, e.g. `Project_01_0078BF.png`.
- **Choosing an ink color:** an ink's swatch is the browser's own color input, so clicking it opens the color picker (with manual RGB/hex entry) straight away. Each row also has a hex field.
- **Presets:** there are no ink presets for now. The paper swatch opens a popup with 7 paper presets plus a custom picker (`app/paperPresets.ts`).
- **Manual vs Auto:**
  - Palette colors are either Manual or Auto.
  - Auto recomputes on upload, ink count change, and the background toggle, plus paper change when the paper is kept.
  - Editing an ink color by hand switches back to Manual and keeps the colors.
- **Auto palette method:**
  - k-means in Lab on a 160 px copy of the image, 4 restarts, deterministic (no randomness between runs).
  - The kept paper is a fixed cluster, so inks aren't spent on paper-colored areas.
  - Each ink is the average of the 30% of its cluster farthest from the paper, not the cluster mean. A solid ink is the strongest version of its color; the mean includes tints and looks muddy.
  - Inks are sorted light to dark, so lighter inks print first.
  - With "Pick the background from the image too", the lightest cluster becomes the paper.
- **Eyedropper:**
  - Averages a 3×3 pixel area in linear light, and shows a loupe with the hovered color.
  - A click picks; a drag still pans. Escape cancels.
  - It turns off after one pick.
- **Reorder controls:** ▲/▼ buttons, not drag-and-drop. They are simpler and keyboard accessible.
- **Paper label:** the paper row reads "Background" in Digital mode and "Paper" in Print mode.
- **Transparent PNGs:** transparent areas show the paper color.
- **Panel width:** widened to 370 px.
- **Layout:** the settings panel is on the left and the preview on the right (user request). On narrow screens the preview stays above the panel.

### Step 3
- **spectral.js tables:** the base spectra, the CIE color matching functions (D65-weighted), and the XYZ→sRGB matrix were copied from spectral.js v3.0.0 (MIT) into `engine/spectral/spectral.ts`. They were generated from the npm package source, so the numbers are exact, and the license text is in the file header.
- **Ink color meaning:** the picked ink color means "solid on white paper". On other papers, the ink is tinted by the paper, as real transparent ink would be.
- **Partial coverage:** mixing uses Demichel weights over the overlap table. This is mathematically identical to the per-band spectral mix (see ARCHITECTURE §6), and it keeps the preview consistent with how halftones look from a distance. Mixed midtones of two inks look greyer than their solid overlap, as real two-ink halftones do.
- **Gamut compression:** hue-preserving desaturation, applied only to out-of-gamut colors. In-gamut colors are exact.
- **Multiply comparison:** a Photoshop-style multiply in sRGB: paper × each ink.
- **Opacity:** per-ink opacity (0–100%, default 0%) is a regular per-ink setting. It is the first setting to use the generated per-ink control group, with one slider per ink labeled by its hex code.
- **Test view:** the temporary ink test view opens from a dashed "Show ink mixing test" button in the Palette section and covers the preview area.
- **Measured results:**
  - White paper: Yellow #ffe800 + Blue #0078bf → #05712a (multiply gives #006d00).
  - Pink #ff48b0 + Blue → #2f1982 (purple).
  - Pink + Yellow → #fb480f.
  - All three → #28241b.

### Step 4
- **Pipeline:** upload → adjust → (histogram, only for Tone Map) → split → layerOptions → mix. All stages are GPU passes, cached per stage (ARCHITECTURE §5).
- **Working resolution:** changed after the user reported a blurry inked view.
  - The pipeline processes at full image resolution, up to 4096 px on the long edge. Larger images are downscaled once with a 4×4 area filter.
  - The inked view is displayed through mipmaps like the original.
  - Measured sharpness (edge energy relative to the original): at fit 0.78 → 1.00; a 3000 px image at 100% → 0.98. Images over 4096 px are softer than the original above ~70% zoom until Step 5 adds full-resolution rendering of the visible area.
- **Crisp pixels:** nearest-neighbor display is used only at 200%+ zoom and only for full-resolution textures.
- **Smoothing buffers:** freed while smoothing is off.
- **Display toggle:** Inks / Original buttons in the preview toolbar (keys I / O).
- **Image Adjustments:**
  - Levels (black point, white point, midtone as a gamma: `2^(value/50)`) and the contrast curve are applied per channel to sRGB values, like an image editor, as one 256-entry table.
  - Saturation boost is applied in linear light, keeping luminance.
  - Smoothing is a separable edge-preserving (bilateral) blur. Its radius is `value × long edge / 1000` px, so it looks the same at any resolution.
- **Curve editor:** a new generated control for `curve` settings. Click to add a point, drag to move it, double-click or drag off the top/bottom to remove it. There is a Reset button. Interpolation is monotone cubic (`util/curve.ts`).
- **Ink Matching:**
  - Worker-built 3D lookup table: a 17³ draft first (~0.1–0.2 s), then 33³ (~0.75 s for 3 inks, ~1.4 s for 4 inks in Edge on this machine).
  - The table is smoothed with [1 2 1] along each axis, to avoid jagged switches between equally good ink mixes.
  - **Priority** (per ink, default 50) penalizes an ink's use in proportion to (1 − priority).
  - **Sparsity** (default 25%) penalizes overlapping ink pairs and total ink.
  - **Out-of-gamut:** Compress (default) maps the image's lightness range onto the lightness range the inks can reach, then finds the closest match. Clip only does the closest match. Chroma is not compressed.
  - **Lightness ↔ hue** (default 50) reweights lightness error against a/b error.
- **Tone Map (Simple):**
  - 1–4 bands (default 4) with cutoffs at 25/50/75%, dragged on a lightness histogram.
  - The ink per band defaults to "Auto": darker bands get darker inks, and bands left over become paper. With the default 3 inks: blue, pink, yellow, then paper in the highlights.
  - Overlap width per boundary (default 6%), falloff Hard/Linear/Smooth (default Smooth).
  - Fill is Flat or Tonal gradient (density fades from full at the band's dark edge to none at its light edge), with posterize steps for gradient fill.
  - Lightness source: luma, L*, R, G, B, max, or min.
  - A live strip shows the printed color at every tone.
  - The "Mode: Simple/Advanced" switch comes with Advanced mode in Step 8.
- **Layers (shared options):**
  - Per layer: density 0–200% (default 100%), invert, solo, mute, and ▲/▼ print order (the same as the palette order).
  - Solo/mute affect only the preview (stage `mix`).
  - Invert is applied before density.
- **Transparency:** transparent image areas get no ink.

### Step 5
- **Halftone preview:** drawn per view by a compositor, not rendered to a texture (see ARCHITECTURE §5). Dots are exact at output resolution at every zoom, with linear-light averaging when zoomed out. Measured on flat patches: AM vs smooth ΔE ≤ 0.9, FM ΔE ≤ 2.3.
- **Output size settings pulled forward from Step 6/13:** Digital "Output size" (Original / 2× / Custom width) and Print "Print width" (in) + DPI. Halftone sizes are in output pixels.
- **Defaults:** halftone type AM square grid; cell 8 px (75 LPI at 600 DPI); angles 15°/75°/0°/45° by print order; round (Euclidean) dots; max dot 100%; minimum dot 1.5 px (the stipple tool's riso-safe value) with Drop.
- **AM dot shapes:** round (Euclidean), square, ellipse, diamond, line. Each shape becomes a rank table over the cell, so a dot's area always equals the tone exactly.
- **Dot size curve:** global (one curve for all inks). Cell size, angle, and max dot are per ink.
- **Minimum dot (AM):** a tone whose dot would be smaller than a round dot of the minimum diameter is dropped. With Round up, tones above 2% become the minimum dot.
- **Minimum dot (FM):** raises the FM dot size to at least the minimum.
- **FM blue noise:**
  - Void-and-cluster maps are built in a worker using segment trees: 128² ≈ 0.3 s, 256² ≈ 0.8 s here. They are cached per size/spread.
  - The seed changes each ink's offset into the map (not the map itself), so layers are placed independently and re-rolling is instant.
- **FM round dots:**
  - Radius √2/2 cells, so neighbors merge into solid ink.
  - Because they overlap, the actual coverage at each density is measured on the map when it's built, and inverted into a tone-correction curve.
- **Whole-image analysis:** luminance + gradient, computed lazily and shared by all layers. Not used by AM/FM yet.
- **Full-resolution detail:** for None on images larger than 4096 px, the visible area is re-rendered at full resolution when zoomed in (after the view settles).
- **Ink Matching fixes found while testing:**
  - Compress mode now matches relative to the paper, so image white = bare paper. Before, a neutral white on warm paper got faint blue dots to "correct" the paper's tint.
  - The white entry of the lookup table is kept exactly as solved, so smoothing can't leak ink into it.

### Step 6
- **Exporter:** `export/exporter.ts` renders in 2048 px output tiles.
  - For each tile, the pipeline's passes run on just that part of the image from the full-size source (`Pipeline.renderRegion`, shared with the zoom detail view), with a margin for smoothing and for halftone cells crossing the tile edge.
  - An output pass then writes the tile.
- **Digital:** PNG, streamed (with an sRGB chunk), or JPG (quality 0.92, via canvas, limited to 16384 px per side / 120 MP). It uses the same halftone GLSL as the preview, with 2×2 samples per pixel like the preview at 100%. Measured against the 100% preview: median ΔE 0.40.
- **Print (Riso):**
  - One 8-bit grayscale PNG per ink at the chosen DPI, with DPI written in pHYs. Named `Project_01_0078BF.png` in print order, zipped without recompression.
  - Halftoned layers use 1 sample per pixel, so they are exactly 0/255. With halftone None they are smooth grayscale.
  - Solo/mute are ignored (all inks are exported).
- **PNG encoder:** `export/png.ts` is our own streaming encoder, using fflate's zlib. Rows are compressed as each strip of tiles finishes, so huge layers never exist uncompressed.
- **New dependency:** `fflate` (MIT), for zlib and zip.
- **Waiting:** export first waits for any ink matching or blue noise map in progress.
- **Progress:** a progress bar and Cancel sit in the Export section; the UI stays responsive (it yields between tiles).
- **Measured (Edge, software GPU):**
  - Riso at A3 width (7020 × 4681, 4 inks): 10.5 s, JS heap ~120 MB.
  - 6000 × 4000 image at 10 in / 600 DPI: 10.3 s.
- **Panel:** can now place custom blocks after a section's generated controls.

### Step 7
- **Palette modes:** Colors is now Manual / Scheme / Auto.
- **Scheme mode:**
  - Ink 1 is the scheme's first color. Entering Scheme mode keeps the current ink 1.
  - Changing ink 1 (picker, hex, or eyedropper) regenerates the rest, live while dragging.
  - Editing another ink, or adding or removing an ink, switches to Manual (a scheme locks in its count).
- **Generation:** `app/colorSchemes.ts` rotates hue in OKLCH at the first color's lightness and chroma, with chroma reduced only if needed to stay in sRGB.
  - Complementary: 0/180°. Analogous: 0/±30°. Triad: 0/120/240°. Square: 0/90/180/270°.
  - Monotone: the first color, a lighter tint (L +0.25), and a darker shade (L −0.25).
  - CMYK analog: fixed #3255a4 (Medium Blue), #ff48b0 (Fluorescent Pink), #ffe800 (Yellow), #000000 (Black). These are approximate screen colors in one constant (`CMYK_ANALOG`), to replace with measured ink colors later.
- **Include background in scheme:**
  - The lightest scheme color other than the first takes the background slot, so the scheme gives one fewer ink.
  - Because hue-rotated colors share the first color's lightness, that slot becomes a pale paper tint of the color (OKLCH L 0.95, gentle chroma), not the mid-tone itself. A mid-tone paper would bury the inks.
  - Turning the option off restores the previous paper.

### Step 8
- **Plugin context:** split methods now get `settingsOf(sectionId)`, `imageLongEdge`, and `texelScale` (so radii are resolution-independent across preview, zoom detail, and export tiles).
  - They can declare `reach()` (an extra margin for tiles/regions) and `needsPrepare()`.
  - They can offer a preview-only `previewOverride()` (used for masks; never exported).
- **Tone Map Advanced:**
  - One curve per ink (a per-ink curve setting), edited in a custom block with a preset menu per ink: Shadow ink, Midtone ink, Highlight tint, Full range, Off.
  - Switching Simple → Advanced turns the current bands into curves (sampled, then simplified with Douglas–Peucker at tolerance 0.01). The image doesn't change: measured mean difference 0.3/255.
  - **Link curves:** dragging a point on one curve moves the nearest interior point (or the same end point) of every other ink's curve by the same amount. Adding and removing points isn't linked.
  - The live strip works in both modes; the histogram and bands show only in Simple.
- **Channel Split:**
  - Color spaces: RGB (inverted), CMYK with black generation (0–100%, GCR-style), Lab (L inverted; a/b split into ± halves, scaled by 90), HSL, and YCbCr (Cb/Cr split optional).
  - Each channel routes to an ink or is dropped, with intensity (gain, clipped) and opacity (maximum contribution).
  - Merged channels combine by Add, Max, Average, or Screen.
  - The advanced mixer matrix (per ink: weight per channel + offset) starts from the current routing when turned on, so the image doesn't jump.
  - Doesn't depend on ink colors.
- **Selective Color:**
  - Up to 6 ranges: hue center/width, saturation and lightness limits, feather (hue fade up to 60°, sat/light fade up to 0.25), and an ink. Membership is computed in HSL from sRGB.
  - Density source: saturation, darkness, or constant.
  - The base ink ("auto" = darkest) prints everything outside the ranges as grayscale.
  - "Add range from image" and per-range eyedroppers set the hue and ±35% saturation/lightness limits.
  - The per-range mask preview is preview only.
- **Detail Split:**
  - A Gaussian blur (radius in thousandths of the long edge) makes the base; the base method runs on it with its own settings, and its worker job (e.g. Ink Matching's lookup table) is reused.
  - Detail is one of: high-pass (blur − sharp luma, ×contrast×8, − threshold), line art (thresholded high-pass), or edges (Sobel).
  - The detail is screened onto the detail ink ("auto" = darkest).
  - Export tiles add the blur radius as margin.
- **Eyedropper:** now supports custom targets (used by Selective Color).

### Step 9
- **Layer stage order:** tone (invert → levels → curve → density, one 256-entry table per ink) → knockout → choke/spread → total ink limit.
- **Per-layer levels:** "ink starts at" / "full ink at" / midtone (gamma `2^(v/50)`) act on coverage. There is also a per-layer point curve. Both sit in a collapsible "Levels, curve, trapping" area on each layer row.
- **Knockout:** per layer ("KO" toggle). The layer clears the layers printed before it, in proportion to its own coverage. Layers are processed top-down, so a layer that's already cleared only knocks out where it still prints.
- **Choke / spread:**
  - Per layer, in output px (−8 to +8), done as a separable max/min filter in two passes. Fractional radii blend the last pixel.
  - Applied after knockout, so spreading a lower layer fills the gap a knockout leaves.
  - The radius (converted to image px) is added to the detail-view and export-tile margins.
- **Total ink limit:** 100–400% (400% = off). When the combined coverage is over the limit, all inks are scaled down proportionally.
- **Measured (smooth riso export, 4 inks, scene image):**
  - Knockout: yellow over 50% reduced blue under it from 0.79 to 0.05, and left black (printed after) unchanged.
  - Spread +4 / choke −4 px: black coverage 0.126 → 0.186 / 0.081.
  - Ink limit 150%: max combined coverage 262% → 151%.

### Step 10
- **New types:** AM hex grid, AM noise grid (blue/pink/green), AM phyllotaxis spiral, AM concentric rings (dots or continuous lines), and FM error diffusion (Floyd–Steinberg, Atkinson, Jarvis, Stucki). Registered in `plugins/halftone/registry.ts` next to AM square and FM blue noise.
- **Shared lattice framework** (`plugins/halftone/lattice.ts`):
  - Each non-square AM grid only answers "which dot center is nearest to this point?".
  - Tone is exact for any grid and dot shape (round, square, ellipse, diamond, line). A 256-step threshold table per grid + shape is measured once by sampling 64k points, so a 30% tone inks 30% of the area.
  - Shared per-ink dot settings: maximum dot, shape, and a dot size curve.
- **Hex:** cell size is scaled so a hex cell has the same area (dot density) as a square cell of that size. Angles repeat every 60°; defaults are 0/30/15/45° (15° apart, the most two hex screens can differ).
- **Noise grid:** one dot per cell of a square grid, nudged by a noise field; each ink reads the field at its own seeded offset.
  - *Fix after review:* the first version used a 64 × 64-cell tile that visibly repeated, and green noise pulled dots toward clusters on a regular grid (a repeating 3 × 3 look). The field is now 1024 × 1024 cells, built in the halftone worker (`engine/halftone/noiseField.ts`), so it doesn't repeat within 8192 px at 8 px spacing.
  - Blue = high-passed white noise; pink = smooth noise summed over scales 2–256 cells (1/f); both rank-equalized. Green = dots pushed up the slope of a smooth random field, so they gather at randomly placed hilltops about one cluster size apart, with the move's length clamped to half a cell.
  - Noise amount is now a shader uniform (no rebuild). Builds take 0.2–1.1 s in the worker.
- **Spiral:**
  - The point table is built in a worker, sized to reach the output's farthest corner, and bucketed for GPU lookup.
  - Divergence 137.5° (the default, and anything that rounds to it) uses the true golden angle, 137.5078°. Exactly 137.5° is 55/144 of a turn, which lines points up into 144 visible spokes away from the center.
- **Rings:** ring spacing per ink, dots along the rings with a spacing ratio, or continuous lines; the center is movable, and per-ink rotation moves dots along the rings.
- **Error diffusion:**
  - Needs the whole image, so it is not a shader. The coverage is read back and diffused in a worker (`workers/halftone.worker.ts`), then drawn from a bitmap texture.
  - Preview: up to 2048 cells across. Export: full output resolution (the coverage is rendered in bands through `renderRegion`), on a separate worker so preview changes can't cancel it.
  - Settings: kernel, dot size (never below the largest minimum dot), square/round dots, serpentine scanning, threshold noise, seed.
- **FM: stipple** (added at the user's request; not in the outline): hand-stippled dots with no grid.
  - Placement: ~524k best-candidate points on a 512 × 512 dot-unit torus, ranked in placement order so every prefix is evenly spread; a dot prints when its rank is below the rank threshold for the tone at its center. Built once per session in the halftone worker (~3.7 s, background). Per-ink seeded offsets, and each repeat of the tile hashes its dots differently, so repeats aren't visible.
  - Every dot is drawn from a formula driven by hashes of its id (no sprite library): size (variation), size following tone, angle, stretch, polygon sides (Chip), low-harmonic wobble, high-harmonic edge roughness, value-noise grain; bleed merges neighbors with a smooth minimum of signed distances.
  - Settings: dot size (per ink), shape (Round / Chip / Dash), size variation, size follows tone, placement irregularity, shape wobble, edge roughness, stretch, direction, direction variation, ink bleed, ink grain, seed.
  - Tone: the same dot formula runs on the CPU in the worker to measure, for 33 tones, the rank threshold that inks exactly that share of paper (lazy evaluation in rank order; 0.13 s at defaults, ~1.1 s at extreme settings). Measured ΔE at fit ≤ 2.3; export coverage within ~2.5% of smooth per patch.
  - Methods may now declare `reach()` (export tile margin) when dots reach farther than 1.5 × their size.
- **Plugin interface additions:** `prepare`/`prepareKey` get the output size; `fromCoverage { cell, build }` for whole-image methods; `uniforms` receives the bitmap.
- **PNG encoder fix:** fflate's streaming `Zlib` (0.8.3, the latest) wrote corrupt streams for hard-to-compress data pushed in many pieces ("invalid distance too far back"). `export/png.ts` now uses the browser's built-in `CompressionStream("deflate")`, with backpressure. fflate is still used for the zip.
- **Measured:**
  - Tone at fit vs smooth (5 patches, 3 inks, ΔE): noise ≤ 2.4, hex ≤ 0.8, diffusion ≤ 1.2.
  - Spiral ≤ 5.7 and rings ≤ 5.2 with 3 inks, but ≤ 0.5 with one ink. The gap is real: inks that share a center overlap in a fixed pattern rather than at random, as the smooth mix assumes. That is how these screens would print.
  - Full-resolution riso layers: per-patch coverage within 0.006 of smooth for hex, noise, spiral and rings.
  - Error diffusion re-diffuses in ~1.5 s (preview, SwiftShader); the UI stays responsive meanwhile.

### Step 11
- **Units:** all border sizes are % of the image's shorter side, so a border looks the same in the preview, the zoomed detail view and an export at any size or DPI.
- **Fade:** runs inside the adjust pass, before levels/curve/saturation, so it is split and halftoned like the image. The strength comes from a 256-step table built on the CPU (linear, smooth, exponential or a custom point curve, then bent so it reaches 50% at the midpoint); the very edge is always the full fade color. Blended in sRGB so a linear fade looks even; it also makes transparent edges opaque. Every pass knows which image px it covers, so tiles and detail renders fade identically.
- **Solid ink / paper border:** drawn after processing by the preview (compositor and smooth view) and the export, never split or halftoned. Solid ink sets its ink to 100% and removes every other ink there; paper removes all ink.
  - Positive thickness grows the canvas: the preview fits the whole canvas, and the export grid gets the border added on each side (e.g. 1200 px image + 2 × 32 px at 4 in / 300 DPI). Export sizes in the panel are for the image; the summary shows the total.
  - Negative thickness covers the image's edge; the canvas stays the same size.
  - Halftone patterns stay anchored to the image, so adding a border never moves the dots.
  - Corner radius rounds the image opening (the border's inner edge). The fade has its own corner radius and starts at the visible edge (inside a negative border).
  - With fade and a border together, the fade runs inward from the border's inner edge.
- **Measured (riso export, scene image, 3 inks, 4 in / 300 DPI):** +4% solid border on ink 2 → 1264 px wide; top band 100% ink on layer 2 and 0% on the others; −4% keeps 1200 px with the same result; paper border 0% ink on all layers; fade to white → 0 ink on the very edge column vs 5–59% in the center column.
- **Preview fix:** the smooth view's anti-aliased border edge blended with the preview background just outside the image (a faint light line); outside the image it now blends with the border color.

### Step 12
- **Where it runs:** `app/printSim.ts` holds one GLSL module used by the halftone compositor (preview), the export shaders and the mix pass (halftone None), plus the uniform builder. The effects act on each ink before mixing:
  - **Misregistration:** each ink is read at its own shifted and rotated position (around the image center); a solid ink border moves with its ink. Shift in output px, rotation in degrees, seeded per ink.
  - **Dot gain:** raises the tone every halftone type receives (`htCoverage` = gain(raw coverage)), so dots print bigger; midtone-weighted (c + 4a·c(1−c)) or uniform (c·(1 + 2a)); per-ink amount × paper absorbency (smooth 0.6, uncoated 1, recycled 1.4). Edge roughness jitters the sample position by value noise (~1.5 px), which rags dot edges.
  - **Low-ink patches:** a slowly varying "lost ink" share per ink (blotches = rotated, domain-warped fractal noise; drum streaks = noise stretched along the feed direction; edge fade = falloff from one side), multiplied by a blurred coverage map (area-averaged to ~128 px) so solids starve first, then thresholded and feathered. Halftoned inks lose that share of their pixels as fine grain; smooth coverage is scaled down. Per-ink or shared seed.
  - **Specks:** one candidate per grid cell (≥ 4 × the largest speck), with density per megapixel, size range, extra/pinhole ratio, clumping (large-scale noise), placement (extra near ink or anywhere), opacity (broken-up specks) and a per-ink switch.
- **Modes:** effects show in the preview in both modes and are baked into Digital exports; riso layer exports never get them (verified bit-identical with the simulation on and off).
- **Dot gain compensation** (Export, Print mode): pre-shrinks coverage by the inverse gain curve in riso layers (halftoned and smooth), and the Print mode preview shows the compensated dots. Measured with 12% midtone gain: ink 0.760/0.088/0.472 → 0.672/0.071/0.402.
- **Stage:** "printSim" (after layer options) builds the coverage map when needed and the uniforms; mix and the compositor use them. Tile and detail margins grow by the misregistration reach.
- **Performance:** with the effects off (riso layers, or Simulate printing off) a pass-through variant of the GLSL is compiled instead (only compensation stays). The full code in every shader had slowed the A3 riso export from 11 s to 68 s on the software GPU; with the variant it is back to 12 s.
- **Test fix:** Step 9's knockout check and Step 6's summary rounding were test mistakes (fixed in Step 11). Running two browser tests at once on the software GPU makes timing-based checks fail; the suites are run one at a time.
- **Known limits:** error diffusion's bitmap is built from raw coverage, so dot gain and compensation don't change it (misregistration, patches and specks do apply). Specks in the smooth view are sampled at working resolution.

### Step 13
- **Layout** (`app/layout.ts`): one function gives the output size, the artwork's place (image plus any border) and the output scale, for the export, the preview and the halftone sizes. Replaces `app/output.ts`.
  - Digital: 0.5× / 1× / 2× / 3× / custom width; with the aspect ratio unlocked, custom width × height with the artwork fitted or filled (the rest is paper, or transparent).
  - Print: Letter, Legal, Tabloid, A4, A3, B4 (JIS, 257 × 364 mm), custom (in or mm), or "Image only" (the old behavior: the file is the artwork at a set width). Portrait/landscape, DPI (600 default), placement fit (inside the margins) / fill (page + bleed, cropping) / custom (width + position), margins (mm, default 5), bleed (mm, grows the file on every side).
- **Riso export:** layers as PNGs or one PDF (a gray page per layer, at the page's physical size); a composite proof (the page at 150 DPI with the print simulation as the preview shows it, on the paper color); a print sheet (letter PNG: page setup, inks in order with swatches and file names, and the split/halftone/layer settings from the schema); all zipped.
- **Marks** (`export/marks.ts`): crop marks at the artwork corners (the page's with Fill), registration targets centered on each side, layer labels ("project · layer n of N · #HEX") in the bottom margin. Drawn once as small stamps and pressed into each strip, identical on every layer (labels per layer). Only marks that fit on the page are drawn.
- **Standard printer:** one color page (PNG with DPI, or PDF with the sRGB profile), no print simulation; crop marks available.
- **Color files:** JPG quality; transparent PNG background (RGBA: paper samples transparent, ink keeps its printed color; smooth None separates the paper back out of the mix); "Embed sRGB profile" (PNG sRGB chunk; JPG APP2 ICC and PDF ICCBased with a generated v2 sRGB profile, `export/icc.ts`). The browser's JPG encoder adds its own profile, so ours replaces it (never two), and turning the option off removes it.
- **Preview:** in Print mode the page is shown around the artwork (sheet in the paper color, page edge, trim line with bleed, the margins as a red dashed guide, the marks), and Fit shows the whole page.
- **Shared pieces:** `export/deflate.ts` (streaming zlib via CompressionStream, used by PNG and PDF), `export/pdf.ts` (minimal image-per-page PDF writer). Export tiles that miss the artwork are filled without the GPU; the shaders fill outside the artwork and can render reduced-resolution grids with supersampling (the proof).
- **Measured:** page sizes exact at 600 DPI for every preset, landscape and bleed (e.g. Letter 5100 × 6600, A4 4961 × 7016, A4 + 3 mm bleed 5102 wide); Letter riso export with marks at 600 DPI in ~7 s (3 inks, software GPU); marks identical across layers (25,671 shared mark px, labels 2,100–2,250 px per layer); PDF: 3 pages, MediaBox 612 × 792 pt, image streams decode to full pages; proof 1275 × 1650 at 150 DPI; standard printer page identical with the simulation on or off; transparent PNG corner α 0; JPG 619 KB at 60% vs 1,966 KB at 98%.
- **Image width means the artwork:** in Image only and Custom placement, Image width is the whole artwork (image plus any border), like Fit. A +4% border therefore keeps a 4 in file 4 in wide (1200 px) and makes it taller (820 px instead of 800); before Step 13 the border was added on top of the width.
- **Tests:** earlier suites now choose "Image only" + Image width (the old Print width) and switch off the proof and sheet, so they keep testing the same files.
- **Fixed during testing:** registration targets in the reduced-resolution proof had a stray line (a stamp lookup read outside the stamp); a literal NUL byte slipped into `icc.ts` from an edit script and was replaced with an escape.

### Diagnostic pass (2026-10-02, before Step 14)
- **Stipple crash fixed:** at high output resolution one stipple preview draw ran past the ~2 s Windows GPU watchdog (measured 2.1 s for a 530 × 530 view at 3× on Intel UHD 630; 64 samples per pixel × up to ~400 dots per sample), so the driver reset and the WebGL context was lost. The compositor and the export output pass now draw in timed bands (`engine/gl/bands.ts`). Measured after: 1230 × 930 view at ~7× output in 132 bands, slowest 177 ms; stipple riso export with proof at 600 DPI, slowest job 170 ms.
- **Export settings lock:** the export reread live pipeline state per tile, so a change during an export gave a file split between old and new settings (confirmed with a seam in an A3 1200 DPI layer). The pipeline is now held during exports.
- **GPU reset notice** with a Reload button; the pipeline stops running once the context is lost.
- **Export size limits** (32768 px per side, 1,000 MP, PDF pages ≤ 200 in) shown under the summary, with the button disabled.
- **Ink mixing test** now only with `?debug` (it also made a second WebGL context on every load).
- **Print sheet:** the total ink limit was listed twice (Layers is a sub-section of Color Splitting); changed per-ink layer options (density, invert, levels, curve, knockout, choke/spread) are now listed.
- **Background failures** (Ink Matching, halftone maps, dithering) show a notice instead of failing silently.
- **GPU memory:** textures from worker results are capped (`engine/gl/textureCache.ts`); the shared float-table cache keeps the last 64.
- **Checked:** all 180 combinations of mode × simulation × split method × halftone type with no errors; every export format; the production build under the site's CSP (`kawa_website/public/_headers`).
- **Website, left for later:** the site's CSP has no `blob:` in `img-src`, which the fallback image loader for older browsers needs; `npm run build:site` and an embed page are not done yet.

## Open questions

- None right now.
