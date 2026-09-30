// The processing pipeline for the preview:
//
//   upload → adjust → split → layerOptions → mix ──────────────→ display (halftone None)
//                                         └→ halftone compositor → display (AM / FM)
//                           overlapTable ┘
//
// Every stage keeps its output and a key made of its own settings and the
// versions of the stages it reads. A run walks the stages in order and reruns
// only those whose key changed, so e.g. changing an ink color reruns only the
// overlap table and the mix (plus Ink Matching's lookup table, which depends
// on the ink colors). With ?debug in the URL, each run logs what reran.
//
// The stages run on a working copy of up to 4096 px. For halftone None on a
// larger image, zooming in past that resolution re-runs the same passes for
// just the visible area at full resolution ("detail"). Halftoned views don't
// need it: the compositor evaluates dots at exact output resolution.
//
// Fade border, solid/paper border, and print simulation slot in later.

import { outputScale } from "../app/output";
import type { SourceStore } from "../app/source";
import type { SettingsStore } from "../app/store";
import { Gpu, type Target, type UniformValue } from "../engine/gl/gpu";
import { LIGHTNESS_SOURCES } from "../engine/gl/program";
import { inkSetupFrom, OverlapTableCache } from "../engine/spectral/overlapTable";
import { halftoneMethod } from "../plugins/halftone/registry";
import type { CoverageBitmap, HalftoneContext, HalftoneMethod } from "../plugins/halftone/types";
import { splitMethod } from "../plugins/splitting/registry";
import type { SplitContext, SplitMethod } from "../plugins/splitting/types";
import type { ProjectSettings } from "../schema/sections";
import type { Preview } from "../ui/preview/preview";
import type { DetailTexture } from "../ui/preview/viewRenderer";
import { hexToRgb } from "../util/color";
import { sampleCurve, type CurvePoint } from "../util/curve";
import { SupersededError } from "../workers/workerClient";
import { Compositor } from "./compositor";
import { MAX_INKS } from "./coverage";
import { ADJUST, ANALYSIS, COPY, LAYERS, LAYERS_TRAP, LIGHTNESS, MIX, SMOOTH } from "./stages/shaders";

/** Longest texture edge used for the original image on the GPU. */
const SOURCE_TEXTURE_CAP = 8192;
/**
 * Longest edge the preview is processed at. Images up to this size are
 * processed at full resolution; larger ones are downscaled once with an area
 * filter (and get a full-resolution "detail" render when zoomed in).
 */
const MAX_WORKING_EDGE = 4096;
const HISTOGRAM_SIZE = 256;
/** Longest edge (cells) of whole-image halftone bitmaps (error diffusion) in the preview. */
const PREVIEW_BITMAP_EDGE = 2048;
/** Largest detail render, in pixels (about a 4K screen). */
const MAX_DETAIL_PIXELS = 3840 * 2400;

export interface PipelineHost {
  settings: SettingsStore;
  source: SourceStore;
  preview: Preview;
  /** Preview background around the image, linear RGB. */
  background: [number, number, number];
  debug: boolean;
}

export type HistogramListener = (histogram: Uint32Array, source: string) => void;
export type BusyListener = (message: string | null) => void;

interface Prepared {
  key: string;
  methodId: string;
  value: unknown;
  /** Bumps each time a new result arrives (part of the stage key). */
  id: number;
}

/** Render targets for one run of the processing passes (whole image or a detail region). */
interface PassTargets {
  adjusted: Target | null;
  smoothA: Target | null;
  smoothB: Target | null;
  coverage: Target | null;
  layered: Target | null;
  /** Intermediates for the trapping passes. */
  layerA: Target | null;
  layerB: Target | null;
  mixed: Target | null;
}

/** Shared layer options, resolved from the settings. */
interface LayerParams {
  /** 256 × 4 bytes: tone curve per ink channel (invert, levels, curve, density). */
  tone: Uint8Array;
  toneKey: string;
  active: number[];
  knockout: number[];
  /** Total ink limit as a sum of coverages (4 = off). */
  limit: number;
  /** Choke (−) or spread (+) per ink, in output px. */
  trapOut: number[];
  /** Output px per image px. */
  outScale: number;
}

/** How far (output px) a halftone may look from a pixel for its coverage: 1.5 × the largest cell or dot. */
function halftoneReach(values: Record<string, unknown>): number {
  const sizes = [values.cellSize, values.dotSize].flatMap((v) => (Array.isArray(v) ? (v as number[]) : []));
  return Math.max(4, ...sizes) * 1.5;
}

const emptyTargets = (): PassTargets => ({
  adjusted: null,
  smoothA: null,
  smoothB: null,
  coverage: null,
  layered: null,
  layerA: null,
  layerB: null,
  mixed: null,
});

/** Everything the split/layer/mix passes need, captured by the last whole-image run (reused by detail renders). */
interface PassInputs {
  adjust: ProjectSettings["adjust"];
  method: SplitMethod;
  values: never;
  ctx: SplitContext;
  prepared: unknown;
  layers: LayerParams;
  inkUniforms: Record<string, UniformValue>;
  visible: number[];
}

