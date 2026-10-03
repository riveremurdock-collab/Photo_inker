// Crop, rotate and straighten: the image's geometry, applied once to the
// uploaded photo to make the image everything else works on.
//
// Coordinates: the photo is first turned in 90° steps, giving a frame of
// W × H px (the "turned frame"). Straightening rotates the photo about the
// frame's center by up to ±45°. The crop is an axis-aligned rectangle in that
// frame, stored as fractions of W and H, and must stay inside the tilted
// photo so no empty corners show.
//
// Every crop rectangle that fits inside the tilted photo, as a set of corner
// positions, is convex. So between a rectangle that fits and one that doesn't,
// a binary search finds the closest one that fits (fitBetween): used to keep
// the crop inside when straightening and while dragging the crop box.

export type Turn = 0 | 90 | 180 | 270;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Geometry {
  turn: Turn;
  /** Degrees, positive = clockwise. */
  straighten: number;
  /** Fractions of the turned frame. */
  crop: Rect;
}

export const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** The adjust settings that hold the geometry. */
export const GEOMETRY_KEYS = ["turn", "straighten", "cropX", "cropY", "cropW", "cropH"] as const;

export function geometryOf(adjust: Record<string, unknown>): Geometry {
  const turn = Number(adjust.turn) as Turn;
  return {
    turn: turn === 90 || turn === 180 || turn === 270 ? turn : 0,
    straighten: Number(adjust.straighten) || 0,
    crop: { x: Number(adjust.cropX) || 0, y: Number(adjust.cropY) || 0, w: Number(adjust.cropW) || 1, h: Number(adjust.cropH) || 1 },
  };
}

export const isIdentity = (g: Geometry) =>
  g.turn === 0 && Math.abs(g.straighten) < 1e-6 && g.crop.x <= 1e-6 && g.crop.y <= 1e-6 && g.crop.w >= 1 - 1e-6 && g.crop.h >= 1 - 1e-6;

/** Size of the photo turned by `turn`. */
export function turnedSize(width: number, height: number, turn: Turn): [number, number] {
  return turn === 90 || turn === 270 ? [height, width] : [width, height];
}

/** Does a rectangle (turned-frame px) lie inside the W × H photo tilted by `deg` about the frame center? */
export function fits(r: Rect, W: number, H: number, deg: number): boolean {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Half a pixel of slack, so edges that land exactly on the photo's edge count.
  const hw = W / 2 + 0.5;
  const hh = H / 2 + 0.5;
  for (const [px, py] of [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ] as const) {
    // Into the photo's own axes: rotate the corner back by the tilt.
    const dx = px - W / 2;
    const dy = py - H / 2;
    const u = c * dx + s * dy;
    const v = -s * dx + c * dy;
    if (Math.abs(u) > hw || Math.abs(v) > hh) return false;
  }
  return true;
}

/**
 * The largest rectangle of aspect `aspect` (width / height; null = the
 * frame's own) centered in the frame that fits inside the tilted photo.
 */
export function largestRect(W: number, H: number, deg: number, aspect: number | null): Rect {
  const a = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const k = aspect ?? W / H;
  // Half-height h, half-width k·h: |k·h·c| + |h·s| ≤ W/2 and |k·h·s| + |h·c| ≤ H/2.
  const hh = Math.min(W / 2 / (k * c + s), H / 2 / (k * s + c));
  const hw = k * hh;
  return { x: W / 2 - hw, y: H / 2 - hh, w: 2 * hw, h: 2 * hh };
}

const lerp = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});

/** From `from` toward `to`: the farthest rectangle along the way that still fits (from must fit). */
export function fitBetween(from: Rect, to: Rect, W: number, H: number, deg: number): Rect {
  if (fits(to, W, H, deg)) return to;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fits(lerp(from, to, mid), W, H, deg)) lo = mid;
    else hi = mid;
  }
  return lerp(from, to, lo);
}

/**
 * The crop kept inside the tilted photo: unchanged if it fits, otherwise the
 * closest fitting rectangle on the way to the largest centered one of the
 * same aspect (which always fits).
 */
export function keepInside(r: Rect, W: number, H: number, deg: number): Rect {
  if (fits(r, W, H, deg)) return r;
  const safe = largestRect(W, H, deg, r.w / r.h);
  // Search from the safe rectangle toward the wanted one.
  return fitBetween(safe, r, W, H, deg);
}

export const toPx = (r: Rect, W: number, H: number): Rect => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H });
export const toFrac = (r: Rect, W: number, H: number): Rect => ({ x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H });

/**
 * Draws the photo turned, straightened and cropped, at `scale` px per photo px.
 * The transform shared by the export of the edited image and the crop editor's display.
 */
export function drawGeometry(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number, g: Geometry, scale = 1): void {
  const [W, H] = turnedSize(width, height, g.turn);
  const crop = toPx(g.crop, W, H);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-crop.x, -crop.y);
  ctx.translate(W / 2, H / 2);
  ctx.rotate((g.straighten * Math.PI) / 180);
  ctx.rotate((g.turn * Math.PI) / 180);
  ctx.drawImage(source, -width / 2, -height / 2, width, height);
  ctx.restore();
}

/** The edited image (a new bitmap), or the original itself when nothing is changed. */
export function applyGeometry(bitmap: ImageBitmap, g: Geometry): ImageBitmap {
  if (isIdentity(g)) return bitmap;
  const [W, H] = turnedSize(bitmap.width, bitmap.height, g.turn);
  const crop = toPx(g.crop, W, H);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(crop.w)), Math.max(1, Math.round(crop.h)));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  drawGeometry(ctx, bitmap, bitmap.width, bitmap.height, g);
  return canvas.transferToImageBitmap();
}
