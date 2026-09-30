// Full-resolution export, processed in tiles so memory stays bounded.
//
// For each tile of the output pixel grid, the pipeline's passes (copy →
// adjust → split → layer options) run for just that part of the image from
// the full-size source (with a margin for smoothing and for halftone cells
// that straddle the tile edge). An output pass then writes the tile's pixels,
// which stream into the file encoders strip by strip. Tiles that miss the
// artwork (page margins) are filled without touching the GPU. Printer's marks
// are pressed into each strip on the way out (marks.ts).
//
// - Digital: one PNG (streamed; optionally transparent) or JPG, with the
//   print simulation baked in.
// - Riso: one grayscale layer per ink at the chosen DPI, in print order, as
//   PNGs or one PDF (a page per layer), plus a composite proof and a print
//   sheet, zipped. Halftoned layers are pure black and white; with halftone
//   None they are smooth grayscale for the riso to screen itself.
// - Standard printer: one color page as PNG or PDF, without print simulation.

import { zipSync } from "fflate";
import { frameUniforms } from "../app/border";
import { outputLayout, type OutputLayout, type Rect } from "../app/layout";
import type { SimPurpose } from "../app/printSim";
import type { Target, UniformValue } from "../engine/gl/gpu";
import { emptyRegionTargets, type ExportState, type Pipeline } from "../pipeline/pipeline";
import type { ProjectSettings } from "../schema/sections";
import { DeflateStream } from "./deflate";
import { jpegWithProfile, srgbIccProfile } from "./icc";
import { applyStamps, buildStamps, layerLabels, markShapes, type Stamp } from "./marks";
import { buildPdf, type PdfImagePage } from "./pdf";
import { PngEncoder } from "./png";
import { printSheet } from "./printSheet";
import { halftoneExportShader, smoothExportShader } from "./shaders";

const TILE = 2048;
/** Largest JPG the browser's encoder is asked to make (it needs the whole image as a canvas). */
const MAX_JPG_PIXELS = 120_000_000;
const MAX_JPG_EDGE = 16384;
/** Resolution of the riso composite proof. */
const PROOF_DPI = 150;

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
  kind: "digital" | "riso" | "standard";
  layout: OutputLayout;
  width: number;
  height: number;
  dpi: number | null;
  format: "png" | "jpg" | "pdf";
  inkCount: number;
}

/** What an export with the current settings would produce (for the panel summary). */
export function planExport(settings: ProjectSettings, imageWidth: number, imageHeight: number): ExportPlan {
  const layout = outputLayout(settings, imageWidth, imageHeight);
  const e = settings.export;
  const print = settings.upload.mode === "print";
  return {
    kind: print ? (e.printTarget === "standard" ? "standard" : "riso") : "digital",
    layout,
    width: layout.width,
    height: layout.height,
    dpi: layout.dpi,
    format: print ? (e.fileFormat === "pdf" ? "pdf" : "png") : e.digitalFormat === "jpg" ? "jpg" : "png",
    inkCount: settings.palette.inkCount,
  };
}

/** Safe file name part from the project name. */
export function fileBaseName(projectName: string): string {
  const cleaned = projectName.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/\s+/g, " ").trim();
  return cleaned || "Photo Inker";
}

/** ProjectName_01_0078BF.png: print order, then the ink's hex code. */
export function layerFileName(projectName: string, order: number, hex: string, ext = "png"): string {
  return `${fileBaseName(projectName)}_${String(order).padStart(2, "0")}_${hex.replace("#", "").toUpperCase()}.${ext}`;
}

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One pass over an output grid. Pixels may be bigger than halftone output px (pixel > 1, for the proof). */
interface TilePlan {
  width: number;
  height: number;
  /** Image top-left, in this grid's pixels. */
  imageX: number;
  imageY: number;
  /** Halftone output px per image px, and per pixel of this grid. */
  scale: number;
  pixel: number;
  /** Samples per axis in color mode. */
  samples: number;
  /** The artwork in this grid's pixels (tiles outside it are just filled). */
  art: Rect;
}

function tilePlan(layout: OutputLayout, pixel = 1, samples = 2): TilePlan {
  return {
    width: Math.max(1, Math.ceil(layout.width / pixel)),
    height: Math.max(1, Math.ceil(layout.height / pixel)),
    imageX: layout.imageX / pixel,
    imageY: layout.imageY / pixel,
    scale: layout.scale,
    pixel,
    samples,
    art: { x: layout.art.x / pixel, y: layout.art.y / pixel, width: layout.art.width / pixel, height: layout.art.height / pixel },
  };
}

