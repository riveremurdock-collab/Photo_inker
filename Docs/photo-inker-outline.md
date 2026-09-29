# Photo Inker

Web App Outline

## Overview and Purpose

Photo Inker is a web app for editing images for risograph printing, and for creating standalone digital images that look like they were riso printed. It has two modes:
- Digital mode — exports a single riso-style digital image.
- Print mode — exports each ink color as a separate black-and-white layer, ready to be made into a riso print.

## Main Features

### 1. File Upload

The first step is uploading an image.
- Choose Digital mode or Print mode. The settings shown in later steps change depending on which mode is selected.

### 2. Palette Options

Choose up to four ink colors, plus a background color (the paper color in Print mode). There are three ways to build a palette:
- Manual — pick each color with a color picker, by entering a color code, or with an eyedropper on the base image.
- Color scheme — choose the first color and the rest are generated from the selected scheme. Each scheme locks in its number of colors:
  - Complementary — 2 colors
  - Analogous — 3 colors
  - Triad — 3 colors
  - Square — 4 colors
  - Monotone — 3 colors
  - CMYK analog — a fixed set of four riso inks standing in for CMYK: Medium Blue (C), Fluorescent Pink (M), Yellow (Y), and Black (K). This does not generate from a first color.
- Include background in scheme — toggle. When on, the background color takes up one of the scheme’s color slots (for example, a triad becomes 2 inks + background). When off, the background is chosen separately.
- Auto — picks the dominant colors in the image, matching the number of inks selected. Option to include the background in the auto palette, or keep it as a manually chosen color.

### 3. Image Adjustments

Adjustments applied to the base image before color splitting. These apply to every splitting method.
- Levels — black point, white point, and midtone.
- Contrast curve — point curve applied to the whole image.
- Saturation boost — increases saturation before splitting (most useful with Ink Matching).
- Smoothing — softens noise and fine texture before splitting.

### 4. Color Splitting

After choosing a palette, a color splitting method decides how ink is placed to represent the image. Each method is described below, followed by options shared by all methods. Curves and invert are only set in the shared options.

#### Tone Map

How it works: Maps the image’s lightness to ink density. Simple mode divides lightness into 1–4 bands (such as shadows, midtones, and highlights), each assigned an ink, with overlap zones blending neighboring inks. Advanced mode gives each ink its own curve from lightness to density, and the inks stack like a duotone or tritone. Simple mode is a preset built on the same curve engine, so switching to Advanced shows the bands as editable curves.

Best for: High-contrast photos, poster or graphic looks, adding color to black-and-white images in bands, rich duotones, portraits, and precise control over how inks mix across the tonal range.

Options:
- Mode — Simple (bands) or Advanced (curves).
- Lightness source — luma, L*, a single channel, or max/min RGB.
- Live strip — shows the resulting color at each tone.

Simple mode options:
- Number of bands.
- Cutoff handles, dragged directly on a histogram.
- Ink per band (the same ink can be used in several bands).
- Overlap width at each boundary.
- Falloff shape: hard, linear, or smooth.
- Fill inside each band: flat or keep the tonal gradient.
- Posterize steps within a band.

Advanced mode options:
- Point or bezier curve editor per ink.
- Presets such as shadow ink, midtone ink, and highlight tint.
- Link curves so they move together.

#### Channel Split

How it works: The image is converted to a color space, and each channel becomes one ink’s density layer.

Best for: Quick full-color approximations, ink sets close to CMY, and experimental color shifts.

Options:
- Color space: RGB (inverted), CMYK, Lab, HSL, or YCbCr.
- Which ink each channel goes to.
- Merge channels into one ink, with a blend mode (add, max, average, or screen).
- Drop a channel.
- Intensity and opacity sliders per channel.
- CMYK only: amount of black generation (how much of the dark tones go to the black ink).
- Lab only: split the a and b axes into their positive and negative halves, so one axis can drive two inks (for example, a+ to red and a− to green).
- Advanced mixer matrix: each ink is a weighted mix of every channel plus an offset. This covers merging, dropping, and intensity in one control.

#### Ink Matching (Unmixing)

How it works: Uses the selected inks’ actual colors. For each pixel, it solves for the amount of each ink that best reproduces the original color, using the same ink model as the Rendering Engine and a perceptual (Lab) color difference.

Best for: Realistic photo reproduction with any ink set, and as a default starting point for the other methods.

Options:
- Priority per ink, which decides which ink wins when several combinations would work.
- Sparsity: prefer fewer inks per pixel, for cleaner and less muddy results.
- Out-of-gamut handling: clip or compress.
- Slider between preserving lightness and preserving hue.

#### Selective Color (Hue Ranges)

