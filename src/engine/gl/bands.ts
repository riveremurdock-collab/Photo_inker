// Heavy full-screen draws (the stipple halftone above all) are split into
// bands of rows so no single GPU job runs long. Windows resets the graphics
// driver when one job takes more than about 2 s, and the WebGL context is lost
// with it. Each band is drawn, then waited for, and its time teaches the cost
// of that shader (ms per pixel), so the next band is sized to about BAND_MS.
// Cheap shaders learn a small cost and still draw in one band.

import type { Gpu } from "./gpu";

/** Target GPU time per band. */
export const BAND_MS = 60;
/**
 * First band of a shader whose cost isn't known yet, in pixels: about 100 ms for
 * the heaviest seen (stipple at 64 samples per pixel on an integrated GPU).
 */
const FIRST_BAND_PIXELS = 4096;

/** Learned cost per shader key, ms per pixel. */
const costs = new Map<string, number>();

/** Rows for the next band of a draw `width` px wide, at most `remaining`. */
export function bandRows(key: string, width: number, remaining: number): number {
  const cost = costs.get(key);
  if (cost === undefined) return Math.max(1, Math.min(remaining, Math.floor(FIRST_BAND_PIXELS / width)));
  return Math.max(1, Math.min(remaining, Math.floor(BAND_MS / (cost * width))));
}

/**
 * Runs `draw` (one band of `pixels` px into `framebuffer`), waits for the GPU
 * to finish it, and updates the shader's cost. Returns the time taken, ms.
 */
export function timedBand(gpu: Gpu, framebuffer: WebGLFramebuffer | null, key: string, pixels: number, draw: () => void): number {
  const t0 = performance.now();
  draw();
  gpu.finish(framebuffer);
  const ms = performance.now() - t0;
  const measured = ms / Math.max(1, pixels);
  const old = costs.get(key);
  // Costs vary across the image (dark areas have more dots): rise at once, fall slowly.
  costs.set(key, old === undefined || measured > old ? measured : old * 0.8 + measured * 0.2);
  return ms;
}