interface Look {
  sim: Record<string, UniformValue>;
  /** RGBA 0–1 written outside the artwork (in the output format of the mode). */
  outside: [number, number, number, number];
  transparent: boolean;
}

/**
 * Renders a whole output grid tile by tile, calling onStrip with each full
 * strip of rows (RGBA, width × rows × 4, row 0 = top of the strip).
 */
async function renderTiles(
  pipeline: Pipeline,
  state: ExportState,
  tp: TilePlan,
  mode: 0 | 1,
  look: Look,
  onStrip: (rgba: Uint8Array, y: number, rows: number) => void | Promise<void>,
  progress: (fraction: number) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const { gpu } = state;
  const toImage = tp.pixel / tp.scale; // image px per grid pixel
  const texelScale = Math.min(state.sourceScale, 1 / toImage);
  const sigmaImage = (state.smoothing * Math.max(state.imageWidth, state.imageHeight)) / 1000;
  const margin =
    (state.halftone ? state.halftone.reach / tp.scale : 0) + (state.smoothing > 0 ? sigmaImage * 2.5 : 0) + state.splitReach + state.simReach + 2;
  const simEffects = look.sim.uSimOn === 1;
  const shader = state.halftone ? halftoneExportShader(state.halftone.method.glsl, simEffects) : smoothExportShader(simEffects);
  const outsideBytes = look.outside.map((v) => Math.round(v * 255));

  const targets = emptyRegionTargets();
  let output: Target | null = null;
  const cols = Math.ceil(tp.width / TILE);
  const rows = Math.ceil(tp.height / TILE);
  let done = 0;
  try {
    for (let ty = 0; ty < rows; ty++) {
      const y0 = ty * TILE;
      const th = Math.min(TILE, tp.height - y0);
      const strip = new Uint8Array(tp.width * th * 4);
      for (let tx = 0; tx < cols; tx++) {
        if (isCancelled()) throw new ExportCancelled();
        const x0 = tx * TILE;
        const tw = Math.min(TILE, tp.width - x0);
        done++;
        const misses = x0 >= tp.art.x + tp.art.width || x0 + tw <= tp.art.x || y0 >= tp.art.y + tp.art.height || y0 + th <= tp.art.y;
        if (misses) {
          // Page margin only: no image here.
          for (let row = 0; row < th; row++) {
            for (let x = 0; x < tw; x++) strip.set(outsideBytes, (row * tp.width + x0 + x) * 4);
          }
          progress(done / (cols * rows));
          continue;
        }

        // Image-px area this tile needs, with margin, clamped to the image. (Tiles
        // wholly in a border still render a sliver of image; the border covers it.)
        const ox0 = x0 - tp.imageX;
        const oy0 = y0 - tp.imageY;
        const ix0 = Math.min(state.imageWidth - 1, Math.max(0, Math.floor(ox0 * toImage - margin)));
        const iy0 = Math.min(state.imageHeight - 1, Math.max(0, Math.floor(oy0 * toImage - margin)));
        const ix1 = Math.max(ix0 + 1, Math.min(state.imageWidth, Math.ceil((ox0 + tw) * toImage + margin)));
        const iy1 = Math.max(iy0 + 1, Math.min(state.imageHeight, Math.ceil((oy0 + th) * toImage + margin)));
        const region = { x: ix0, y: iy0, width: ix1 - ix0, height: iy1 - iy0 };
        const r = pipeline.renderRegion(region, texelScale, targets, { mix: mode === 0 && !state.halftone });

        output = gpu.ensureTarget(output, tw, th, "coverage");
        gpu.pass(shader, output, {
          ...state.inkUniforms,
          ...(state.halftone?.methodUniforms ?? {}),
          ...frameUniforms(state.border),
          ...look.sim,
          uCoverage: { texture: r.layered.texture },
          uImage: { texture: r.source.texture },
          ...(r.mixed ? { uMixed: { texture: r.mixed.texture } } : {}),
          // Measured from the image's corner, so halftones don't move with the page or border.
          uTileOrigin: [ox0, oy0],
          uPixel: tp.pixel,
          uSamples: tp.samples,
          uRegion: [region.x, region.y, region.width, region.height],
          uOutScale: tp.scale,
          uMode: mode,
          uOutside: look.outside,
          uTransparent: look.transparent ? 1 : 0,
          uSize: [tw, th],
        });
        const pixels = gpu.read(output);
        for (let row = 0; row < th; row++) {
          strip.set(pixels.subarray(row * tw * 4, (row + 1) * tw * 4), (row * tp.width + x0) * 4);
        }
        progress(done / (cols * rows));
        await nextFrame();
      }
      await onStrip(strip, y0, th);
    }
  } finally {
    pipeline.releaseTargets(targets);
    if (output) gpu.deleteTarget(output);
  }
}