How it works: You define color ranges, and pixels inside each range go to its assigned ink. Everything else can go to a base ink.

Best for: Spot-color accents, one color on a black-and-white image, and product shots where a specific color has to read correctly.

Options:
- Add ranges with an eyedropper.
- Hue center and width per range.
- Saturation and lightness limits per range.
- Feather amount per range.
- Density source: saturation, lightness, or constant.
- Ink per range.
- Base ink for everything else.
- Mask preview per range.

#### Detail Split

How it works: Separates the image into fine detail (edges and texture) and a blurred base. The detail layer goes to one ink, usually the darkest, and the base is split by any other method.

Best for: Keeping images sharp despite misregistration, illustrative looks, and textured subjects.

Options:
- Split radius, which sets what counts as detail.
- Detail mode: high-pass, line art, or edge detection.
- Detail contrast and threshold.
- Ink for the detail layer.
- Method used for the base layers (Tone Map, Channel Split, Ink Matching, or Selective Color).

#### Shared Options (All Methods)

These act on the output layers, whatever method made them:
- Per-layer curves, levels, density, and invert
- Knockout or overprint — per layer, choose whether it clears the layers beneath it. Covers accent inks over a base ink and detail layers over base layers.
- Choke or spread (trapping) — grows or shrinks a layer slightly so gaps don’t show when drums misalign.
- Total ink limit
- Print order
- Solo or mute — each layer in the preview.

### 5. Halftone Settings

One halftone method is chosen for the whole image, and every ink layer uses it. Settings such as size, angle, and density are set per ink, so each layer gets its own halftone. Layers are placed independently (coordinated layer placement is saved for later).
- Whole-image analysis — tone, edges, and structure are analyzed once from the full image, and every layer’s halftone is built from that shared analysis. This keeps dot direction and clustering consistent between layers.

There are three options:
- None (printer halftone) — no halftone is applied. Ink layers stay as smooth grayscale, and in Print mode they export that way so the riso machine screens them itself (using its Grain Touch or Screen setting). The preview shows smooth ink tones.
- Amplitude shading (AM) — dots sit on a set grid, and dot size simulates darkness and shading.
- Frequency shading (FM) — dot density simulates shading.

#### Shared Halftone Settings
- Minimum dot size — set per ink. The smallest dot allowed, in pixels at export resolution (for example, 1–2 px at 600 DPI). Riso machines struggle to print very light tones (roughly under 10%), so dots smaller than this are not made. Tones lighter than the minimum can either drop out to paper or round up to the minimum dot.

Minimum dot size does not apply when the halftone is set to None.

#### Amplitude Shading Grid Types

Settings on all AM grids: cell size (or LPI), dot shape (round, square, ellipse, diamond, or line), maximum dot size and dot size curve.
- Noise grids (blue, pink, green) — grid spacing and random seed. Green noise adds a cluster size setting.
- Square grid — angle per ink, with standard presets (for example, 15°, 75°, 0°, and 45°) to avoid moiré.
- Hex grid — angle per ink.
- Phyllotaxis spiral — point spacing, divergence angle (default 137.5°), and center point.
- Concentric rings — ring spacing, dot spacing along each ring, and center point. Option to draw continuous lines whose width changes instead of dots.
- Regular grid angles — each regularly spaced grid has a grid angle setting per ink.

#### Frequency Shading Placement Methods

Settings on all FM methods: dot size, dot shape, and random seed.
- Blue noise density (main quick option) — uses a blue noise threshold map, built with the void-and-cluster method, and places more dots in darker areas. Settings: minimum and maximum density, threshold map size (64, 128, or 256), and filter spread.
- Error diffusion — kernel (Floyd–Steinberg, Atkinson, Jarvis, or Stucki), serpentine scanning, and threshold noise.

### 6. Border

Adds a border around the image. There are three border types: Fade, Solid ink, and Paper. A fade border can be used together with a solid ink or paper border.

#### Fade Border

Works like a vignette. Fades black or white inward from the page edge so the image has a soft edge instead of a hard edge.

Processing: The fade is applied to the image before processing, so it goes through the same color splitting and halftoning as the rest of the image. This way the edge fade matches the look of the rest of the image. In the app layout this section sits after Halftone Settings, but the fade runs before Image Adjustments and Color Splitting.

Settings:
- Color — black or white. The very edge is always pure black or pure white.
- Distance — how far the fade reaches inward from the edge.
- Corner radius — rounding of the page corners.
- Opacity
- Fade curve — shape of the falloff from the edge inward:
  - Linear — even fade.
  - Smooth — eases in and out, like a camera vignette.
  - Exponential — stays strong near the edge, then drops off quickly.
  - Custom — point or bezier curve editor.
