// The processing pipeline for the preview:
//
//   upload → adjust → split → layerOptions → mix → display
//                                    overlapTable ┘
//
// Every stage keeps its output and a key made of its own settings and the
// versions of the stages it reads. A run walks the stages in order and reruns
// only those whose key changed, so e.g. changing an ink color reruns only the
// overlap table and the mix (plus Ink Matching's lookup table, which depends
// on the ink colors). With ?debug in the URL, each run logs what reran.
//
// Fade border, halftone, solid/paper border, and print simulation slot in
// between these stages in later steps.

import type { SourceStore } from "../app/source";
import type { SettingsStore } from "../app/store";
import { Gpu, type Target } from "../engine/gl/gpu";
import { INK_UNIFORMS } from "../engine/gl/inkShader";
import { inkSetupFrom, OverlapTableCache } from "../engine/spectral/overlapTable";
import { LIGHTNESS_SOURCES } from "../engine/gl/program";
import { splitMethod } from "../plugins/splitting/registry";
import type { SplitContext } from "../plugins/splitting/types";
import type { ProjectSettings } from "../schema/sections";
import type { Preview } from "../ui/preview/preview";
import { hexToRgb } from "../util/color";
import { sampleCurve, type CurvePoint } from "../util/curve";
import { SupersededError } from "../workers/workerClient";
import { MAX_INKS } from "./coverage";
import { ADJUST, COPY, LAYERS, LIGHTNESS, MIX, SMOOTH } from "./stages/shaders";

/** Longest texture edge used for the original image on the GPU. */
const SOURCE_TEXTURE_CAP = 8192;
/**
 * Longest edge the preview is processed at. Images up to this size are
 * processed at full resolution; larger ones are downscaled once with an area
 * filter. Displayed through mipmaps, the inked view is as sharp as the
 * original at any zoom up to this resolution.
 */
const MAX_WORKING_EDGE = 4096;
const HISTOGRAM_SIZE = 256;

export interface PipelineHost {
  settings: SettingsStore;
  source: SourceStore;
  preview: Preview;
  debug: boolean;
}

export type HistogramListener = (histogram: Uint32Array, source: string) => void;
export type BusyListener = (message: string | null) => void;

interface Prepared {
  key: string;
  methodId: string;
  value: unknown;
  /** Bumps each time a new result arrives (part of the split key). */
  id: number;
}

export class Pipeline {
  private gpu: Gpu;
  private tables = new OverlapTableCache();
  private keys = new Map<string, string>();
  private versions = new Map<string, number>();
  private log: string[] = [];

  private sourceTexture: WebGLTexture | null = null;
  private working: Target | null = null;
  private adjusted: Target | null = null;
  private smoothA: Target | null = null;
  private smoothB: Target | null = null;
  private adjustOutput: Target | null = null;
  private lightness: Target | null = null;
  private coverage: Target | null = null;
  private layered: Target | null = null;
  private mixed: Target | null = null;
  private toneTexture: WebGLTexture | null = null;

  private prepared: Prepared | null = null;
  private preparing: string | null = null;
  private preparedCount = 0;

  private frameRequested = false;
  private histogramListeners = new Set<HistogramListener>();
  private busyListeners = new Set<BusyListener>();
  private lastHistogram: { data: Uint32Array; source: string } | null = null;

  constructor(private host: PipelineHost) {
    this.gpu = new Gpu(host.preview.gl);
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
      this.runLayers(settings) &&
      this.runMix(settings);

    if (this.host.debug && this.log.length) {
      console.debug(`[pipeline] reran: ${this.log.join(", ")} (total ${(performance.now() - t0).toFixed(1)}ms)${ok ? "" : " — waiting"}`);
    }
  }

  // ---- upload: original image → GPU, plus the working copy the pipeline processes ----

  private workingEdge(): number {
    return Math.min(MAX_WORKING_EDGE, this.gpu.maxTextureSize);
  }

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
      this.host.preview.setSource("original", { texture: tex, textureWidth: upload.width });
      if (upload !== bitmap) upload.close();