/**
 * For halftone types built from the whole image (error diffusion): builds the
 * bitmap at full output resolution. Coverage is gathered in bands of rows
 * (the same passes as the preview, from the full-size image), then diffused
 * in the export worker.
 */
async function prepareExportBitmap(
  pipeline: Pipeline,
  state: ExportState,
  plan: ExportPlan,
  progress: ExportProgress,
  isCancelled: () => boolean,
): Promise<{ state: ExportState; release: () => void }> {
  const h = state.halftone;
  if (!h?.method.fromCoverage) return { state, release: () => {} };
  const imageOut = state.imageWidth * plan.layout.scale; // the image's width in output px
  const cell = h.method.fromCoverage.cell(h.values, h.ctx);
  const gw = Math.ceil(imageOut / cell);
  const gh = Math.ceil((state.imageHeight * plan.layout.scale) / cell);
  if (Math.max(gw, gh) > state.gpu.maxTextureSize) {
    throw new Error(`Error diffusion at this size needs a larger dot size (the dot grid would be ${gw} × ${gh}).`);
  }
  const ts = gw / state.imageWidth; // cells per image px
  const sigmaImage = (state.smoothing * Math.max(state.imageWidth, state.imageHeight)) / 1000;
  const margin = Math.ceil(((state.smoothing > 0 ? sigmaImage * 2.5 : 0) + state.splitReach + 2) * ts);
  const coverage = new Uint8Array(gw * gh * 4);
  const targets = emptyRegionTargets();
  const band = 512;
  try {
    for (let gy0 = 0; gy0 < gh; gy0 += band) {
      if (isCancelled()) throw new ExportCancelled();
      const rows = Math.min(band, gh - gy0);
      const top = Math.min(margin, gy0);
      const bottom = Math.min(margin, gh - gy0 - rows);
      const region = { x: 0, y: (gy0 - top) / ts, width: state.imageWidth, height: (rows + top + bottom) / ts };
      const r = pipeline.renderRegion(region, ts, targets, { mix: false });
      const pixels = state.gpu.read(r.layered);
      const w = Math.min(gw, r.layered.width);
      for (let y = 0; y < rows; y++) {
        const srcRow = y + top;
        if (srcRow >= r.layered.height) break;
        coverage.set(pixels.subarray(srcRow * r.layered.width * 4, (srcRow * r.layered.width + w) * 4), (gy0 + y) * gw * 4);
      }
      progress((gy0 + rows) / gh / 3, "Preparing dithering…");
      await nextFrame();
    }
  } finally {
    pipeline.releaseTargets(targets);
  }
  progress(0.34, "Diffusing…");
  const bits = await h.method.fromCoverage.build(h.values, coverage, gw, gh, state.inkCount, "export");
  if (isCancelled()) throw new ExportCancelled();
  const previewTextures = new Set(Object.values(h.methodUniforms).flatMap((v) => (typeof v === "object" && v && "texture" in v ? [v.texture] : [])));
  const methodUniforms = h.method.uniforms(h.values, h.ctx, h.prepared as never, { bits, width: gw, height: gh, cell: imageOut / gw });
  return {
    state: { ...state, halftone: { ...h, methodUniforms } },
    // Free the export-only bitmap texture afterwards.
    release: () => {
      for (const v of Object.values(methodUniforms)) {
        if (typeof v === "object" && v && "texture" in v && !previewTextures.has(v.texture)) state.gpu.gl.deleteTexture(v.texture);
      }
    },
  };
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
  imageName: string,
  progress: ExportProgress,
  isCancelled: () => boolean,
): Promise<ExportResult> {
  const ready = await waitUntilReady(pipeline, progress, isCancelled);
  const plan = planExport(settings, ready.imageWidth, ready.imageHeight);
  const { state, release } = await prepareExportBitmap(pipeline, ready, plan, progress, isCancelled);
  try {
    if (plan.kind === "digital") return await exportDigital(pipeline, state, plan, settings, progress, isCancelled);
    if (plan.kind === "standard") return await exportStandard(pipeline, state, plan, settings, progress, isCancelled);
    return await exportRiso(pipeline, state, plan, settings, imageName, progress, isCancelled);
  } finally {
    release();
  }
}