- Fade midpoint — where the fade reaches 50% strength, as a percentage of the distance.

#### Solid Ink Border

A solid border in one of the palette’s ink colors.

Processing: Added directly to its ink layer after processing (not split or halftoned). All other inks are removed from the border area.

Settings:
- Ink — one of the selected ink colors.
- Thickness — positive values grow the border outward from the image edge; negative values eat into the image.
- Corner radius

#### Paper Border

A border with no ink, showing the bare paper.

Processing: Removes all inks from the border area after processing.

Settings:
- Thickness — positive values grow the border outward from the image edge; negative values eat into the image.
- Corner radius

### 7. Print Simulation

Settings that help you visualize how the physical print will look.
- Print mode — simulation is preview-only and does not appear in the export.
- Digital mode — simulation is baked into the exported image.

#### Master Toggle
- Turns all print simulation settings on or off.

#### Layer Misregistration
- Amount of random offset between layers, in both position and rotation.

#### Low-Ink Patches

Simulates patches of low ink on the drum. Settings: intensity, patch size, and the algorithm that defines patch shapes.

How patch shaping could work:
- Build a coverage map for each layer by blurring its ink density. Riso tends to run starved in large solid areas, so patches should appear mostly where coverage is high.
- Multiply the coverage map by a shape noise, then threshold and feather the result to make the patch mask.
- Shape noise options:
  - Fractal noise — soft organic blotches. Settings: scale, detail (octaves), roughness.
  - Drum streaks — noise stretched along the paper feed direction, giving riso-style banding. Settings: direction, streak length, frequency.
  - Edge fade — ink thins toward one side of the sheet. Settings: side, falloff distance.

Low-ink settings:
- Intensity: how much ink is lost in a patch.
- Patch size.
- Shape algorithm (above).
- Coverage influence: how much solid areas attract patches.
- Edge softness.
- Per-layer or shared random seed, with a re-roll button.

#### Specks

Simulates specks of extra or missing ink from printing.
- Density: specks per area.
- Size range: minimum and maximum speck size.
- Extra vs. missing ratio.
- Clumping: scattered or grouped.
- Placement: missing specks only appear inside inked areas; extra specks can appear anywhere or only near ink.
- Opacity.
- Per-layer toggle and random seed.

#### Dot Gain

Simulates ink spreading into the paper, which makes dots print larger and darker.
- Amount: percent gain at 50% tone.
- Gain curve: uniform or midtone-weighted (real gain is strongest in the midtones).
- Per-ink amount, since inks spread differently.
- Paper absorbency preset (for example, smooth, uncoated, or recycled).
- Edge roughness: how ragged dot edges become.
- Compensation (Print mode export): pre-shrinks dots to offset the expected gain.

### 8. Export

Export options change depending on the mode. All exports use the project name for file naming.

#### Digital Mode
- Dimensions — width and height in pixels, with aspect ratio lock and scale presets (for example, 1x and 2x).
- Format — PNG or JPG.
- JPG quality — slider.
- Transparent background — PNG only. Exports the paper color as transparent.
- Color profile — embed sRGB.
- Print simulation — always baked in when enabled.

#### Print Mode: Riso

Exports one black-and-white file per ink color.
- Page size — Letter, Legal, Tabloid, A4, A3, B4, or custom, plus orientation.
- Resolution — DPI, defaulting to 600 to match riso output.
- Image placement — fit, fill, or custom scale and position on the page.
- Margins — non-printable area guide (riso needs roughly 5 mm) and optional bleed.
- Registration and crop marks — toggle.
- Layer labels — project name, ink color, and print order, printed in the margin and used in file names (for example, ProjectName_01_FluorescentPink.png).
- File format — grayscale PNG, or PDF (one page per layer).
- Dot gain compensation — toggle (see Print Simulation).
- Extras — composite color proof image and a print sheet listing inks, order, and settings.
- Bundle — download all files as a zip.

#### Print Mode: Standard Printer

Exports a single file for standard printers.
- Page size, resolution, placement, and margins — same options as Riso.
- File format — PDF or PNG.
- Output — composite color image.
- Print simulation — not applied.

## Rendering Engine

How the app turns ink layers into an accurate on-screen preview and Digital mode export, while staying fast. The goal is for overlapping inks to mix the way real riso inks do, rather than using a simple multiply blend.

