// Adapted from the stipple tool (pipeline/color/colorSpace.ts).
// DOM-free so workers can import it.

/** sRGB color, channels 0..255. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Linear-light RGB, channels 0..1. All mixing happens in linear light. */
export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

export interface Lab {
  l: number;
  a: number;
  b: number;
}

export function srgbToLinearChannel(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgbChannel(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function rgbToLinear(color: RgbColor): LinearRgb {
  return {
    r: srgbToLinearChannel(color.r / 255),
    g: srgbToLinearChannel(color.g / 255),
    b: srgbToLinearChannel(color.b / 255),
  };
}

export function linearToRgb(linear: LinearRgb): RgbColor {
  return {
    r: Math.round(linearToSrgbChannel(linear.r) * 255),
    g: Math.round(linearToSrgbChannel(linear.g) * 255),
    b: Math.round(linearToSrgbChannel(linear.b) * 255),
  };
}

// D65 white point and the sRGB linear-RGB -> XYZ matrix.
const WHITE = { x: 0.95047, y: 1.0, z: 1.08883 };

export function linearToXyz(linear: LinearRgb): { x: number; y: number; z: number } {
  return {
    x: 0.4124564 * linear.r + 0.3575761 * linear.g + 0.1804375 * linear.b,
    y: 0.2126729 * linear.r + 0.7151522 * linear.g + 0.072175 * linear.b,
    z: 0.0193339 * linear.r + 0.119192 * linear.g + 0.9503041 * linear.b,
  };
}

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function xyzToLab(xyz: { x: number; y: number; z: number }): Lab {
  const fx = labF(xyz.x / WHITE.x);
  const fy = labF(xyz.y / WHITE.y);
  const fz = labF(xyz.z / WHITE.z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function linearToLab(linear: LinearRgb): Lab {
  return xyzToLab(linearToXyz(linear));
}

export function rgbToLab(color: RgbColor): Lab {
  return linearToLab(rgbToLinear(color));
}

/** CIE76 (Euclidean distance in Lab). */
export function deltaE76(a: Lab, b: Lab): number {
  const dl = a.l - b.l;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

export function hexToRgb(hex: string): RgbColor | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m || !m[1]) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(color: RgbColor): string {
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${to(color.r)}${to(color.g)}${to(color.b)}`;
}
