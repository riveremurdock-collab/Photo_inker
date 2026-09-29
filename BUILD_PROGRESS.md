# Build Progress

## Steps

| Step | Name | Status |
|---|---|---|
| 0 | Setup and architecture | ✅ Done |
| 1 | Upload, modes, and preview canvas | ✅ Done |
| 2 | Palette (basic) | ✅ Done |
| 3 | Rendering engine core | ✅ Done |
| 4 | Image adjustments, color splitting (basic), shared layer options | ✅ Done |
| 5 | Halftone (basic) | ⏳ Next |
| 6 | Export (basic) | — |
| — | *End of basic build: overall report* | — |
| 7 | Full palette options | — |
| 8 | Remaining color splitting methods | — |
| 9 | Complete shared layer options | — |
| 10 | Remaining halftone types | — |
| 11 | Border | — |
| 12 | Print simulation | — |
| 13 | Full export options | — |
| 14 | Performance and polish | — |

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

## Open questions

- None right now.