### Ink Model
- Spectral colors — each ink and the paper color are stored as a reflectance curve across the visible spectrum instead of 3 RGB values. Curves are generated from the chosen color by blending premade red, green, and blue reflectance curves, the same approach used by the open-source spectral.js library (MIT license).
- Transparent layering — riso ink acts like a transparent colored film over paper. Each overlap color is the paper’s reflectance multiplied by each ink’s transmittance, band by band, then converted to screen color. Light passes through the ink on the way in and on the way back out, so each ink’s transmittance is applied twice. This avoids muddy results like yellow + blue turning olive.
- Ink opacity — each ink has an opacity slider. Raising it makes the ink partly cover what is beneath it, for denser inks like metallics and white.
- Print order — inks are layered in print order. Order has little effect on transparent inks, but matters when an ink’s opacity is raised.
- Shared with Ink Matching — the Ink Matching splitting method uses this same ink model, so what the solver matches is exactly what the preview shows.

### Precomputed Overlap Colors
- Solid overlap table — whenever the palette, paper color, or print order changes, the color of every ink combination is calculated once (16 combinations for 4 inks: paper, each ink alone, and every overlap). After halftoning, each pixel is one of these combinations, so rendering becomes a fast lookup.
- Partial coverage — pixels with partial ink (anti-aliased dot edges, tints, previews before halftoning, and the None halftone option) run the spectral mix directly in the GPU shader.
- Swappable model — rendering only reads the overlap table and the shader’s ink model, so the ink model can be changed or upgraded later (for example, to measured colors) without affecting the rest of the pipeline.

### Color Pipeline
- Linear light — all mixing, blending, and resizing happens in linear light, and colors are converted to the display format only at the final step.
- Accurate zoomed-out previews — when halftone dots are smaller than a screen pixel, they are averaged in linear light, which keeps tones the same at every zoom level.
- Screen color — renders in sRGB, with gentle gamut compression instead of hard clipping for very vivid colors like fluorescents.
- Print simulation — misregistration, low-ink patches, specks, and dot gain act on the ink layers before they are mixed, so simulated flaws blend like real ink.

### Preview and Export
- Preview — renders at screen resolution. Full resolution is only rendered for export or when zoomed in to 100% or more.
- Stage caching — each processing stage (adjustments, splitting, halftone, border, simulation, mixing) is cached. Changing a setting only reruns the stages after it; for example, changing an ink color only redoes the overlap table and final mix.
- GPU and background processing — per-pixel work (adjustments, splitting, mixing, simulation) runs as GPU shaders (WebGL or WebGPU). Heavy algorithms like error diffusion and threshold map generation run in Web Workers so the interface stays responsive.
- Digital mode export — uses the same renderer as the preview at full resolution, processed in tiles to limit memory use.
- Print mode export — skips color mixing and outputs the raw black-and-white ink layers.

### References
- spectral.js — open-source JavaScript spectral color library; source of the color-to-spectrum conversion.
- Spectrolite — free desktop riso separation app by ANEMONE; closest existing tool.

## Save for Later

Features planned for later phases. They are higher effort, so the core app should be built and working first.

### Halftone
- Layer interaction — how dots on different ink layers relate. Coordinated: layers are placed together so dots of different inks interleave instead of randomly colliding. Aligned: dots stack where inks overlap. (Launch uses independent layers.)
- Turing pattern grid (AM) — feature scale, spot vs. stripe balance, and iterations. The simulation is slow, so it may need to be generated at lower resolution and scaled up.
- Penrose tiling grid (AM) — tile size, rotation, tile set (kites and darts or rhombs), and gap between tiles. Tile shapes shrink instead of dots.
- Archimedean tiling grid (AM) — tiling type (for example, 4.8.8 or 3.6.3.6), tile size, rotation, and separate scaling per tile shape. Tile shapes shrink instead of dots.
- Structure-aware placement (FM) — places dots so they follow edges and contours, like hand stippling.

How structure-aware placement could work:
- Measure local edge direction and strength across the image using a smoothed structure tensor (from the shared whole-image analysis).
- Start from a blue noise density placement.
- Relax the dots over several passes using a stretched distance, so spacing is tighter along edges than across them. Dots settle into rows that follow the form.
- Optionally stretch each dot along the local direction.

Structure-aware settings:
- Edge sensitivity: how strong an edge must be to affect dots.
- Alignment strength: how tightly dots line up along edges.
- Structure scale: blur radius used to measure direction (small follows fine texture, large follows overall form).
- Edge emphasis: extra dot density on edges.
- Dot elongation along the edge direction.
- Iterations.

### Print Simulation
- Paper texture — choose from different paper texture backgrounds. Paper textures need to be gathered and uploaded first.

### Rendering
- Wide color — render in Display P3 where the browser supports it, so fluorescent inks look more vivid.
- Calibration — print and measure a test sheet of every ink and overlap, and use the measured colors in place of the estimated ones.