const rgbOf = (rgba: Uint8Array, n: number) => {
  const rgb = new Uint8Array(n * 3);
  for (let i = 0, j = 0; i < n * 4; i += 4, j += 3) {
    rgb[j] = rgba[i]!;
    rgb[j + 1] = rgba[i + 1]!;
    rgb[j + 2] = rgba[i + 2]!;
  }
  return rgb;
};

function paperSrgb(state: ExportState): [number, number, number, number] {
  const p = state.inkUniforms.uPaperSrgb as number[];
  return [p[0] ?? 1, p[1] ?? 1, p[2] ?? 1, 1];
}

async function exportDigital(
  pipeline: Pipeline,
  state: ExportState,
  plan: ExportPlan,
  settings: ProjectSettings,
  progress: ExportProgress,
  isCancelled: () => boolean,
): Promise<ExportResult> {
  const name = fileBaseName(settings.upload.projectName);
  const e = settings.export;
  const tp = tilePlan(plan.layout);
  const transparent = plan.format === "png" && e.transparent;
  const look: Look = { sim: state.sim("digital"), outside: transparent ? [0, 0, 0, 0] : paperSrgb(state), transparent };
  const report = (f: number) => progress(f, "Rendering…");

  if (plan.format === "jpg") {
    if (plan.width * plan.height > MAX_JPG_PIXELS || Math.max(plan.width, plan.height) > MAX_JPG_EDGE) {
      throw new Error(`JPG export is limited to ${MAX_JPG_EDGE} px per side and 120 megapixels. Use PNG for larger images.`);
    }
    const canvas = new OffscreenCanvas(plan.width, plan.height);
    const ctx = canvas.getContext("2d")!;
    await renderTiles(pipeline, state, tp, 0, look, (rgba, y, rows) => {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.length), plan.width, rows), 0, y);
    }, report, isCancelled);
    progress(1, "Encoding JPG…");
    const blob = await jpegWithProfile(await canvas.convertToBlob({ type: "image/jpeg", quality: e.jpgQuality / 100 }), e.embedProfile);
    return { blob, fileName: `${name}.jpg` };
  }

  const png = new PngEncoder(plan.width, plan.height, transparent ? "rgba" : "rgb", { srgb: e.embedProfile });
  await renderTiles(pipeline, state, tp, 0, look, async (rgba, _y, rows) => {
    await png.writeRows(transparent ? rgba : rgbOf(rgba, plan.width * rows), rows);
  }, report, isCancelled);
  progress(1, "Finishing PNG…");
  return { blob: await png.finish(), fileName: `${name}.png` };
}

async function exportStandard(
  pipeline: Pipeline,
  state: ExportState,
  plan: ExportPlan,
  settings: ProjectSettings,
  progress: ExportProgress,
  isCancelled: () => boolean,
): Promise<ExportResult> {
  const name = fileBaseName(settings.upload.projectName);
  const e = settings.export;
  const dpi = plan.dpi ?? 600;
  const stamps = buildStamps(plan.layout, markShapes(plan.layout, settings, null));
  // No print simulation; the page around the artwork is left unprinted (white).
  const look: Look = { sim: state.sim("standard" satisfies SimPurpose), outside: [1, 1, 1, 1], transparent: false };
  const report = (f: number) => progress(f, "Rendering page…");

  if (plan.format === "pdf") {
    const stream = new DeflateStream();
    await renderTiles(pipeline, state, tilePlan(plan.layout), 0, look, async (rgba, y, rows) => {
      applyStamps(rgba, plan.width, y, rows, stamps, "color", plan.inkCount);
      await stream.write(rgbOf(rgba, plan.width * rows));
    }, report, isCancelled);
    progress(1, "Writing PDF…");
    const page: PdfImagePage = { width: plan.width, height: plan.height, dpi, color: "rgb", data: await stream.finish() };
    return { blob: buildPdf([page], e.embedProfile ? srgbIccProfile() : undefined), fileName: `${name}_print.pdf` };
  }
  const png = new PngEncoder(plan.width, plan.height, "rgb", { dpi, srgb: e.embedProfile });
  await renderTiles(pipeline, state, tilePlan(plan.layout), 0, look, async (rgba, y, rows) => {
    applyStamps(rgba, plan.width, y, rows, stamps, "color", plan.inkCount);
    await png.writeRows(rgbOf(rgba, plan.width * rows), rows);
  }, report, isCancelled);
  progress(1, "Finishing PNG…");
  return { blob: await png.finish(), fileName: `${name}_print.png` };
}

