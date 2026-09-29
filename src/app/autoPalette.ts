// Auto palette: finds the image's dominant colors with k-means in Lab.
//
// When the background is kept, the paper color is added as a fixed cluster.
// Pixels close to the paper join it, so inks aren't wasted on colors the paper
// already provides (e.g. a white sky on white paper). When the background is
// picked from the image too, the lightest cluster becomes the paper.
//
// Runs on a ~160 px copy of the image, which takes a few milliseconds, so it
// stays on the main thread.

import { createRng } from "../util/rng";
import { hexToRgb, labToRgb, linearToLab, rgbToHex, rgbToLab, srgbToLinearChannel, type Lab } from "../util/color";

const SAMPLE_EDGE = 160;
const ITERATIONS = 30;
const RESTARTS = 4;

export interface AutoPaletteResult {
  /** Ink colors, light to dark (lighter inks print first). */
  inks: string[];
  paper: string;
}

function samplePixels(bitmap: ImageBitmap): Lab[] {
  const k = Math.min(1, SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinearChannel(i / 255);

  const out: Lab[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 128) continue; // skip transparent pixels
    out.push(linearToLab({ r: lut[data[i]!]!, g: lut[data[i + 1]!]!, b: lut[data[i + 2]!]! }));
  }
  return out;
}

function dist2(a: Lab, b: Lab): number {
  const dl = a.l - b.l;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dl * dl + da * da + db * db;
}

/** k-means with k-means++ seeding. Centers listed in `fixed` never move. Returns centers and total error. */
function kmeans(
  points: Lab[],
  k: number,
  fixed: Lab[],
  seed: number,
): { centers: Lab[]; assign: Int32Array; error: number } {
  const rng = createRng(seed);
  const centers: Lab[] = [...fixed];
  const nearest = new Float64Array(points.length).fill(Infinity);
  const updateNearest = (c: Lab) => {
    for (let i = 0; i < points.length; i++) nearest[i] = Math.min(nearest[i]!, dist2(points[i]!, c));
  };
  for (const c of centers) updateNearest(c);

  while (centers.length < k) {
    let total = 0;
    for (let i = 0; i < points.length; i++) total += centers.length ? nearest[i]! : 1;
    let target = rng() * total;
    let pick = points.length - 1;
    for (let i = 0; i < points.length; i++) {
      target -= centers.length ? nearest[i]! : 1;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    const c = { ...points[pick]! };
    centers.push(c);
    updateNearest(c);
  }

  const assign = new Int32Array(points.length);
  let error = 0;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    error = 0;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(points[i]!, centers[c]!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[i] = best;
      error += bestD;
    }

    const sums = Array.from({ length: k }, () => ({ l: 0, a: 0, b: 0, n: 0 }));
    for (let i = 0; i < points.length; i++) {
      const s = sums[assign[i]!]!;
      const p = points[i]!;
      s.l += p.l;
      s.a += p.a;
      s.b += p.b;
      s.n++;
    }
    let moved = false;
    for (let c = fixed.length; c < k; c++) {
      const s = sums[c]!;
      if (s.n === 0) continue; // empty cluster keeps its position
      const next = { l: s.l / s.n, a: s.a / s.n, b: s.b / s.n };
      if (dist2(next, centers[c]!) > 1e-4) moved = true;
      centers[c] = next;
    }
    if (!moved) break;
  }
  return { centers, assign, error };
}

/** Share of each cluster (farthest from the paper) averaged into the ink color. */
const STRONG_SHARE = 0.3;

/**
 * An ink printed solid is the strongest version of its color; lighter tones come
 * from partial coverage. So instead of the cluster average (which includes those
 * tints and looks muddy), use the average of the cluster members farthest from
 * the paper.
 */
function strongestColor(points: Lab[], assign: Int32Array, cluster: number, paper: Lab, fallback: Lab): Lab {
  const members: { p: Lab; d: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    if (assign[i] === cluster) members.push({ p: points[i]!, d: dist2(points[i]!, paper) });
  }
  if (members.length === 0) return fallback;
  members.sort((a, b) => b.d - a.d);
  const n = Math.max(1, Math.round(members.length * STRONG_SHARE));
  const sum = { l: 0, a: 0, b: 0 };
  for (let i = 0; i < n; i++) {
    const m = members[i]!.p;
    sum.l += m.l;
    sum.a += m.a;
    sum.b += m.b;
  }
  return { l: sum.l / n, a: sum.a / n, b: sum.b / n };
}

/**
 * @param inkCount number of inks to pick (1–4)
 * @param keepPaper the current paper color to keep, or null to pick the paper from the image
 */
export function autoPalette(bitmap: ImageBitmap, inkCount: number, keepPaper: string | null): AutoPaletteResult {
  const points = samplePixels(bitmap);
  const paperRgb = keepPaper ? hexToRgb(keepPaper) : null;
  const fixed = paperRgb ? [rgbToLab(paperRgb)] : [];
  if (points.length === 0) return { inks: Array(inkCount).fill("#000000"), paper: keepPaper ?? "#ffffff" };
  const k = inkCount + 1;

  let best: ReturnType<typeof kmeans> | null = null;
  for (let r = 0; r < RESTARTS; r++) {
    const result = kmeans(points, Math.min(k, Math.max(points.length, fixed.length + 1)), fixed, 1 + r * 7919);
    if (!best || result.error < best.error) best = result;
  }
  if (!best) return { inks: Array(inkCount).fill("#000000"), paper: keepPaper ?? "#ffffff" };
  const { centers, assign } = best;

  // Fixed paper is cluster 0; otherwise the lightest cluster becomes the paper.
  const paperIndex = keepPaper ? 0 : centers.reduce((a, c, i) => (c.l > centers[a]!.l ? i : a), 0);
  const paperLab = centers[paperIndex] ?? { l: 100, a: 0, b: 0 };
  const inkLabs = centers
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => i !== paperIndex)
    .map(({ c, i }) => strongestColor(points, assign, i, paperLab, c));
  // Fewer distinct colors than inks (e.g. a tiny or flat image): repeat the darkest.
  while (inkLabs.length < inkCount) inkLabs.push(inkLabs[inkLabs.length - 1] ?? { l: 0, a: 0, b: 0 });

  inkLabs.sort((a, b) => b.l - a.l);
  return {
    inks: inkLabs.map((lab) => rgbToHex(labToRgb(lab))),
    paper: keepPaper ?? rgbToHex(labToRgb(paperLab)),
  };
}
