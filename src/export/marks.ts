// Printer's marks for Print mode pages: crop marks, registration targets and
// layer labels. They are drawn as small "stamps" (an alpha mask at a page
// position) once per export, then pressed into each strip of rows as it
// streams out, so no page-sized canvas is ever needed. Every layer gets the
// same marks at the same pixels, so they line up when the layers are
// printed; labels differ per layer.
//
// The same geometry drives the preview's page overlay (markShapes).

import type { OutputLayout, Rect } from "../app/layout";
import type { ProjectSettings } from "../schema/sections";

export interface Stamp {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0–255 per pixel, row-major. */
  alpha: Uint8Array;
  /** Ink layer it belongs to, or null for every layer. */
  layer: number | null;
}

export type MarkShape =
  | { kind: "line"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "target"; cx: number; cy: number; r: number }
  | { kind: "label"; x: number; y: number; size: number; text: string; layer: number | null };

const mm = (layout: OutputLayout, v: number) => (v / 25.4) * (layout.dpi ?? 300);

/** Each layer's label: project, print order and ink. */
export function layerLabels(settings: ProjectSettings): string[] {
  const n = settings.palette.inkCount;
  return Array.from({ length: n }, (_, i) => `${settings.upload.projectName || "Photo Inker"} · layer ${i + 1} of ${n} · ${(settings.palette.inkColor[i] ?? "#000000").toUpperCase()}`);
}

/** Where the marks go (output px). Only marks that fit on the page are returned. */
export function markShapes(layout: OutputLayout, settings: ProjectSettings, labels: string[] | null): MarkShape[] {
  const e = settings.export;
  if (layout.kind !== "print" || e.pageSize === "image") return [];
  const out: MarkShape[] = [];
  const cut: Rect = layout.cut;
  const onPage = (x: number, y: number) => x >= 0 && y >= 0 && x <= layout.width && y <= layout.height;
  // Marks start a little outside the cut, and outside any bleed.
  const bleed = mm(layout, e.bleed);
  const gap = Math.max(mm(layout, 1.5), e.placement === "fill" ? bleed + mm(layout, 1) : 0);
  const len = mm(layout, 5);

  if (e.cropMarks) {
    const corners: [number, number, number, number][] = [
      [cut.x, cut.y, -1, -1],
      [cut.x + cut.width, cut.y, 1, -1],
      [cut.x, cut.y + cut.height, -1, 1],
      [cut.x + cut.width, cut.y + cut.height, 1, 1],
    ];
    for (const [x, y, dx, dy] of corners) {
      const hx0 = x + dx * gap;
      const hx1 = x + dx * (gap + len);
      if (onPage(Math.min(hx0, hx1), y) && onPage(Math.max(hx0, hx1), y)) out.push({ kind: "line", x0: hx0, y0: y, x1: hx1, y1: y });
      const vy0 = y + dy * gap;
      const vy1 = y + dy * (gap + len);
      if (onPage(x, Math.min(vy0, vy1)) && onPage(x, Math.max(vy0, vy1))) out.push({ kind: "line", x0: x, y0: vy0, x1: x, y1: vy1 });
    }
  }

  if (e.regMarks && e.printTarget === "riso") {
    const r = mm(layout, 2.5);
    const reach = r * 1.5;
    const cx = cut.x + cut.width / 2;
    const cy = cut.y + cut.height / 2;
    const d = gap + reach;
    for (const [x, y] of [
      [cx, cut.y - d],
      [cx, cut.y + cut.height + d],
      [cut.x - d, cy],
      [cut.x + cut.width + d, cy],
    ] as const) {
      if (onPage(x - reach, y - reach) && onPage(x + reach, y + reach)) out.push({ kind: "target", cx: x, cy: y, r });
    }
  }

  if (labels && e.layerLabels && e.printTarget === "riso") {
    const size = mm(layout, 2.5);
    // Bottom margin, below any bottom registration mark; otherwise the top margin.
    const below = cut.y + cut.height + gap + (e.regMarks ? mm(layout, 2.5) * 3 + mm(layout, 1) : 0) + size;
    const above = cut.y - gap - (e.regMarks ? mm(layout, 2.5) * 3 + mm(layout, 1) : 0);
    const y = below + size * 0.3 <= layout.height ? below : above - size >= 0 ? above : null;
    if (y !== null) {
      labels.forEach((text, layer) => out.push({ kind: "label", x: Math.max(cut.x, gap), y, size, text, layer }));
    }
  }
  return out;
}