async function exportRiso(
  pipeline: Pipeline,
  state: ExportState,
  plan: ExportPlan,
  settings: ProjectSettings,
  imageName: string,
  progress: ExportProgress,
  isCancelled: () => boolean,
): Promise<ExportResult> {
  const name = fileBaseName(settings.upload.projectName);
  const e = settings.export;
  const dpi = plan.dpi ?? 600;
  const n = plan.inkCount;
  const hexes = Array.from({ length: n }, (_, i) => (settings.palette.inkColor[i] ?? "#000000").toUpperCase());
  const stamps: Stamp[] = buildStamps(plan.layout, markShapes(plan.layout, settings, layerLabels(settings)));
  const pdf = plan.format === "pdf";
  const extras = (e.includeProof ? 1 : 0) + (e.includeSheet ? 0.2 : 0);
  const layerShare = 1 / (1 + extras * 0.25);

  // Layers: one ink per channel, 255 = paper. No print simulation (compensation only).
  const look: Look = { sim: state.sim("riso"), outside: [1, 1, 1, 1], transparent: false };
  const pngs = pdf ? [] : hexes.map(() => new PngEncoder(plan.width, plan.height, "gray", { dpi }));
  const streams = pdf ? hexes.map(() => new DeflateStream()) : [];
  await renderTiles(pipeline, state, tilePlan(plan.layout), 1, look, async (rgba, y, rows) => {
    applyStamps(rgba, plan.width, y, rows, stamps, "layers", n);
    const count = plan.width * rows;
    await Promise.all(
      hexes.map((_, ink) => {
        const gray = new Uint8Array(count);
        for (let i = 0; i < count; i++) gray[i] = rgba[i * 4 + ink]!;
        return pdf ? streams[ink]!.write(gray) : pngs[ink]!.writeRows(gray, rows);
      }),
    );
  }, (f) => progress(f * layerShare, "Rendering layers…"), isCancelled);

  const files: Record<string, Uint8Array> = {};
  const layerNames = hexes.map((hex, i) => layerFileName(settings.upload.projectName, i + 1, hex));
  if (pdf) {
    progress(layerShare, "Writing PDF…");
    const pages: PdfImagePage[] = [];
    for (const s of streams) pages.push({ width: plan.width, height: plan.height, dpi, color: "gray", data: await s.finish() });
    files[`${name}_riso_layers.pdf`] = new Uint8Array(await buildPdf(pages).arrayBuffer());
  } else {
    for (let i = 0; i < n; i++) files[layerNames[i]!] = new Uint8Array(await (await pngs[i]!.finish()).arrayBuffer());
  }

  if (e.includeProof) {
    // The whole page in color at 150 DPI, as it should print (on the chosen paper).
    const k = Math.max(1, dpi / PROOF_DPI);
    const tp = tilePlan(plan.layout, k, Math.min(8, Math.max(2, Math.ceil(k) + 1)));
    const proofLook: Look = { sim: state.sim("preview"), outside: paperSrgb(state), transparent: false };
    const common = stamps.filter((s) => s.layer === null);
    const png = new PngEncoder(tp.width, tp.height, "rgb", { dpi: dpi / k, srgb: e.embedProfile });
    await renderTiles(pipeline, state, tp, 0, proofLook, async (rgba, y, rows) => {
      applyStamps(rgba, tp.width, y, rows, common, "color", n, k);
      await png.writeRows(rgbOf(rgba, tp.width * rows), rows);
    }, (f) => progress(layerShare + f * (1 - layerShare) * 0.9, "Rendering proof…"), isCancelled);
    files[`${name}_proof.png`] = new Uint8Array(await (await png.finish()).arrayBuffer());
  }
  if (e.includeSheet) {
    progress(0.97, "Writing print sheet…");
    const sheet = await printSheet(settings, plan.layout, pdf ? hexes.map((hex, i) => `${name}_riso_layers.pdf, page ${i + 1} (${hex})`) : layerNames, imageName);
    files[`${name}_print_sheet.png`] = new Uint8Array(await sheet.arrayBuffer());
  }

  progress(1, "Zipping…");
  // PNGs and PDF streams are already compressed; store them without recompressing.
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
