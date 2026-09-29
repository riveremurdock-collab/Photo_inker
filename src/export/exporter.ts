// Full-resolution export, processed in tiles so memory stays bounded.
//
// For each tile of the output pixel grid, the pipeline's passes (copy →
// adjust → split → layer options) run for just that part of the image from
// the full-size source (with a margin for smoothing and for halftone cells
// that straddle the tile edge). An output pass then writes the tile's pixels,
// which stream into the file encoders strip by strip.
//
// - Digital: one PNG (streamed) or JPG, using the same halftone code as the preview.
// - Print (Riso): one grayscale PNG per ink at the chosen DPI, in print order,
//   zipped. Halftoned layers are pure black and white; with halftone None the
//   layers are smooth grayscale for the riso machine to screen itself.
// Print simulation (Step 12) will be baked into Digital only.

import { zipSync } from "fflate";
import { outputWidth } from "../app/output";
import type { Target } from "../engine/gl/gpu";
import { emptyRegionTargets, type ExportState, type Pipeline } from "../pipeline/pipeline";
import type { ProjectSettings } from "../schema/sections";
import { PngEncoder } from "./png";
import { halftoneExportShader, SMOOTH_EXPORT } from "./shaders";

const TILE = 2048;
/** Largest JPG the browser's encoder is asked to make (it needs the whole image as a canvas). */
const MAX_JPG_PIXELS = 120_000_000;
const MAX_JPG_EDGE = 16384;

export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelled";
  }
}

export interface ExportProgress {
  (fraction: number, message: string): void;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
}

export interface ExportPlan {
  kind: "digital" | "riso";
  width: number;
  height: number;
  dpi: number | null;
  format: "png" | "jpg" | "zip";
  inkCount: number;
}

/** What an export with the current settings would produce (for the panel summary). */
export function planExport(settings: ProjectSettings, imageWidth: number, imageHeight: number): ExportPlan {
  const width = outputWidth(settings, imageWidth);
  const height = Math.max(1, Math.round((width * imageHeight) / imageWidth));
  if (settings.upload.mode === "print") {
    return { kind: "riso", width, height, dpi: settings.export.dpi, format: "zip", inkCount: settings.palette.inkCount };
  }
  return {
    kind: "digital",
    width,
    height,
    dpi: null,
    format: settings.export.digitalFormat === "jpg" ? "jpg" : "png",
    inkCount: settings.palette.inkCount,
  };
}

/** Safe file name part from the project name. */
export function fileBaseName(projectName: string): string {
  const cleaned = projectName.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/\s+/g, " ").trim();
  return cleaned || "Photo Inker";
}

/** ProjectName_01_0078BF.png: print order, then the ink's hex code. */
export function layerFileName(projectName: string, order: number, hex: string): string {
  return `${fileBaseName(projectName)}_${String(order).padStart(2, "0")}_${hex.replace("#", "").toUpperCase()}.png`;
}

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Renders the whole output grid tile by tile, calling onStrip with each full
 * strip of rows (RGBA, width × rows × 4, row 0 = top of the strip).
 */
async function renderTiles(
  pipeline: Pipeline,
  state: ExportState,
  plan: ExportPlan,
  mode: 0 | 1,
  onStrip: (rgba: Uint8Array, y: number, rows: number) => void | Promise<void>,
  progress: ExportProgress,
  isCancelled: () => boolean,
): Promise<void> {
  const { gpu } = state;
  const scale = plan.width / state.imageWidth; // output px per image px
  const texelScale = Math.min(state.sourceScale, scale);
  const sigmaImage = (state.smoothing * Math.max(state.imageWidth, state.imageHeight)) / 1000;
  const margin =
    (state.halftone ? state.halftone.reach / scale : 0) + (state.smoothing > 0 ? sigmaImage * 2.5 : 0) + state.splitReach + 2;
  const shader = state.halftone ? halftoneExportShader(state.halftone.method.glsl) : SMOOTH_EXPORT;

  const targets = emptyRegionTargets();
  let output: Target | null = null;
  const cols = Math.ceil(plan.width / TILE);
  const rows = Math.ceil(plan.height / TILE);
  let done = 0;
  try {
    for (let ty = 0; ty < rows; ty++) {
      const y0 = ty * TILE;
      const th = Math.min(TILE, plan.height - y0);
      const strip = new Uint8Array(plan.width * th * 4);
      for (let tx = 0; tx < cols; tx++) {
        if (isCancelled()) throw new ExportCancelled();
        const x0 = tx * TILE;
        const tw = Math.min(TILE, plan.width - x0);

        // Image-px area this tile needs, with margin, clamped to the image.
        const ix0 = Math.max(0, Math.floor(x0 / scale - margin));
        const iy0 = Math.max(0, Math.floor(y0 / scale - margin));
        const ix1 = Math.min(state.imageWidth, Math.ceil((x0 + tw) / scale + margin));
        const iy1 = Math.min(state.imageHeight, Math.ceil((y0 + th) / scale + margin));
        const region = { x: ix0, y: iy0, width: ix1 - ix0, height: iy1 - iy0 };
        const r = pipeline.renderRegion(region, texelScale, targets, { mix: mode === 0 && !state.halftone });

        output = gpu.ensureTarget(output, tw, th, "coverage");
        gpu.pass(shader, output, {
          ...state.inkUniforms,
          ...(state.halftone?.methodUniforms ?? {}),
          uCoverage: { texture: r.layered.texture },
          uImage: { texture: r.source.texture },
          ...(r.mixed ? { uMixed: { texture: r.mixed.texture } } : {}),
          uTileOrigin: [x0, y0],
          uRegion: [region.x, region.y, region.width, region.height],
          uOutScale: scale,
          uMode: mode,
          uSize: [tw, th],
        });
        const pixels = gpu.read(output);
        for (let row = 0; row < th; row++) {
          strip.set(pixels.subarray(row * tw * 4, (row + 1) * tw * 4), (row * plan.width + x0) * 4);
        }
        done++;
        progress(done / (cols * rows), `Rendering tile ${done} of ${cols * rows}…`);
        await nextFrame();
      }
      await onStrip(strip, y0, th);
    }
  } finally {
    pipeline.releaseTargets(targets);
    if (output) gpu.deleteTarget(output);
  }
}

