# Build Progress

## Steps

| Step | Name | Status |
|---|---|---|
| 0 | Setup and architecture | ✅ Done |
| 1 | Upload, modes, and preview canvas | ⏳ Next |
| 2 | Palette (basic) | — |
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

- **Step 0: plain TypeScript + Vite 5, no UI framework.** This matches the stipple tool (`../stipple tool`), so code copies across cleanly.
- **Step 0: zero runtime dependencies.** spectral.js math will be vendored as source with its MIT notice, so it can also be ported to GLSL.
- **Step 0: coverage data.** A `CoverageSet` holds up to 4 inks, stored as one RGBA texture (one ink per channel) on the GPU.
- **Step 0: static hosting.** `base: "./"` means the `dist/` build works from any folder on a static host.
- **Step 0: spec location.** The spec lives at `Docs/` (capital D); the build plan says `docs/`. Left as is.
- **Step 0: temporary smoke test.** A ping worker and a status line show that WebGL2 and workers work. Both will be removed or replaced in Step 1.

## Open questions

- Should there be a `build:site` script that outputs into `../kawa_website/public/photo-inker`, like the stipple tool does? Not added yet.
