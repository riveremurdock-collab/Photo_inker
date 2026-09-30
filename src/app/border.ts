// Border geometry and the fade falloff, shared by the pipeline (fade, before
// processing), the preview and the export (solid ink / paper border, after
// processing).
//
// Everything is in image px; sizes in the settings are % of the image's
// shorter side. A positive border thickness grows the canvas: it then spans
// [-margin, W + margin] × [-margin, H + margin], and the output grid starts at
// the canvas corner. Halftone patterns stay anchored to the image, so adding a
// border never moves the dots.

import type { ProjectSettings } from "../schema/sections";
import { sampleCurve, type CurvePoint } from "../util/curve";

type Border = ProjectSettings["border"];

export interface BorderGeometry {
  /** Image px added around the image on each side (0 unless thickness > 0). */
  margin: number;
  /** Canvas rect, image px: x0, y0, x1, y1. */
  canvas: [number, number, number, number];
  /** The visible image opening, image px: x0, y0, x1, y1. */
  inner: [number, number, number, number];
  /** Corner radius of the opening, image px. */
  radius: number;
  /** 0 = none, 1 = solid ink, 2 = paper. */
  mode: 0 | 1 | 2;
  /** Border ink slot (solid ink). */
  ink: number;
}

export function borderGeometry(b: Border, width: number, height: number, inkCount: number): BorderGeometry {
  const unit = Math.min(width, height) / 100;
  const mode = b.frame === "ink" ? 1 : b.frame === "paper" ? 2 : 0;
  const t = mode === 0 ? 0 : b.frameThickness * unit;
  const margin = Math.max(0, t);
  const inset = Math.min(Math.max(0, -t), Math.min(width, height) / 2);
  const inner: [number, number, number, number] = [inset, inset, width - inset, height - inset];
  const radius = mode === 0 ? 0 : Math.min(b.frameRadius * unit, Math.min(inner[2] - inner[0], inner[3] - inner[1]) / 2);
  return {
    margin,
    canvas: [-margin, -margin, width + margin, height + margin],
    inner,
    radius,
    mode,
    ink: Math.max(0, Math.min(inkCount - 1, Number(b.frameInk) || 0)),
  };
}

/** Canvas size in image px. */
export function canvasSize(g: BorderGeometry): { width: number; height: number } {
  return { width: g.canvas[2] - g.canvas[0], height: g.canvas[3] - g.canvas[1] };
}

export const FADE_LUT_SIZE = 256;

/**
 * Fade strength (1 at the edge, 0 at the fade distance) for t = distance from
 * the edge / fade distance, 0…1, sampled at FADE_LUT_SIZE steps. The midpoint
 * setting bends t so the curve reaches half strength at that share of the
 * distance.
 */
export function fadeLut(b: Border): Float32Array {
  let base: (x: number) => number;
  if (b.fadeCurve === "linear") base = (x) => 1 - x;
  else if (b.fadeCurve === "exponential") base = (x) => 1 - (Math.exp(4 * x) - 1) / (Math.exp(4) - 1);
  else if (b.fadeCurve === "custom") {
    const samples = sampleCurve(b.fadeCustom as readonly CurvePoint[], 1024);
    base = (x) => samples[Math.min(1023, Math.max(0, Math.round(x * 1023)))]!;
  } else base = (x) => 1 - x * x * (3 - 2 * x);

  // Where the base curve crosses half strength (first crossing from the edge).
  let half = 0.5;
  for (let i = 1; i <= 1024; i++) {
    const x0 = (i - 1) / 1024;
    const x1 = i / 1024;
    const y0 = base(x0) - 0.5;
    const y1 = base(x1) - 0.5;
    if (y0 === 0) {
      half = x0;
      break;
    }
    if ((y0 > 0 && y1 <= 0) || (y0 < 0 && y1 >= 0)) {
      half = x0 + ((x1 - x0) * y0) / (y0 - y1);
      break;
    }
  }
  half = Math.min(0.999, Math.max(0.001, half));
  const mid = Math.min(0.95, Math.max(0.05, b.fadeMidpoint / 100));
  const power = Math.log(half) / Math.log(mid);

  const out = new Float32Array(FADE_LUT_SIZE);
  for (let i = 0; i < FADE_LUT_SIZE; i++) {
    const t = i / (FADE_LUT_SIZE - 1);
    out[i] = Math.min(1, Math.max(0, base(Math.pow(t, power))));
  }
  out[0] = 1; // the very edge is always the full fade color
  out[FADE_LUT_SIZE - 1] = 0;
  return out;
}

/** Signed distance to a rounded rectangle (x0, y0, x1, y1), negative inside. */
export const GLSL_ROUNDED_RECT = /* glsl */ `
float roundedRectSdf(vec2 p, vec4 rect, float r) {
  vec2 c = (rect.xy + rect.zw) * 0.5;
  vec2 q = abs(p - c) - (rect.zw - rect.xy) * 0.5 + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

/**
 * Solid ink / paper border, for the preview compositor and the export. Needs
 * GLSL_ROUNDED_RECT. Positions are image px.
 */
export const GLSL_FRAME = /* glsl */ `
uniform vec4 uFrameCanvas;   // canvas rect
uniform vec4 uFrameInner;    // image opening
uniform float uFrameRadius;
uniform int uFrameMode;      // 0 none, 1 solid ink, 2 paper
uniform int uFrameInk;
bool frameOutsideCanvas(vec2 ip) { return any(lessThan(ip, uFrameCanvas.xy)) || any(greaterThanEqual(ip, uFrameCanvas.zw)); }
bool frameCovers(vec2 ip) { return uFrameMode != 0 && roundedRectSdf(ip, uFrameInner, uFrameRadius) > 0.0; }
int frameMask() { return uFrameMode == 1 ? (1 << uFrameInk) : 0; }
`;

export function frameUniforms(g: BorderGeometry): Record<string, number | number[]> {
  return {
    uFrameCanvas: g.canvas,
    uFrameInner: g.inner,
    uFrameRadius: g.radius,
    uFrameMode: g.mode,
    uFrameInk: g.ink,
  };
}