/** Draws the marks into stamps (alpha masks). Line width 0.2 mm, at least 1 px. */
export function buildStamps(layout: OutputLayout, shapes: MarkShape[]): Stamp[] {
  const stroke = Math.max(1, Math.round(mm(layout, 0.2)));
  const stamps: Stamp[] = [];
  for (const s of shapes) {
    if (s.kind === "line") {
      // Axis-aligned: a filled rectangle.
      const x = Math.round(Math.min(s.x0, s.x1) - (s.x0 === s.x1 ? stroke / 2 : 0));
      const y = Math.round(Math.min(s.y0, s.y1) - (s.y0 === s.y1 ? stroke / 2 : 0));
      const width = Math.max(stroke, Math.round(Math.abs(s.x1 - s.x0)));
      const height = Math.max(stroke, Math.round(Math.abs(s.y1 - s.y0)));
      stamps.push({ x, y, width, height, alpha: new Uint8Array(width * height).fill(255), layer: null });
      continue;
    }
    if (s.kind === "target") {
      const reach = s.r * 1.5;
      const size = Math.ceil(reach * 2) + stroke * 2;
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d")!;
      const c = size / 2;
      ctx.strokeStyle = "#000";
      ctx.lineWidth = stroke;
      ctx.beginPath();
      ctx.arc(c, c, s.r, 0, Math.PI * 2);
      ctx.moveTo(c - reach, c);
      ctx.lineTo(c + reach, c);
      ctx.moveTo(c, c - reach);
      ctx.lineTo(c, c + reach);
      ctx.stroke();
      stamps.push({ x: Math.round(s.cx - c), y: Math.round(s.cy - c), width: size, height: size, alpha: alphaOf(ctx, size, size), layer: null });
      continue;
    }
    const font = `${Math.round(s.size)}px system-ui, sans-serif`;
    const probe = new OffscreenCanvas(1, 1).getContext("2d")!;
    probe.font = font;
    const width = Math.max(1, Math.ceil(probe.measureText(s.text).width) + 2);
    const height = Math.ceil(s.size * 1.4);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    ctx.font = font;
    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(s.text, 1, Math.round(s.size * 1.05));
    stamps.push({ x: Math.round(s.x), y: Math.round(s.y - s.size * 1.05), width, height, alpha: alphaOf(ctx, width, height), layer: s.layer });
  }
  return stamps;
}

function alphaOf(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3]!;
  return out;
}

/**
 * Presses stamps into a strip of rows (RGBA, `width` px wide, starting at page
 * row y0). "layers": one ink per channel, 255 = paper; marks become solid ink
 * (alpha ≥ 50%) so layers stay pure black and white. "color": marks are
 * blended in black.
 */
export function applyStamps(strip: Uint8Array, width: number, y0: number, rows: number, stamps: Stamp[], mode: "layers" | "color", inkCount: number, scale = 1): void {
  for (const s of stamps) {
    // Stamps are in page px; a strip may be at a lower resolution (the proof).
    const sx = s.x / scale;
    const sy = s.y / scale;
    const sw = s.width / scale;
    const sh = s.height / scale;
    const ya = Math.max(y0, Math.floor(sy));
    const yb = Math.min(y0 + rows, Math.ceil(sy + sh));
    const xa = Math.max(0, Math.floor(sx));
    const xb = Math.min(width, Math.ceil(sx + sw));
    for (let y = ya; y < yb; y++) {
      const ay = Math.floor((y - sy) * scale);
      if (ay < 0 || ay >= s.height) continue;
      for (let x = xa; x < xb; x++) {
        const ax = Math.floor((x - sx) * scale);
        if (ax < 0 || ax >= s.width) continue;
        const a = s.alpha[ay * s.width + ax]!;
        if (a === 0) continue;
        const o = ((y - y0) * width + x) * 4;
        if (mode === "layers") {
          if (a < 128) continue;
          if (s.layer === null) for (let c = 0; c < inkCount; c++) strip[o + c] = 0;
          else strip[o + s.layer] = 0;
        } else {
          const k = 1 - a / 255;
          strip[o] = Math.round(strip[o]! * k);
          strip[o + 1] = Math.round(strip[o + 1]! * k);
          strip[o + 2] = Math.round(strip[o + 2]! * k);
          strip[o + 3] = Math.max(strip[o + 3]!, a);
        }
      }
    }
  }
}