async function waitUntilReady(pipeline: Pipeline, progress: ExportProgress, isCancelled: () => boolean): Promise<ExportState> {
  pipeline.flush();
  while (pipeline.busy) {
    if (isCancelled()) throw new ExportCancelled();
    progress(0, "Waiting for ink matching to finish…");
    await new Promise((r) => setTimeout(r, 150));
    pipeline.flush();
  }
  const state = pipeline.exportState();
  if (!state) throw new Error("Upload an image first.");
  return state;
}

export async function exportImage(
  pipeline: Pipeline,
  settings: ProjectSettings,
  progress: ExportProgress,
  isCancelled: () => boolean,
): Promise<ExportResult> {
  const state = await waitUntilReady(pipeline, progress, isCancelled);
  const plan = planExport(settings, state.imageWidth, state.imageHeight);
  const name = fileBaseName(settings.upload.projectName);

  if (plan.kind === "digital") {
    if (plan.format === "jpg") {
      if (plan.width * plan.height > MAX_JPG_PIXELS || Math.max(plan.width, plan.height) > MAX_JPG_EDGE) {
        throw new Error(`JPG export is limited to ${MAX_JPG_EDGE} px per side and 120 megapixels. Use PNG for larger images.`);
      }
      const canvas = new OffscreenCanvas(plan.width, plan.height);
      const ctx = canvas.getContext("2d")!;
      await renderTiles(pipeline, state, plan, 0, (rgba, y, rows) => {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.length), plan.width, rows), 0, y);
      }, progress, isCancelled);
      progress(1, "Encoding JPG…");
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
      return { blob, fileName: `${name}.jpg` };
    }
    const png = new PngEncoder(plan.width, plan.height, "rgb");
    await renderTiles(pipeline, state, plan, 0, (rgba, _y, rows) => {
      const rgb = new Uint8Array(plan.width * rows * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        rgb[j] = rgba[i]!;
        rgb[j + 1] = rgba[i + 1]!;
        rgb[j + 2] = rgba[i + 2]!;
      }
      png.writeRows(rgb, rows);
    }, progress, isCancelled);
    progress(1, "Finishing PNG…");
    return { blob: png.finish(), fileName: `${name}.png` };
  }

  // Riso: one grayscale PNG per ink, in print order.
  const encoders = Array.from({ length: plan.inkCount }, () => new PngEncoder(plan.width, plan.height, "gray", plan.dpi ?? undefined));
  await renderTiles(pipeline, state, plan, 1, (rgba, _y, rows) => {
    const n = plan.width * rows;
    encoders.forEach((png, ink) => {
      const gray = new Uint8Array(n);
      for (let i = 0; i < n; i++) gray[i] = rgba[i * 4 + ink]!;
      png.writeRows(gray, rows);
    });
  }, progress, isCancelled);

  progress(1, "Zipping layers…");
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < encoders.length; i++) {
    const blob = encoders[i]!.finish();
    files[layerFileName(settings.upload.projectName, i + 1, settings.palette.inkColor[i] ?? "#000000")] = new Uint8Array(await blob.arrayBuffer());
  }
  // PNGs are already compressed; store them without recompressing.
  const zip = zipSync(files, { level: 0 });
  return { blob: new Blob([zip as BlobPart], { type: "application/zip" }), fileName: `${name}_riso_layers.zip` };
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