export class Pipeline {
  private gpu: Gpu;
  private tables = new OverlapTableCache();
  private keys = new Map<string, string>();
  private versions = new Map<string, number>();
  private log: string[] = [];

  private sourceTexture: WebGLTexture | null = null;
  private sourceTextureWidth = 0;
  private working: Target | null = null;
  private main: PassTargets = emptyTargets();
  private adjustOutput: Target | null = null;
  private lightness: Target | null = null;
  private analysisTarget: Target | null = null;
  private analysisVersion = -1;
  private toneTexture: WebGLTexture | null = null;
  private inputs: PassInputs | null = null;
  private layerTone: { texture: WebGLTexture; key: string } | null = null;

  private prepared: Prepared | null = null;
  private preparing: string | null = null;
  private halftonePrepared: Prepared | null = null;
  private halftonePreparing: string | null = null;
  private bitmap: { key: string; methodId: string; value: CoverageBitmap; id: number } | null = null;
  private bitmapBuilding: string | null = null;
  private coverageRead: Target | null = null;
  private preparedCount = 0;

  private compositor: Compositor;
  private detailTargets: RegionTargets = emptyRegionTargets();
  private halftoneState: ExportState["halftone"] = null;
  private detail: DetailTexture | null = null;
  private halftoned = false;

  private frameRequested = false;
  private histogramListeners = new Set<HistogramListener>();
  private busyListeners = new Set<BusyListener>();
  private busyMessages = new Map<string, string>();
  private lastHistogram: { data: Uint32Array; source: string } | null = null;

  constructor(private host: PipelineHost) {
    this.gpu = new Gpu(host.preview.gl);
    this.compositor = new Compositor(this.gpu);
    host.settings.subscribe(() => this.schedule());
    host.source.subscribe(() => this.schedule());
  }

  onHistogram(listener: HistogramListener): () => void {
    this.histogramListeners.add(listener);
    if (this.lastHistogram) listener(this.lastHistogram.data, this.lastHistogram.source);
    return () => this.histogramListeners.delete(listener);
  }

  onBusy(listener: BusyListener): () => void {
    this.busyListeners.add(listener);
    return () => this.busyListeners.delete(listener);
  }

