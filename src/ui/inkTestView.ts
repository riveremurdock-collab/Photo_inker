// TEMPORARY (Step 3): swatch grid of every ink combination plus coverage ramps,
// drawn with the real ink shader, with a switch to compare against a simple
// multiply blend. To be removed or moved to a debug panel in Step 14.

import type { SettingsStore } from "../app/store";
import { GLSL_INKS, INK_UNIFORMS, setInkUniforms } from "../engine/gl/inkShader";
import { createProgram, FULLSCREEN_VERTEX, getWebGL2, GLSL_LINEAR_TO_SRGB, uniformLocations } from "../engine/gl/program";
import { inkSetupFrom, OverlapTableCache } from "../engine/spectral/overlapTable";

type CompareMode = "spectral" | "multiply" | "split";

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uCoverage; // RGBA32F: ink coverage per channel
uniform sampler2D uFlags;    // RGBA8: r = use multiply, g = inside a swatch
uniform int uHeight;
out vec4 outColor;
${GLSL_INKS}
${GLSL_LINEAR_TO_SRGB}
void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), uHeight - 1 - int(gl_FragCoord.y));
  vec4 flags = texelFetch(uFlags, p, 0);
  if (flags.g < 0.5) { outColor = vec4(0.0); return; }
  vec4 cov = texelFetch(uCoverage, p, 0);
  vec3 c = flags.r > 0.5 ? multiplyInks(cov) : mixInks(cov);
  outColor = vec4(linearToSrgb(gamutCompress(c)), 1.0);
}
`;

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Solid swatch: ink bitmask. Ramp: inks that ramp 0→1 left to right. */
  kind: "solid" | "ramp";
  inks: number[];
}

const PAD = 24;
const CELL_W = 132;
const CELL_H = 84;
const CELL_GAP = 16;
const CELL_LABEL = 26;
const RAMP_LABEL = 96;
const RAMP_H = 30;
const RAMP_GAP = 10;
const SECTION_GAP = 36;

function combos(n: number): number[][] {
  const out: number[][] = [];
  for (let mask = 0; mask < 1 << n; mask++) {
    const inks = [...Array(n).keys()].filter((i) => mask & (1 << i));
    out.push(inks);
  }
  return out.sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()));
}

function rampRows(n: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) rows.push([i]);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) rows.push([i, j]);
  if (n >= 3) rows.push([...Array(n).keys()]);
  return rows;
}

export class InkTestView {
  readonly element: HTMLElement;
  private canvas: HTMLCanvasElement;
  private labels: HTMLElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null>;
  private coverageTex: WebGLTexture;
  private flagsTex: WebGLTexture;
  private tables = new OverlapTableCache();
  private mode: CompareMode = "split";
  private modeButtons: HTMLButtonElement[] = [];
  private layoutKey = "";
  private regions: Region[] = [];
  private isOpen = false;

  constructor(
    private store: SettingsStore,
    private debug: boolean,
  ) {
    this.element = document.createElement("div");
    this.element.className = "ink-test";
    this.element.hidden = true;

    const header = document.createElement("div");
    header.className = "ink-test-header";
    header.innerHTML = `<div><h2>Ink mixing test</h2><p>Temporary view for checking the ink model. Every combination of your inks, printed solid on the paper, and coverage ramps from 0 to 100%.</p></div>`;
    const controls = document.createElement("div");
    controls.className = "ink-test-controls";
    const group = document.createElement("div");
    group.className = "segmented";
    for (const [mode, label] of [
      ["spectral", "Spectral"],
      ["multiply", "Multiply"],
      ["split", "Split"],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.dataset.value = mode;
      b.addEventListener("click", () => this.setMode(mode));
      group.append(b);
      this.modeButtons.push(b);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    controls.append(group, close);
    header.append(controls);

    const legend = document.createElement("p");
    legend.className = "ink-test-legend";

    const stage = document.createElement("div");
    stage.className = "ink-test-stage";
    this.canvas = document.createElement("canvas");
    this.labels = document.createElement("div");
    this.labels.className = "ink-test-labels";
    stage.append(this.canvas, this.labels);
    this.element.append(header, legend, stage);

    this.gl = getWebGL2(this.canvas, { alpha: true, antialias: false, depth: false, stencil: false });
    this.program = createProgram(this.gl, FULLSCREEN_VERTEX, FRAGMENT);
    this.loc = uniformLocations(this.gl, this.program, ["uCoverage", "uFlags", "uHeight", ...INK_UNIFORMS]);
    this.coverageTex = this.createTexture();
    this.flagsTex = this.createTexture();

    store.subscribe((_, change) => {
      if (!this.isOpen) return;
      if (change.section === "palette" || change.section === "*") this.update();
    });
    new ResizeObserver(() => this.isOpen && this.update()).observe(this.element);
    this.setMode(this.mode);
  }

  get open(): boolean {
    return this.isOpen;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.show();
  }

  show(): void {
    this.isOpen = true;
    this.element.hidden = false;
    this.layoutKey = "";
    this.update();
  }

  close(): void {
    this.isOpen = false;
    this.element.hidden = true;
  }

  private setMode(mode: CompareMode): void {
    this.mode = mode;
    for (const b of this.modeButtons) b.classList.toggle("active", b.dataset.value === mode);
    const legend = this.element.querySelector(".ink-test-legend")!;
    legend.textContent =
      mode === "split"
        ? "Split: each swatch shows the spectral ink model on the left and a simple multiply blend on the right. Ramps show spectral on top, multiply below."
        : mode === "spectral"
          ? "Spectral ink model: inks act as transparent films, mixed band by band across the visible spectrum."
          : "Simple multiply blend (sRGB), for comparison.";
    this.layoutKey = "";
    if (this.isOpen) this.update();
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Rebuilds the layout if needed, then redraws with the current inks. */
  private update(): void {
    const settings = this.store.get();
    const n = settings.palette.inkCount;
    const width = Math.max(320, this.element.clientWidth - PAD * 2);
    const key = `${n}|${width}|${this.mode}|${window.devicePixelRatio}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.buildLayout(n, width);
    }
    this.updateLabels();
    this.render();
  }

  private buildLayout(n: number, width: number): void {
    const regions: Region[] = [];
    this.labels.innerHTML = "";
    let y = 0;

    const heading = (text: string) => {
      const h = document.createElement("p");
      h.className = "ink-test-heading";
      h.style.top = `${y}px`;
      h.textContent = text;
      this.labels.append(h);
      y += 26;
    };

    heading("Solid inks and overlaps (numbers = print order)");
    const cols = Math.max(1, Math.floor((width + CELL_GAP) / (CELL_W + CELL_GAP)));
    combos(n).forEach((inks, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * (CELL_W + CELL_GAP);
      const top = y + row * (CELL_H + CELL_LABEL + CELL_GAP);
      regions.push({ x, y: top, w: CELL_W, h: CELL_H, kind: "solid", inks });
      const label = document.createElement("p");
      label.className = "ink-test-label";
      label.dataset.inks = inks.join(",");
      label.style.left = `${x}px`;
      label.style.top = `${top + CELL_H + 4}px`;
      label.style.width = `${CELL_W}px`;
      this.labels.append(label);
    });
    y += Math.ceil((1 << n) / cols) * (CELL_H + CELL_LABEL + CELL_GAP) + SECTION_GAP - CELL_GAP;

    heading("Coverage ramps, 0% → 100% (left to right)");
    const rampW = Math.min(640, width - RAMP_LABEL);
    for (const inks of rampRows(n)) {
      regions.push({ x: RAMP_LABEL, y, w: rampW, h: RAMP_H, kind: "ramp", inks });
      const label = document.createElement("p");
      label.className = "ink-test-label ink-test-ramp-label";
      label.dataset.inks = inks.join(",");
      label.style.left = "0px";
      label.style.top = `${y + 6}px`;
      label.style.width = `${RAMP_LABEL - 8}px`;
      this.labels.append(label);
      y += RAMP_H + RAMP_GAP;
    }

    this.regions = regions;
    const cssH = y + 8;
    this.labels.style.height = `${cssH}px`;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${cssH}px`;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(width * dpr);
    const h = Math.round(cssH * dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.uploadRegions(w, h, dpr);
  }

  private uploadRegions(w: number, h: number, dpr: number): void {
    const coverage = new Float32Array(w * h * 4);
    const flags = new Uint8Array(w * h * 4);
    for (const r of this.regions) {
      const x0 = Math.round(r.x * dpr);
      const x1 = Math.round((r.x + r.w) * dpr);
      const y0 = Math.round(r.y * dpr);
      const y1 = Math.round((r.y + r.h) * dpr);
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * w + px) * 4;
          const t = r.kind === "ramp" ? (px - x0 + 0.5) / (x1 - x0) : 1;
          for (const ink of r.inks) coverage[i + ink] = t;
          const multiply =
            this.mode === "multiply" ||
            (this.mode === "split" && (r.kind === "solid" ? px >= (x0 + x1) / 2 : py >= (y0 + y1) / 2));
          flags[i] = multiply ? 255 : 0;
          flags[i + 1] = 255;
        }
      }
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.coverageTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, coverage);
    gl.bindTexture(gl.TEXTURE_2D, this.flagsTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, flags);
  }

  private updateLabels(): void {
    const { inkColor } = this.store.get().palette;
    for (const label of this.labels.querySelectorAll<HTMLElement>(".ink-test-label")) {
      const inks = label.dataset.inks ? label.dataset.inks.split(",").map(Number) : [];
      label.innerHTML = "";
      if (inks.length === 0) {
        label.textContent = "Paper";
        continue;
      }
      inks.forEach((ink, i) => {
        if (i > 0) label.append(" + ");
        const dot = document.createElement("span");
        dot.className = "ink-dot";
        dot.style.setProperty("--swatch", inkColor[ink] ?? "#000");
        label.append(dot, String(ink + 1));
      });
    }
  }

  private render(): void {
    const gl = this.gl;
    const setup = inkSetupFrom(this.store.get());
    const before = this.tables.rebuilds;
    const table = this.tables.get(setup);
    if (this.debug && this.tables.rebuilds !== before) console.debug(`[ink test] overlap table rebuilt (#${this.tables.rebuilds})`);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.coverageTex);
    gl.uniform1i(this.loc.uCoverage!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.flagsTex);
    gl.uniform1i(this.loc.uFlags!, 1);
    gl.uniform1i(this.loc.uHeight!, this.canvas.height);
    setInkUniforms(gl, this.loc as Record<(typeof INK_UNIFORMS)[number], WebGLUniformLocation | null>, table, setup);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
