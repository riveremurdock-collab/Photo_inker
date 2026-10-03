// Auto palette: picks inks from the image's colors, in one of three styles.
//
// - Balanced (as first built): the image's main colors by area, from
//   k-means in Lab with one cluster per ink.
// - Vibrant: colorful areas count for more than dull ones, inks must differ
//   in hue, and each ink is its cluster's most saturated version.
// - Contrasting: the set of image colors that differ most from each other.
//
// The other styles (and Balanced's "Try another") work from about a dozen
// candidate colors: every set of inks among them is scored for the style, and
// "Try another" steps down the ranking, skipping sets that look the same as
// one already offered. Vividness then pushes each ink toward the most
// saturated color of its hue and lightness that sRGB can show.
//
// When the background is kept, the paper color is added as a fixed cluster.
// Pixels close to the paper join it, so inks aren't wasted on colors the paper
// already provides (e.g. a white sky on white paper). When the background is
// picked from the image too, the lightest cluster becomes the paper.
//
// Runs on a ~160 px copy of the image, which takes a few milliseconds, so it
// stays on the main thread.

import { createRng } from "../util/rng";
import { deltaE76, hexToRgb, labToLinear, labToRgb, linearToLab, rgbToHex, rgbToLab, srgbToLinearChannel, type Lab } from "../util/color";

const SAMPLE_EDGE = 160;
const ITERATIONS = 30;
const RESTARTS = 4;

export type AutoStyle = "balanced" | "vibrant" | "contrast";

export interface AutoPaletteOptions {
  style: AutoStyle;
  /** 0–1: how far each ink is pushed toward its most saturated version. */
  vividness: number;
  /** "Try another": 0 = the best palette, 1 = the next, … (wraps around). */
  variant: number;
}

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