      const k = Math.min(1, this.workingEdge() / long);
      const w = Math.max(1, Math.round(bitmap.width * k));
      const h = Math.max(1, Math.round(bitmap.height * k));
      this.working = this.gpu.ensureTarget(this.working, w, h, "image");
      this.gpu.pass(COPY, this.working, {
        uImage: { texture: tex },
        uRatio: [upload.width / w, upload.height / h],
        uSize: [w, h],
      });
    });
  }

  // ---- adjust: levels, contrast curve, saturation, smoothing ----

  private runAdjust(settings: ProjectSettings): boolean {
    const a = settings.adjust;
    return this.stage("adjust", `${JSON.stringify(a)}|${this.version("upload")}`, () => {
      const src = this.working!;
      const { width: w, height: h } = src;
      this.uploadTone(a.blackPoint, a.whitePoint, a.midtone, a.curve);
      this.adjusted = this.gpu.ensureTarget(this.adjusted, w, h, "image");
      this.gpu.pass(ADJUST, this.adjusted, {
        uImage: { texture: src.texture },
        uTone: { texture: this.toneTexture! },
        uSaturation: a.saturation / 100,
        uSize: [w, h],
      });
      this.adjustOutput = this.adjusted;
      if (a.smoothing > 0) {
        const sigma = (a.smoothing * Math.max(w, h)) / 1000;
        this.smoothA = this.gpu.ensureTarget(this.smoothA, w, h, "image");
        this.smoothB = this.gpu.ensureTarget(this.smoothB, w, h, "image");
        const common = { uSigma: sigma, uRange: 0.12, uSize: [w, h] };
        this.gpu.pass(SMOOTH, this.smoothA, { ...common, uImage: { texture: this.adjusted.texture }, uDir: [1, 0] });
        this.gpu.pass(SMOOTH, this.smoothB, { ...common, uImage: { texture: this.smoothA.texture }, uDir: [0, 1] });
        this.adjustOutput = this.smoothB;
      } else {
        // Free the smoothing buffers while smoothing is off.
        if (this.smoothA) this.gpu.deleteTarget(this.smoothA);
        if (this.smoothB) this.gpu.deleteTarget(this.smoothB);
        this.smoothA = null;
        this.smoothB = null;
      }
    });
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
      const y = curveTable[Math.round(x * 1023)]!;
      bytes[i * 4] = Math.round(y * 255);
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

  // ---- split: the chosen color splitting method ----

  private splitContext(settings: ProjectSettings): SplitContext {
    const setup = inkSetupFrom(settings);
    return {
      gpu: this.gpu,
      inkCount: settings.palette.inkCount,
      inks: setup.inks,
      paper: setup.paper,
      table: this.tables.get(setup),
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
    if (method.prepare) {
      const pkey = `${method.id}|${valuesKey}|${dependency}`;
      if (this.prepared?.key !== pkey && this.preparing !== pkey) this.startPrepare(pkey, method, values, ctx);
      // Until the new result arrives, keep using the last one from this method
      // (e.g. while dragging an ink color the old coverage stays and only the colors update).
      if (!this.prepared || this.prepared.methodId !== method.id) return false;
      preparedValue = this.prepared.value;
      preparedId = this.prepared.id;
    }

    const key = [method.id, valuesKey, method.prepare ? `prepared ${preparedId}` : dependency, ctx.inkCount, this.version("adjust")].join("|");
    return this.stage("split", key, () => {
      const src = this.adjustOutput!;
      this.coverage = this.gpu.ensureTarget(this.coverage, src.width, src.height, "coverage");
      method.render(ctx, src, this.coverage, values, preparedValue as never);
    });
  }

  private startPrepare(pkey: string, method: ReturnType<typeof splitMethod>, values: never, ctx: SplitContext): void {
    this.preparing = pkey;
    this.setBusy("Matching inks…");
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
            this.setBusy(null);
          }
        });
      })
      .catch((err: unknown) => {
        if (err instanceof SupersededError) return;
        console.error(err);
        if (this.preparing === pkey) {
          this.preparing = null;
          this.setBusy(null);
        }
      });
  }

  private setBusy(message: string | null): void {
    for (const l of this.busyListeners) l(message);
  }

  // ---- layer options: invert, density ----

  private runLayers(settings: ProjectSettings): boolean {
    const n = settings.palette.inkCount;
    const { density, invert } = settings.layers;
    const vec = (f: (i: number) => number) => Array.from({ length: MAX_INKS }, (_, i) => (i < n ? f(i) : 0));
    const uDensity = vec((i) => (density[i] ?? 100) / 100);
    const uInvert = vec((i) => (invert[i] ? 1 : 0));
    const uActive = vec(() => 1);
    return this.stage("layerOptions", `${uDensity}|${uInvert}|${n}|${this.version("split")}`, () => {
      const src = this.coverage!;
      this.layered = this.gpu.ensureTarget(this.layered, src.width, src.height, "coverage");
      this.gpu.pass(LAYERS, this.layered, {
        uCoverage: { texture: src.texture },
        uDensity,
        uInvert,
        uActive,
        uSize: [src.width, src.height],
      });
    });
  }

  // ---- mix: coverage → color with the spectral overlap table ----

  private runMix(settings: ProjectSettings): boolean {
    const n = settings.palette.inkCount;
    const { solo, mute } = settings.layers;
    const anySolo = solo.slice(0, n).some(Boolean);
    const uVisible = Array.from({ length: MAX_INKS }, (_, i) => (i < n && (anySolo ? solo[i] : !mute[i]) ? 1 : 0));
    const setup = inkSetupFrom(settings);
    const table = this.tables.get(setup);
    const tableKey = JSON.stringify(setup);
    return this.stage("mix", `${tableKey}|${uVisible}|${this.version("layerOptions")}`, () => {
      const src = this.layered!;
      this.mixed = this.gpu.ensureTarget(this.mixed, src.width, src.height, "image", { mipmaps: true });
      const tableData = new Float32Array(16 * 3);
      tableData.set(table.colors.subarray(0, 48));
      const srgb = (hex: string) => {
        const c = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
        return [c.r / 255, c.g / 255, c.b / 255];
      };
      const inkSrgb = new Float32Array(MAX_INKS * 3);
      setup.inks.forEach((ink, i) => inkSrgb.set(srgb(ink.hex), i * 3));
      const uniforms: Record<(typeof INK_UNIFORMS)[number], Float32Array | number | number[]> = {
        uTable: tableData,
        uInkCount: table.inkCount,
        uPaperSrgb: srgb(setup.paper),
        uInkSrgb: inkSrgb,
      };
      this.gpu.pass(MIX, this.mixed, {
        ...uniforms,
        uCoverage: { texture: src.texture },
        uImage: { texture: this.working!.texture },
        uVisible,
        uSize: [src.width, src.height],
      });
      this.gpu.generateMipmaps(this.mixed);
      this.host.preview.setSource("inks", { texture: this.mixed.texture, textureWidth: this.mixed.width });
    });
  }
}
