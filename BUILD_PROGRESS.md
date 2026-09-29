# Build Progress

## Steps

| Step | Name | Status |
|---|---|---|
| 0 | Setup and architecture | ✅ Done |
| 1 | Upload, modes, and preview canvas | ✅ Done |
| 2 | Palette (basic) | ⏳ Next |
| 3 | Rendering engine core | — |
| 4 | Image adjustments, color splitting (basic), shared layer options | — |
| 5 | Halftone (basic) | — |
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
- **Per-ink values:** always arrays of length 4. Per-ink controls are built in Step 2.
- **Sample settings:** so mode switching can be seen, Export has two real settings from the spec: Digital › Format (PNG/JPG) and Print › Resolution (600 DPI).

## Open questions

- None right now.
