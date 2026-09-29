// Tone Map custom block: lightness histogram with draggable band cutoffs,
// the ink for each band, and a live strip showing the printed color at every
// tone (computed with the same spectral ink model as the preview).

import type { SettingsStore } from "../../app/store";
import { gamutCompress } from "../../engine/spectral/gamut";
import { mixCoverage } from "../../engine/spectral/inkModel";
import { inkSetupFrom, OverlapTableCache } from "../../engine/spectral/overlapTable";
import type { Pipeline } from "../../pipeline/pipeline";
import { MAX_INKS } from "../../pipeline/coverage";
import { CURVE_SIZE, curveToPoints } from "../../plugins/splitting/toneCurves";
import { toneMapBandCurves, toneMapBandInks, toneMapCurves } from "../../plugins/splitting/toneMap";
import { linearToSrgbChannel } from "../../util/color";
import { createToneCurvesBlock } from "./toneCurves";

const HIST_HEIGHT = 96;
const STRIP_HEIGHT = 20;
const HANDLE_HIT = 8; // CSS px
const MIN_GAP = 1; // % between neighboring cutoffs
const CUTOFF_KEYS = ["cutoff1", "cutoff2", "cutoff3"] as const;
const BAND_KEYS = ["band1Ink", "band2Ink", "band3Ink", "band4Ink"] as const;
const BAND_NAMES = [
  ["Shadows"],
  ["Shadows", "Highlights"],
  ["Shadows", "Midtones", "Highlights"],
  ["Shadows", "Dark mids", "Light mids", "Highlights"],
];