/** Today's Balanced palette: one k-means cluster per ink. */
function balancedPalette(points: Lab[], inkCount: number, keepPaper: string | null): AutoPaletteResult {
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

// ---- Candidates and styles ----

/** Candidate colors found in the image (before choosing inks among them): over all pixels, and over the colorful ones. */
const CANDIDATES = 12;
const COLORFUL_CANDIDATES = 8;
/** Inks closer than this (ΔE) count as the same color. */
const SAME_COLOR = 12;
/**
 * Vibrant's own saturation boost, before the Vividness slider: photos are often
 * less colorful than riso inks, and picking from the image alone can't go beyond
 * what is there.
 */
const VIBRANT_BOOST = 0.4;

interface Candidate {
  /** Share of the image's (non-paper) pixels. */
  share: number;
  /** Strongest version (farthest from the paper), as Balanced uses. */
  strong: Lab;
  /** Most saturated version. */
  vivid: Lab;
}

const chroma = (c: Lab) => Math.hypot(c.a, c.b);
const hueDiff = (x: Lab, y: Lab) => {
  const d = Math.abs(Math.atan2(x.b, x.a) - Math.atan2(y.b, y.a)) * (180 / Math.PI);
  return d > 180 ? 360 - d : d;
};

/** The average of a cluster's members with the highest chroma (its most saturated version). */
function vividColor(points: Lab[], assign: Int32Array, cluster: number, fallback: Lab): Lab {
  const members: Lab[] = [];
  for (let i = 0; i < points.length; i++) if (assign[i] === cluster) members.push(points[i]!);
  if (members.length === 0) return fallback;
  members.sort((a, b) => chroma(b) - chroma(a));
  const n = Math.max(1, Math.round(members.length * STRONG_SHARE));
  const sum = { l: 0, a: 0, b: 0 };
  for (let i = 0; i < n; i++) {
    sum.l += members[i]!.l;
    sum.a += members[i]!.a;
    sum.b += members[i]!.b;
  }
  return { l: sum.l / n, a: sum.a / n, b: sum.b / n };
}

function candidates(points: Lab[], keepPaper: string | null): { candidates: Candidate[]; paper: Lab } {
  const paperRgb = keepPaper ? hexToRgb(keepPaper) : null;
  const fixed = paperRgb ? [rgbToLab(paperRgb)] : [];
  const k = Math.min(CANDIDATES + 1, Math.max(fixed.length + 1, points.length));
  let best: ReturnType<typeof kmeans> | null = null;
  for (let r = 0; r < RESTARTS; r++) {
    const result = kmeans(points, k, fixed, 101 + r * 7919);
    if (!best || result.error < best.error) best = result;
  }
  const { centers, assign } = best!;
  const paperIndex = keepPaper ? 0 : centers.reduce((a, c, i) => (c.l > centers[a]!.l ? i : a), 0);
  const paper = centers[paperIndex] ?? { l: 100, a: 0, b: 0 };
  const counts = new Array<number>(centers.length).fill(0);
  for (let i = 0; i < points.length; i++) counts[assign[i]!]!++;
  const inkPixels = points.length - (counts[paperIndex] ?? 0) || 1;
  const list: Candidate[] = [];
  centers.forEach((c, i) => {
    if (i === paperIndex || counts[i] === 0) return;
    list.push({ share: counts[i]! / inkPixels, strong: strongestColor(points, assign, i, paper, c), vivid: vividColor(points, assign, i, c) });
  });

  // Clustering every pixel equally averages small colorful areas into dull
  // ones. So also cluster just the colorful pixels, grouped mostly by hue
  // (lightness counts half), to give Vibrant real colors to choose from.
  const chromas = points.map(chroma).sort((a, b) => a - b);
  const cut = Math.max(12, chromas[Math.floor(chromas.length * 0.6)] ?? 0);
  const colorful = points.filter((p) => chroma(p) >= cut);
  if (colorful.length >= 20) {
    const squashed = colorful.map((p) => ({ l: p.l * 0.5, a: p.a, b: p.b }));
    const kc = Math.min(COLORFUL_CANDIDATES, colorful.length);
    let bestC: ReturnType<typeof kmeans> | null = null;
    for (let r = 0; r < RESTARTS; r++) {
      const result = kmeans(squashed, kc, [], 211 + r * 7919);
      if (!bestC || result.error < bestC.error) bestC = result;
    }
    const cc = new Array<number>(kc).fill(0);
    for (let i = 0; i < colorful.length; i++) cc[bestC!.assign[i]!]!++;
    bestC!.centers.forEach((c, i) => {
      if (cc[i] === 0) return;
      const center = { l: c.l * 2, a: c.a, b: c.b };
      const cand = {
        share: cc[i]! / inkPixels,
        strong: strongestColor(colorful, bestC!.assign, i, paper, center),
        vivid: vividColor(colorful, bestC!.assign, i, center),
      };
      // Skip colors the first set already has.
      if (!list.some((x) => deltaE76(x.vivid, cand.vivid) < 8)) list.push(cand);
    });
  }
  return { candidates: list, paper };
}

/** The ink color a style takes from a candidate: Vibrant the most saturated version, the others the strongest. */
const inkOf = (c: Candidate, style: AutoStyle) => (style === "vibrant" ? c.vivid : c.strong);

/** How well a set of candidates suits the style (higher is better). */
function score(set: Candidate[], style: AutoStyle): number {
  const colors = set.map((c) => inkOf(c, style));
  let s: number;
  if (style === "balanced") s = set.reduce((t, c) => t + c.share, 0);
  // Vibrant: color counts much more than area (chroma ^1.5), but a speck still isn't worth an ink.
  else if (style === "vibrant") s = set.reduce((t, c, i) => t + Math.pow(chroma(colors[i]!), 1.5) * Math.pow(c.share, 0.25) * Math.min(1, c.share / 0.01), 0);
  else {
    // Contrasting: the closest pair matters most; the average helps break ties.
    let min = Infinity;
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const d = deltaE76(colors[i]!, colors[j]!);
        min = Math.min(min, d);
        sum += d;
        pairs++;
      }
    }
    s = pairs ? min + 0.25 * (sum / pairs) : chroma(colors[0]!);
    // Tiny specks of color don't deserve a whole ink.
    for (const c of set) s *= Math.min(1, c.share / 0.02);
  }
  // Inks that look alike are wasted: penalize near-duplicates (and, for Vibrant, the same hue twice).
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      if (deltaE76(colors[i]!, colors[j]!) < SAME_COLOR) s *= 0.3;
      else if (style === "vibrant" && chroma(colors[i]!) > 15 && chroma(colors[j]!) > 15 && hueDiff(colors[i]!, colors[j]!) < 30) s *= 0.5;
    }
  }
  return s;
}