  /** Runs the pipeline on the next animation frame (several changes in one frame run once). */
  schedule(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.run();
    });
  }

  private version(id: string): number {
    return this.versions.get(id) ?? 0;
  }

  /** Runs `fn` if the stage's key changed. `fn` returns false if its input isn't ready (stops the run). */
  private stage(id: string, key: string, fn: () => boolean | void): boolean {
    if (this.keys.get(id) === key) return true;
    const t0 = performance.now();
    if (fn() === false) return false;
    this.keys.set(id, key);
    this.versions.set(id, this.version(id) + 1);
    this.log.push(`${id} ${(performance.now() - t0).toFixed(1)}ms`);
    return true;
  }

  private run(): void {
    const image = this.host.source.get();
    if (!image) return;
    const settings = this.host.settings.get();
    this.log = [];
    const t0 = performance.now();

    const ok =
      this.runUpload(image.bitmap, image.version) &&
      this.runAdjust(settings) &&
      this.runHistogram(settings) &&
      this.runSplit(settings) &&
      this.runLayers() &&
      this.runMix(settings) &&
      this.runHalftone(settings, image.width, image.height);
    if (ok) this.renderDetail();

    if (this.host.debug && this.log.length) {
      console.debug(`[pipeline] reran: ${this.log.join(", ")} (total ${(performance.now() - t0).toFixed(1)}ms)${ok ? "" : " — waiting"}`);
    }
  }

  // ---- upload: original image → GPU, plus the working copy the pipeline processes ----

  private runUpload(bitmap: ImageBitmap, imageVersion: number): boolean {
    return this.stage("upload", String(imageVersion), () => {
      const gl = this.gpu.gl;
      const cap = Math.min(SOURCE_TEXTURE_CAP, this.gpu.maxTextureSize);
      const long = Math.max(bitmap.width, bitmap.height);
      let upload: ImageBitmap = bitmap;
      if (long > cap) {
        const k = cap / long;
        const canvas = new OffscreenCanvas(Math.round(bitmap.width * k), Math.round(bitmap.height * k));
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        upload = canvas.transferToImageBitmap();
      }

      if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, upload.width, upload.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, upload);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.sourceTexture = tex;
      this.sourceTextureWidth = upload.width;
      this.host.preview.setSource("original", { kind: "texture", texture: tex, textureWidth: upload.width });

      const k = Math.min(1, Math.min(MAX_WORKING_EDGE, this.gpu.maxTextureSize) / long);
      const w = Math.max(1, Math.round(bitmap.width * k));
      const h = Math.max(1, Math.round(bitmap.height * k));
      this.working = this.gpu.ensureTarget(this.working, w, h, "image");
      this.gpu.pass(COPY, this.working, {
        uImage: { texture: tex },
        uRatio: [upload.width / w, upload.height / h],
        uRegion: [0, 0, 1, 1],
        uSize: [w, h],
      });
      if (upload !== bitmap) upload.close();
      this.clearDetail();
    });
  }

  // ---- adjust: levels, contrast curve, saturation, smoothing ----

  private runAdjust(settings: ProjectSettings): boolean {
    const a = settings.adjust;
    return this.stage("adjust", `${JSON.stringify(a)}|${this.version("upload")}`, () => {
      this.uploadTone(a.blackPoint, a.whitePoint, a.midtone, a.curve);
      const src = this.working!;
      // Smoothing radius is relative to the image's long edge, so it looks the same at any resolution.
      const sigma = (a.smoothing * Math.max(src.width, src.height)) / 1000;
      this.adjustOutput = this.adjustPasses(a, src, this.main, sigma);
    });
  }

  private adjustPasses(a: ProjectSettings["adjust"], src: Target, t: PassTargets, sigma: number): Target {
    const { width: w, height: h } = src;
    t.adjusted = this.gpu.ensureTarget(t.adjusted, w, h, "image");
    this.gpu.pass(ADJUST, t.adjusted, {
      uImage: { texture: src.texture },
      uTone: { texture: this.toneTexture! },
      uSaturation: a.saturation / 100,
      uSize: [w, h],
    });
    if (a.smoothing <= 0) {
      // Free the smoothing buffers while smoothing is off.
      if (t.smoothA) this.gpu.deleteTarget(t.smoothA);
      if (t.smoothB) this.gpu.deleteTarget(t.smoothB);
      t.smoothA = null;
      t.smoothB = null;
      return t.adjusted;
    }
    t.smoothA = this.gpu.ensureTarget(t.smoothA, w, h, "image");
    t.smoothB = this.gpu.ensureTarget(t.smoothB, w, h, "image");
    const common = { uSigma: sigma, uRange: 0.12, uSize: [w, h] };
    this.gpu.pass(SMOOTH, t.smoothA, { ...common, uImage: { texture: t.adjusted.texture }, uDir: [1, 0] });
    this.gpu.pass(SMOOTH, t.smoothB, { ...common, uImage: { texture: t.smoothA.texture }, uDir: [0, 1] });
    return t.smoothB;
  }

  /** Levels then contrast curve, as one 256-entry table over sRGB values. */
  private uploadTone(blackPoint: number, whitePoint: number, midtone: number, curve: readonly CurvePoint[]): void {
    const gl = this.gpu.gl;
    const bp = blackPoint / 100;
    const wp = Math.max(bp + 1 / 255, whitePoint / 100);
    const gamma = Math.pow(2, midtone / 50);
    const curveTable = sampleCurve(curve, 1024);
    const bytes = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      let x = Math.min(1, Math.max(0, (i / 255 - bp) / (wp - bp)));
      x = Math.pow(x, 1 / gamma);
      bytes[i * 4] = Math.round(curveTable[Math.round(x * 1023)]! * 255);
    }
    if (!this.toneTexture) {
      this.toneTexture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  }

  // ---- histogram of lightness (only while Tone Map is chosen) ----

  private runHistogram(settings: ProjectSettings): boolean {
    if (settings.split.method !== "toneMap") return true;
    const source = settings.splitToneMap.source;
    return this.stage("histogram", `${source}|${this.version("adjust")}`, () => {
      this.lightness = this.gpu.ensureTarget(this.lightness, HISTOGRAM_SIZE, HISTOGRAM_SIZE, "coverage");
      this.gpu.pass(LIGHTNESS, this.lightness, {
        uImage: { texture: this.adjustOutput!.texture },
        uSource: Math.max(0, LIGHTNESS_SOURCES.indexOf(source as (typeof LIGHTNESS_SOURCES)[number])),
        uSize: [HISTOGRAM_SIZE, HISTOGRAM_SIZE],
      });
      const pixels = this.gpu.read(this.lightness);
      const hist = new Uint32Array(256);
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]! > 0) hist[pixels[i]!]!++;
      this.lastHistogram = { data: hist, source };
      for (const l of this.histogramListeners) l(hist, source);
    });
  }

  /** Whole-image analysis of the adjusted image, computed on first request per adjusted image. */
  private analysis(): Target {
    const src = this.adjustOutput!;
    if (this.analysisVersion !== this.version("adjust") || !this.analysisTarget) {
      this.analysisTarget = this.gpu.ensureTarget(this.analysisTarget, src.width, src.height, "coverage");
      this.gpu.pass(ANALYSIS, this.analysisTarget, { uImage: { texture: src.texture }, uSize: [src.width, src.height] });
      this.analysisVersion = this.version("adjust");
    }
    return this.analysisTarget;
  }

  // ---- split: the chosen color splitting method ----

  private splitContext(settings: ProjectSettings): SplitContext {
    const setup = inkSetupFrom(settings);
    const image = this.host.source.get();
    const all = settings as unknown as Record<string, Record<string, unknown>>;
    return {
      gpu: this.gpu,
      inkCount: settings.palette.inkCount,
      inks: setup.inks,
      paper: setup.paper,
      table: this.tables.get(setup),
      settingsOf: (id) => all[id] ?? {},
      imageLongEdge: image ? Math.max(image.width, image.height) : 1,
      texelScale: image && this.working ? this.working.width / image.width : 1,
    };
  }

  private runSplit(settings: ProjectSettings): boolean {
    const method = splitMethod(settings.split.method);
    const values = (settings as unknown as Record<string, Record<string, unknown>>)[method.section.id] as never;
    const ctx = this.splitContext(settings);
    const dependency = JSON.stringify(method.dependsOn(ctx, values));
    const valuesKey = JSON.stringify(values);

    let preparedValue: unknown;
    let preparedId = 0;
    const usesPrepare = !!method.prepare && (method.needsPrepare?.(values, ctx) ?? true);
    if (usesPrepare) {
      const pkey = `${method.id}|${valuesKey}|${dependency}`;
      if (this.prepared?.key !== pkey && this.preparing !== pkey) this.startSplitPrepare(pkey, method, values, ctx);
      // Until the new result arrives, keep using the last one from this method
      // (e.g. while dragging an ink color the old coverage stays and only the colors update).
      if (!this.prepared || this.prepared.methodId !== method.id) return false;
      preparedValue = this.prepared.value;
      preparedId = this.prepared.id;
    }

    this.inputs = {
      adjust: settings.adjust,
      method,
      values,
      ctx,
      prepared: preparedValue,
      layers: this.layerParams(settings),
      inkUniforms: this.inkUniforms(settings),
      visible: this.visible(settings),
    };

    const key = [method.id, valuesKey, usesPrepare ? `prepared ${preparedId}` : dependency, ctx.inkCount, this.version("adjust")].join("|");
    return this.stage("split", key, () => {
      this.splitPass(this.inputs!, this.adjustOutput!, this.main);
    });
  }

  private splitPass(inputs: PassInputs, src: Target, t: PassTargets, texelScale?: number): Target {
    t.coverage = this.gpu.ensureTarget(t.coverage, src.width, src.height, "coverage");
    const ctx = texelScale === undefined ? inputs.ctx : { ...inputs.ctx, texelScale };
    inputs.method.render(ctx, src, t.coverage, inputs.values, inputs.prepared as never);
    return t.coverage;
  }

  /**
   * How far (image px) the split method and layer options look at neighbors
   * (e.g. Detail Split's blur, trapping), so regions and tiles get a margin.
   */
  private splitReach(): number {
    const inputs = this.inputs;
    if (!inputs) return 0;
    const split = inputs.method.reach ? inputs.method.reach(inputs.values, inputs.ctx) : 0;
    const trap = Math.max(...inputs.layers.trapOut.map(Math.abs)) / inputs.layers.outScale;
    return split + (trap > 0 ? trap + 1 : 0);
  }

  private startSplitPrepare(pkey: string, method: SplitMethod, values: never, ctx: SplitContext): void {
    this.preparing = pkey;
    this.setBusy("split", "Matching inks…");
    const accept = (value: unknown) => {
      if (this.preparing !== pkey) return false;
      this.prepared = { key: pkey, methodId: method.id, value, id: ++this.preparedCount };
      this.schedule();
      return true;
    };
    method.prepare!(values, ctx, "draft")
      .then((draft) => {
        if (!accept(draft)) return;
        return method.prepare!(values, ctx, "final").then((final) => {
          if (accept(final)) {
            this.preparing = null;
            this.setBusy("split", null);
          }
        });
      })
      .catch((err: unknown) => {
        if (err instanceof SupersededError) return;
        console.error(err);
        if (this.preparing === pkey) {
          this.preparing = null;
          this.setBusy("split", null);
        }
      });
  }

  private setBusy(id: string, message: string | null): void {
    if (message) this.busyMessages.set(id, message);
    else this.busyMessages.delete(id);
    const text = [...this.busyMessages.values()].join(" · ") || null;
    for (const l of this.busyListeners) l(text);
  }

  // ---- layer options: tone (invert, levels, curve, density), knockout, trapping, total ink limit ----

  private layerParams(settings: ProjectSettings): LayerParams {
    const n = settings.palette.inkCount;
    const l = settings.layers;
    const image = this.host.source.get();
    // Tone per ink: invert → levels → curve → density, as one 256-entry table per ink channel.
    const tone = new Uint8Array(256 * 4);
    for (let i = 0; i < n; i++) {
      const curve = sampleCurve(l.curve[i] ?? [[0, 0], [1, 1]], 1024);
      const black = (l.levelsBlack[i] ?? 0) / 100;
      const white = Math.max(black + 1 / 255, (l.levelsWhite[i] ?? 100) / 100);
      const gamma = Math.pow(2, (l.levelsMid[i] ?? 0) / 50);
      const density = (l.density[i] ?? 100) / 100;
      for (let v = 0; v < 256; v++) {
        let x = v / 255;
        if (l.invert[i]) x = 1 - x;
        x = Math.min(1, Math.max(0, (x - black) / (white - black)));
        x = Math.pow(x, 1 / gamma);
        x = curve[Math.round(x * 1023)]! * density;
        tone[v * 4 + i] = Math.round(Math.min(1, x) * 255);
      }
    }
    const vec = (f: (i: number) => number) => Array.from({ length: MAX_INKS }, (_, i) => (i < n ? f(i) : 0));
    return {
      tone,
      toneKey: JSON.stringify([n, l.invert, l.levelsBlack, l.levelsWhite, l.levelsMid, l.curve, l.density]),
      active: vec(() => 1),
      knockout: vec((i) => (l.knockout[i] ? 1 : 0)),
      limit: l.inkLimit / 100,
      trapOut: vec((i) => l.trap[i] ?? 0),
      outScale: image ? outputScale(settings, image.width) : 1,
    };
  }

  private runLayers(): boolean {
    const p = this.inputs!.layers;
    const texelScale = this.inputs!.ctx.texelScale;
    const key = [p.toneKey, p.active, p.knockout, p.limit, p.trapOut, p.outScale, texelScale, this.version("split")].join("|");
    return this.stage("layerOptions", key, () => {
      this.layersPass(p, this.main.coverage!, this.main, texelScale);
    });
  }

  private toneTextureFor(p: LayerParams): WebGLTexture {
    const gl = this.gpu.gl;
    if (!this.layerTone) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.layerTone = { texture: tex, key: "" };
    }
    if (this.layerTone.key !== p.toneKey) {
      gl.bindTexture(gl.TEXTURE_2D, this.layerTone.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, p.tone);
      this.layerTone.key = p.toneKey;
    }
    return this.layerTone.texture;
  }

  /** Layer options for one coverage texture at `texelScale` texels per image px. */
  private layersPass(p: LayerParams, src: Target, t: PassTargets, texelScale: number): Target {
    const { width: w, height: h } = src;
    const limitOn = p.limit < 3.995 ? 1 : 0;
    const common = { uLimit: p.limit, uSize: [w, h] };
    const toneUniforms = { ...common, uTone: { texture: this.toneTextureFor(p) }, uActive: p.active, uKnockout: p.knockout };
    t.layered = this.gpu.ensureTarget(t.layered, w, h, "coverage");
    // Trap sizes are in output px; convert to texels of this texture.
    const radius = p.trapOut.map((px) => (px / p.outScale) * texelScale);
    if (!radius.some((r) => Math.abs(r) > 0.01)) {
      this.gpu.pass(LAYERS, t.layered, { ...toneUniforms, uCoverage: { texture: src.texture }, uApplyLimit: limitOn });
      return t.layered;
    }
    t.layerA = this.gpu.ensureTarget(t.layerA, w, h, "coverage");
    t.layerB = this.gpu.ensureTarget(t.layerB, w, h, "coverage");
    this.gpu.pass(LAYERS, t.layerA, { ...toneUniforms, uCoverage: { texture: src.texture }, uApplyLimit: 0 });
    this.gpu.pass(LAYERS_TRAP, t.layerB, { ...common, uCoverage: { texture: t.layerA.texture }, uDir: [1, 0], uRadius: radius, uApplyLimit: 0 });
    this.gpu.pass(LAYERS_TRAP, t.layered, { ...common, uCoverage: { texture: t.layerB.texture }, uDir: [0, 1], uRadius: radius, uApplyLimit: limitOn });
    return t.layered;
  }

  // ---- mix: coverage → color with the spectral overlap table ----

  private visible(settings: ProjectSettings): number[] {
    const n = settings.palette.inkCount;
    const { solo, mute } = settings.layers;
    const anySolo = solo.slice(0, n).some(Boolean);
    return Array.from({ length: MAX_INKS }, (_, i) => (i < n && (anySolo ? solo[i] : !mute[i]) ? 1 : 0));
  }

  private inkUniforms(settings: ProjectSettings): Record<string, UniformValue> {
    const setup = inkSetupFrom(settings);
    const table = this.tables.get(setup);
    const tableData = new Float32Array(16 * 3);
    tableData.set(table.colors.subarray(0, 48));
    const srgb = (hex: string) => {
      const c = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
      return [c.r / 255, c.g / 255, c.b / 255];
    };
    const inkSrgb = new Float32Array(MAX_INKS * 3);
    setup.inks.forEach((ink, i) => inkSrgb.set(srgb(ink.hex), i * 3));
    return { uTable: tableData, uInkCount: table.inkCount, uPaperSrgb: srgb(setup.paper), uInkSrgb: inkSrgb };
  }

  private runMix(settings: ProjectSettings): boolean {
    const visible = this.visible(settings);
    const tableKey = JSON.stringify(inkSetupFrom(settings));
    return this.stage("mix", `${tableKey}|${visible}|${this.version("layerOptions")}`, () => {
      this.mixPass(this.inputs!.inkUniforms, visible, this.main.layered!, this.working!, this.main);
    });
  }

  private mixPass(inkUniforms: Record<string, UniformValue>, visible: number[], cov: Target, image: Target, t: PassTargets): Target {
    t.mixed = this.gpu.ensureTarget(t.mixed, cov.width, cov.height, "image", { mipmaps: true });
    this.gpu.pass(MIX, t.mixed, {
      ...inkUniforms,
      uCoverage: { texture: cov.texture },
      uImage: { texture: image.texture },
      uVisible: visible,
      uSize: [cov.width, cov.height],
    });
    this.gpu.generateMipmaps(t.mixed);
    return t.mixed;
  }

  // ---- halftone: None shows the mixed texture; AM/FM go through the compositor ----

  private overrideTarget: Target | null = null;

  /** Shows a split method's preview-only view instead of the inks, if it offers one right now. */
  private runPreviewOverride(): boolean {
    const inputs = this.inputs;
    const src = this.adjustOutput;
    if (!inputs?.method.previewOverride || !src) return false;
    this.overrideTarget = this.gpu.ensureTarget(this.overrideTarget, src.width, src.height, "image", { mipmaps: true });
    if (!inputs.method.previewOverride(inputs.ctx, src, this.overrideTarget, inputs.values)) return false;
    this.gpu.generateMipmaps(this.overrideTarget);
    this.halftoned = false;
    this.keys.delete("halftone"); // so the inks come back when the override ends
    this.clearDetail();
    this.host.preview.setSource("inks", { kind: "texture", texture: this.overrideTarget.texture, textureWidth: src.width });
    return true;
  }

  private runHalftone(settings: ProjectSettings, imageWidth: number, imageHeight: number): boolean {
    if (this.runPreviewOverride()) return true;
    const method = halftoneMethod(settings.halftone.type);
    const scale = outputScale(settings, imageWidth);
    if (!method) {
      return this.stage("halftone", `none|${this.version("mix")}`, () => {
        this.halftoned = false;
        this.halftoneState = null;
        this.showMixed();
      });
    }

    const values = (settings as unknown as Record<string, Record<string, unknown>>)[method.section.id] as never;
    const outW = Math.round(imageWidth * scale);
    const info = { outputWidth: outW, outputHeight: Math.max(1, Math.round((outW * imageHeight) / imageWidth)) };
    const showSmoothMeanwhile = () => {
      this.halftoned = false;
      this.keys.delete("halftone");
      this.showMixed();
      return true;
    };

    let prepared: unknown;
    let preparedId = 0;
    if (method.prepare && method.prepareKey) {
      const pkey = `${method.id}|${method.prepareKey(values, info)}`;
      if (this.halftonePrepared?.key !== pkey && this.halftonePreparing !== pkey) this.startHalftonePrepare(pkey, method, values, info);
      // Nothing to show yet for this method: show smooth inks meanwhile.
      if (!this.halftonePrepared || this.halftonePrepared.methodId !== method.id) return showSmoothMeanwhile();
      prepared = this.halftonePrepared.value;
      preparedId = this.halftonePrepared.id;
    }

    const n = settings.palette.inkCount;
    const ctx: HalftoneContext = {
      gpu: this.gpu,
      inkCount: n,
      minDot: settings.halftone.minDot.slice(0, MAX_INKS),
      minDotMode: settings.halftone.minDotMode as "drop" | "round",
      outputWidth: info.outputWidth,
      outputHeight: info.outputHeight,
      analysis: () => this.analysis(),
    };

    // Types built from the whole image's coverage (error diffusion).
    let bitmapId = 0;
    if (method.fromCoverage) {
      const cell = method.fromCoverage.cell(values, ctx);
      let gw = Math.ceil(info.outputWidth / cell);
      let gh = Math.ceil(info.outputHeight / cell);
      // The preview caps the grid; the dots are then drawn a bit larger than in the export.
      const k = Math.min(1, PREVIEW_BITMAP_EDGE / Math.max(gw, gh));
      gw = Math.max(1, Math.round(gw * k));
      gh = Math.max(1, Math.round(gh * k));
      const bkey = [method.id, JSON.stringify(values), gw, gh, n, this.version("layerOptions")].join("|");
      if (this.bitmap?.key !== bkey && this.bitmapBuilding !== bkey) this.startBitmap(bkey, method, values, gw, gh, info.outputWidth / gw, n);
      if (!this.bitmap || this.bitmap.methodId !== method.id) return showSmoothMeanwhile();
      bitmapId = this.bitmap.id;
    }

    const key = [method.id, JSON.stringify(values), JSON.stringify(settings.halftone), scale, preparedId, bitmapId, this.version("mix")].join("|");
    return this.stage("halftone", key, () => {
      this.halftoned = true;
      this.clearDetail();
      const methodUniforms = method.uniforms(values, ctx, prepared as never, this.bitmap?.value);
      this.halftoneState = { method, methodUniforms, reach: halftoneReach(values), values, ctx, prepared };
      this.compositor.set({
        method,
        methodUniforms,
        inkUniforms: this.inputs!.inkUniforms,
        coverage: this.main.layered!,
        image: this.working!,
        imageWidth,
        imageHeight,
        outputScale: scale,
        visible: this.inputs!.visible,
        background: this.host.background,
      });
      this.host.preview.setSource("inks", this.compositor);
    });
  }

  /** Builds an error-diffusion style bitmap from the current coverage, at gw × gh cells. */
  private startBitmap(key: string, method: HalftoneMethod, values: never, gw: number, gh: number, cell: number, inkCount: number): void {
    this.bitmapBuilding = key;
    this.setBusy("bitmap", "Diffusing…");
    const coverage = this.readCoverage(this.main.layered!, gw, gh);
    method
      .fromCoverage!.build(values, coverage, gw, gh, inkCount, "preview")
      .then((bits) => {
        if (this.bitmapBuilding !== key) return;
        this.bitmap = { key, methodId: method.id, value: { bits, width: gw, height: gh, cell }, id: ++this.preparedCount };
        this.bitmapBuilding = null;
        this.setBusy("bitmap", null);
        this.schedule();
      })
      .catch((err: unknown) => {
        if (!(err instanceof SupersededError)) console.error(err);
        if (this.bitmapBuilding === key) {
          this.bitmapBuilding = null;
          this.setBusy("bitmap", null);
        }
      });
  }

  /** Resamples a coverage texture to w × h (area filter) and reads it back (RGBA bytes, row 0 = top). */
  readCoverage(src: Target, w: number, h: number): Uint8Array {
    this.coverageRead = this.gpu.ensureTarget(this.coverageRead, w, h, "coverage");
    this.gpu.pass(COPY, this.coverageRead, {
      uImage: { texture: src.texture },
      uRatio: [src.width / w, src.height / h],
      uRegion: [0, 0, 1, 1],
      uSize: [w, h],
    });
    return this.gpu.read(this.coverageRead);
  }

  private startHalftonePrepare(pkey: string, method: HalftoneMethod, values: never, info: { outputWidth: number; outputHeight: number }): void {
    this.halftonePreparing = pkey;
    this.setBusy("halftone", method.id === "spiral" ? "Building spiral…" : "Building halftone map…");
    method.prepare!(values, info)
      .then((value) => {
        if (this.halftonePreparing !== pkey) return;
        this.halftonePrepared = { key: pkey, methodId: method.id, value, id: ++this.preparedCount };
        this.halftonePreparing = null;
        this.setBusy("halftone", null);
        this.schedule();
      })
      .catch((err: unknown) => {
        if (!(err instanceof SupersededError)) console.error(err);
        if (this.halftonePreparing === pkey) {
          this.halftonePreparing = null;
          this.setBusy("halftone", null);
        }
      });
  }

  private showMixed(): void {
    const mixed = this.main.mixed;
    if (!mixed) return;
    this.host.preview.setSource("inks", { kind: "texture", texture: mixed.texture, textureWidth: mixed.width, detail: this.detail });
  }

  // ---- detail: full-resolution render of the visible area (halftone None, large images) ----

  private clearDetail(): void {
    if (!this.detail) return;
    this.detail = null;
    this.releaseTargets(this.detailTargets);
    if (!this.halftoned) this.showMixed();
  }

  /**
   * Re-renders the visible area at full resolution when the working copy is
   * too coarse for the current zoom. Called after each run and when the view
   * settles after zooming or panning.
   */
  renderDetail(): void {
    const image = this.host.source.get();
    const inputs = this.inputs;
    if (!image || !inputs || !this.working || !this.sourceTexture || this.halftoned) return;

    const view = this.host.preview.currentView;
    const canvas = this.host.preview.canvasSize;
    const W = image.width;
    const H = image.height;
    const workingScale = this.working.width / W;
    const sourceScale = this.sourceTextureWidth / W;
    // Only when zoomed in beyond the working copy, and more resolution exists.
    if (view.scale <= workingScale * 1.05 || sourceScale <= workingScale * 1.01) {
      this.clearDetail();
      return;
    }

    const t0 = performance.now();
    const a = inputs.adjust;
    const sigmaImage = (a.smoothing * Math.max(W, H)) / 1000;
    const margin = (a.smoothing > 0 ? Math.ceil(sigmaImage * 2.5) : 0) + Math.ceil(this.splitReach()) + 2;
    const x0 = Math.max(0, Math.floor(-view.originX / view.scale - margin));
    const y0 = Math.max(0, Math.floor(-view.originY / view.scale - margin));
    const x1 = Math.min(W, Math.ceil((canvas.width - view.originX) / view.scale + margin));
    const y1 = Math.min(H, Math.ceil((canvas.height - view.originY) / view.scale + margin));
    if (x1 <= x0 || y1 <= y0) {
      this.clearDetail();
      return;
    }
    const rw = x1 - x0;
    const rh = y1 - y0;
    let texelScale = Math.min(view.scale, sourceScale);
    if (rw * rh * texelScale * texelScale > MAX_DETAIL_PIXELS) texelScale = Math.sqrt(MAX_DETAIL_PIXELS / (rw * rh));

    const out = this.renderRegion({ x: x0, y: y0, width: rw, height: rh }, texelScale, this.detailTargets, {
      mix: true,
      visible: inputs.visible,
    });
    this.detail = { texture: out.mixed!.texture, x: x0, y: y0, width: rw, height: rh };
    this.showMixed();
    if (this.host.debug) {
      console.debug(`[pipeline] detail ${out.layered.width}×${out.layered.height} ${(performance.now() - t0).toFixed(1)}ms`);
    }
  }

  // ---- regions: the same passes for part of the image at any resolution (detail view, export tiles) ----

  /**
   * Runs copy → adjust → split → layer options (→ mix) for one region of the
   * image (image px), from the full-size source, at `texelScale` texels per
   * image px. Uses the settings of the last whole-image run.
   */
  renderRegion(
    region: { x: number; y: number; width: number; height: number },
    texelScale: number,
    t: RegionTargets,
    options: { mix: boolean; visible?: number[] },
  ): { source: Target; layered: Target; mixed: Target | null } {
    const image = this.host.source.get()!;
    const inputs = this.inputs!;
    const W = image.width;
    const H = image.height;
    const w = Math.max(1, Math.round(region.width * texelScale));
    const h = Math.max(1, Math.round(region.height * texelScale));
    t.source = this.gpu.ensureTarget(t.source, w, h, "image");
    this.gpu.pass(COPY, t.source, {
      uImage: { texture: this.sourceTexture! },
      uRatio: [(this.sourceTextureWidth * (region.width / W)) / w, (this.sourceTextureWidth * (H / W) * (region.height / H)) / h],
      uRegion: [region.x / W, region.y / H, region.width / W, region.height / H],
      uSize: [w, h],
    });
    const a = inputs.adjust;
    const sigmaImage = (a.smoothing * Math.max(W, H)) / 1000;
    const adjusted = this.adjustPasses(a, t.source, t, sigmaImage * (w / region.width));
    const coverage = this.splitPass(inputs, adjusted, t, texelScale);
    const layered = this.layersPass(inputs.layers, coverage, t, texelScale);
    const visible = options.visible ?? [1, 1, 1, 1];
    const mixed = options.mix ? this.mixPass(inputs.inkUniforms, visible, layered, t.source, t) : null;
    return { source: t.source, layered, mixed };
  }

  /** Frees a set of region targets. */
  releaseTargets(t: RegionTargets): void {
    for (const key of Object.keys(t) as (keyof RegionTargets)[]) {
      const target = t[key];
      if (target) this.gpu.deleteTarget(target);
      t[key] = null;
    }
  }

  /** True while ink matching or a halftone map is still being prepared. */
  get busy(): boolean {
    return this.busyMessages.size > 0 || this.preparing !== null || this.halftonePreparing !== null || this.bitmapBuilding !== null;
  }

  /** What an export needs from the current state, or null if nothing is loaded yet. */
  exportState(): ExportState | null {
    const image = this.host.source.get();
    if (!image || !this.inputs || !this.sourceTexture) return null;
    return {
      gpu: this.gpu,
      imageWidth: image.width,
      imageHeight: image.height,
      sourceScale: this.sourceTextureWidth / image.width,
      inkCount: this.inputs.ctx.inkCount,
      inkUniforms: this.inputs.inkUniforms,
      smoothing: this.inputs.adjust.smoothing,
      splitReach: this.splitReach(),
      halftone: this.halftoneState,
    };
  }

  /** Runs any pending pipeline work now (instead of on the next frame). */
  flush(): void {
    this.run();
  }
}

/** Region render targets: the pass targets plus the copied source region. */
export type RegionTargets = PassTargets & { source: Target | null };

export function emptyRegionTargets(): RegionTargets {
  return { ...emptyTargets(), source: null };
}

export interface ExportState {
  gpu: Gpu;
  imageWidth: number;
  imageHeight: number;
  /** Full-size source texels per image px (below 1 only for images over 8192 px). */
  sourceScale: number;
  inkCount: number;
  inkUniforms: Record<string, UniformValue>;
  smoothing: number;
  /** Extra margin (image px) the split method needs around a region. */
  splitReach: number;
  /** Null for halftone None. reach = how far (output px) the halftone looks for coverage. */
  halftone: {
    method: HalftoneMethod;
    methodUniforms: Record<string, UniformValue>;
    reach: number;
    values: never;
    ctx: HalftoneContext;
    prepared: unknown;
  } | null;
}