export function createToneMapBlock(store: SettingsStore, pipeline: Pipeline): HTMLElement {
  const element = document.createElement("div");
  element.className = "tonemap-block";

  const histLabel = document.createElement("div");
  histLabel.className = "palette-heading";
  histLabel.innerHTML = `<span class="control-label">Bands</span><span class="control-help">Drag the lines to move band edges</span>`;
  const hist = document.createElement("canvas");
  hist.className = "tonemap-hist";
  hist.setAttribute("role", "img");
  hist.setAttribute("aria-label", "Lightness histogram with band edges");
  const axis = document.createElement("div");
  axis.className = "tonemap-axis";
  axis.innerHTML = "<span>Dark</span><span>Light</span>";
  const stripLabel = document.createElement("span");
  stripLabel.className = "control-label";
  stripLabel.textContent = "Printed color at each tone";
  const strip = document.createElement("canvas");
  strip.className = "tonemap-strip";
  strip.setAttribute("role", "img");
  strip.setAttribute("aria-label", "Printed color at each tone, dark to light");
  const bands = document.createElement("div");
  bands.className = "tonemap-bands";

  // Simple (bands) / Advanced (curves). Switching to Advanced turns the current
  // bands into editable curves, so nothing changes until you edit them.
  const modeRow = document.createElement("div");
  modeRow.className = "control";
  modeRow.innerHTML = `<span class="control-label">Mode</span>`;
  const modeGroup = document.createElement("div");
  modeGroup.className = "segmented";
  const modeButtons = (
    [
      ["simple", "Simple (bands)"],
      ["advanced", "Advanced (curves)"],
    ] as const
  ).map(([mode, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.value = mode;
    b.addEventListener("click", () => setMode(mode));
    modeGroup.append(b);
    return b;
  });
  modeRow.append(modeGroup);
  const advanced = createToneCurvesBlock(store);
  const simpleParts = [histLabel, hist, axis, bands];

  element.append(modeRow, histLabel, hist, axis, stripLabel, strip, bands, advanced);

  function setMode(mode: "simple" | "advanced"): void {
    const v = values();
    if (mode === v.mode) return;
    if (mode === "advanced") {
      const hexes = inkHexes();
      const sampled = toneMapBandCurves(v, hexes);
      const curves = v.inkCurve.map((c, i) => (i < hexes.length ? curveToPoints(sampled, i) : c.map(([x, y]) => [x, y] as [number, number])));
      store.setValue("splitToneMap", "inkCurve", curves);
    }
    store.setValue("splitToneMap", "mode", mode);
  }

  let histogram: Uint32Array | null = null;
  let dragging: number | null = null;
  const tables = new OverlapTableCache();

  pipeline.onHistogram((h) => {
    histogram = h;
    draw();
  });

  const values = () => store.get().splitToneMap;
  const inkHexes = () => {
    const p = store.get().palette;
    return p.inkColor.slice(0, p.inkCount);
  };
  const cutoffsPct = () => {
    const v = values();
    return CUTOFF_KEYS.slice(0, v.bandCount - 1).map((k) => v[k]);
  };

  function bandColor(ink: number | null): string {
    const p = store.get().palette;
    return ink === null ? p.paper : (p.inkColor[ink] ?? "#000");
  }

  function sizeCanvas(c: HTMLCanvasElement, h: number): { w: number; h: number; ctx: CanvasRenderingContext2D } {
    const w = Math.max(120, element.clientWidth || 300);
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.height = `${h}px`;
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, ctx };
  }

  function drawHistogram(): void {
    const { w, h, ctx } = sizeCanvas(hist, HIST_HEIGHT);
    const v = values();
    const bandInks = toneMapBandInks(v, inkHexes());
    const edges = [0, ...cutoffsPct().map((c) => c / 100).sort((a, b) => a - b), 1];
    ctx.clearRect(0, 0, w, h);
    // Band backgrounds, tinted with each band's ink.
    for (let b = 0; b < v.bandCount; b++) {
      ctx.fillStyle = bandColor(bandInks[b] ?? null);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(edges[b]! * w, 0, (edges[b + 1]! - edges[b]!) * w, h);
    }
    ctx.globalAlpha = 1;
    if (histogram) {
      let max = 1;
      for (const n of histogram) max = Math.max(max, n);
      ctx.fillStyle = "rgba(28, 28, 28, 0.75)";
      for (let i = 0; i < 256; i++) {
        const bh = Math.sqrt(histogram[i]! / max) * (h - 4);
        ctx.fillRect((i / 256) * w, h - bh, w / 256 + 0.5, bh);
      }
    }
    // Cutoff handles.
    cutoffsPct().forEach((c, i) => {
      const x = (c / 100) * w;
      ctx.fillStyle = i === dragging ? "#f78f28" : "#1c1c1c";
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.beginPath();
      ctx.arc(x, 7, 5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawStrip(): void {
    const { w, h, ctx } = sizeCanvas(strip, STRIP_HEIGHT);
    const settings = store.get();
    const table = tables.get(inkSetupFrom(settings));
    const curves = toneMapCurves(values(), inkHexes());
    const cov = new Float32Array(MAX_INKS);
    const img = ctx.createImageData(Math.max(1, Math.round(w)), 1);
    for (let x = 0; x < img.width; x++) {
      const i = Math.round((x / Math.max(1, img.width - 1)) * (CURVE_SIZE - 1));
      for (let k = 0; k < MAX_INKS; k++) cov[k] = curves[i * MAX_INKS + k]!;
      const rgb = gamutCompress(mixCoverage(table, cov));
      img.data[x * 4] = Math.round(linearToSrgbChannel(rgb[0]!) * 255);
      img.data[x * 4 + 1] = Math.round(linearToSrgbChannel(rgb[1]!) * 255);
      img.data[x * 4 + 2] = Math.round(linearToSrgbChannel(rgb[2]!) * 255);
      img.data[x * 4 + 3] = 255;
    }
    const tmp = new OffscreenCanvas(img.width, 1);
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(tmp, 0, 0, w, h);
  }

  let bandSignature = "";
  function drawBands(): void {
    const v = values();
    const p = store.get().palette;
    const resolved = toneMapBandInks(v, inkHexes());
    const sig = `${v.bandCount}|${p.inkCount}|${p.inkColor.join()}|${BAND_KEYS.map((k) => v[k]).join()}|${resolved.join()}`;
    if (sig === bandSignature) return;
    bandSignature = sig;
    bands.innerHTML = "";
    const names = BAND_NAMES[v.bandCount - 1] ?? [];
    for (let b = 0; b < v.bandCount; b++) {
      const row = document.createElement("label");
      row.className = "tonemap-band";
      const dot = document.createElement("span");
      dot.className = "ink-dot";
      dot.style.setProperty("--swatch", bandColor(resolved[b] ?? null));
      const name = document.createElement("span");
      name.textContent = `${b + 1}. ${names[b] ?? ""}`;
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Ink for band ${b + 1}`);
      const autoInk = resolved[b];
      const options: [string, string][] = [
        ["auto", `Auto (${autoInk === null || autoInk === undefined ? "paper" : `ink ${autoInk + 1}`})`],
        ["paper", "Paper (no ink)"],
        ...Array.from({ length: p.inkCount }, (_, i) => [String(i), `Ink ${i + 1} · ${(p.inkColor[i] ?? "").toUpperCase()}`] as [string, string]),
      ];
      for (const [value, label] of options) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        select.append(o);
      }
      const current = v[BAND_KEYS[b]!];
      select.value = options.some(([val]) => val === current) ? current : "auto";
      select.addEventListener("change", () => store.setValue("splitToneMap", BAND_KEYS[b]!, select.value));
      row.append(dot, name, select);
      bands.append(row);
    }
  }

  function draw(): void {
    const isAdvanced = values().mode === "advanced";
    for (const b of modeButtons) b.classList.toggle("active", b.dataset.value === (isAdvanced ? "advanced" : "simple"));
    for (const part of simpleParts) part.hidden = isAdvanced;
    advanced.hidden = !isAdvanced;
    if (element.offsetParent === null) return; // hidden (another method chosen)
    drawStrip();
    if (isAdvanced) return;
    drawHistogram();
    drawBands();
  }

  // ---- Dragging cutoffs ----
  const pointerPct = (e: PointerEvent) => {
    const r = hist.getBoundingClientRect();
    return { pct: ((e.clientX - r.left) / r.width) * 100, px: e.clientX - r.left, w: r.width };
  };
  const hitHandle = (px: number, w: number) => {
    let best = -1;
    let bestD = HANDLE_HIT;
    cutoffsPct().forEach((c, i) => {
      const d = Math.abs((c / 100) * w - px);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  const moveCutoff = (i: number, pct: number, commit: boolean) => {
    const c = cutoffsPct();
    const lo = i > 0 ? c[i - 1]! + MIN_GAP : MIN_GAP;
    const hi = i < c.length - 1 ? c[i + 1]! - MIN_GAP : 100 - MIN_GAP;
    const v = Math.round(Math.min(hi, Math.max(lo, pct)) * 2) / 2;
    store.setValue("splitToneMap", CUTOFF_KEYS[i]!, v, { commit });
  };

  hist.addEventListener("pointerdown", (e) => {
    const p = pointerPct(e);
    const i = hitHandle(p.px, p.w);
    if (i < 0) return;
    dragging = i;
    hist.setPointerCapture(e.pointerId);
    draw();
  });
  hist.addEventListener("pointermove", (e) => {
    const p = pointerPct(e);
    if (dragging === null) {
      hist.style.cursor = hitHandle(p.px, p.w) >= 0 ? "ew-resize" : "default";
      return;
    }
    moveCutoff(dragging, p.pct, false);
  });
  const end = (e: PointerEvent) => {
    if (dragging === null) return;
    moveCutoff(dragging, pointerPct(e).pct, true);
    dragging = null;
    draw();
  };
  hist.addEventListener("pointerup", end);
  hist.addEventListener("pointercancel", end);

  store.subscribe((_, change) => {
    if (change.section === "splitToneMap" || change.section === "palette" || change.section === "*" || change.section === "split") {
      draw();
    }
  });
  new ResizeObserver(() => draw()).observe(element);
  return element;
}