/** Every way to choose n of the items. */
function combinations<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, chosen: T[]) => {
    if (chosen.length === n) {
      out.push(chosen.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      chosen.push(items[i]!);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return out;
}

/** Do two palettes (sorted the same way) look the same? */
function samePalette(a: Lab[], b: Lab[]): boolean {
  return a.length === b.length && a.every((c, i) => deltaE76(c, b[i]!) < SAME_COLOR);
}

const sortLight = (inks: Lab[]) => inks.slice().sort((x, y) => y.l - x.l);
const toLab = (hex: string) => rgbToLab(hexToRgb(hex) ?? { r: 0, g: 0, b: 0 });

/** Ranked palettes for the style, near-duplicates removed (up to 24). */
function rankedPalettes(cands: Candidate[], inkCount: number, style: AutoStyle, first: Lab[] | null): Lab[][] {
  const n = Math.min(inkCount, cands.length);
  const sets = combinations(cands, n)
    .map((set) => ({ set, score: score(set, style) }))
    .sort((a, b) => b.score - a.score);
  const out: Lab[][] = first ? [first] : [];
  for (const { set } of sets) {
    const inks = sortLight(set.map((c) => inkOf(c, style)));
    if (!out.some((p) => samePalette(p, inks))) out.push(inks);
    if (out.length >= 24) break;
  }
  return out;
}

const inGamut = (lab: Lab) => {
  const c = labToLinear(lab);
  return [c.r, c.g, c.b].every((v) => v >= -1e-4 && v <= 1 + 1e-4);
};

/** Pushes a color toward the most saturated version of its hue and lightness that sRGB can show. */
function vivid(lab: Lab, amount: number): Lab {
  const c = chroma(lab);
  // Grays have no hue to push; colors already outside sRGB stay as they are.
  if (amount <= 0 || c < 3 || !inGamut(lab)) return lab;
  const ua = lab.a / c;
  const ub = lab.b / c;
  let lo = c;
  let hi = 200;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut({ l: lab.l, a: ua * mid, b: ub * mid })) lo = mid;
    else hi = mid;
  }
  const target = c + (lo - c) * amount;
  return { l: lab.l, a: ua * target, b: ub * target };
}

/**
 * @param inkCount number of inks to pick (1–4)
 * @param keepPaper the current paper color to keep, or null to pick the paper from the image
 */
export function autoPalette(
  bitmap: ImageBitmap,
  inkCount: number,
  keepPaper: string | null,
  options: AutoPaletteOptions = { style: "balanced", vividness: 0, variant: 0 },
): AutoPaletteResult {
  const points = samplePixels(bitmap);
  if (points.length === 0) return { inks: Array(inkCount).fill("#000000"), paper: keepPaper ?? "#ffffff" };
  const { style, vividness, variant } = options;
  const original = balancedPalette(points, inkCount, keepPaper);

  let inks: Lab[];
  let paper = original.paper;
  if (style === "balanced" && variant === 0) {
    inks = original.inks.map(toLab);
  } else {
    const found = candidates(points, keepPaper);
    if (!keepPaper) paper = rgbToHex(labToRgb(found.paper));
    // Balanced keeps its original palette first, so "Try another" starts from it.
    const first = style === "balanced" ? sortLight(original.inks.map(toLab)) : null;
    const ranked = rankedPalettes(found.candidates, inkCount, style, first);
    inks = ranked.length ? ranked[variant % ranked.length]! : original.inks.map(toLab);
    // Fewer candidates than inks: repeat the darkest, as Balanced does.
    while (inks.length < inkCount) inks.push(inks[inks.length - 1] ?? { l: 0, a: 0, b: 0 });
  }
  // Vibrant adds its own boost; the slider pushes further toward full saturation.
  const amount = style === "vibrant" ? 1 - (1 - VIBRANT_BOOST) * (1 - vividness) : vividness;
  return { inks: sortLight(inks.map((c) => vivid(c, amount))).map((c) => rgbToHex(labToRgb(c))), paper };
}
