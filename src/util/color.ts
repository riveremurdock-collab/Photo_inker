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

function labFInv(t: number): number {
  return t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787;
}

export function labToLinear(lab: Lab): LinearRgb {
  const fy = (lab.l + 16) / 116;
  const x = WHITE.x * labFInv(fy + lab.a / 500);
  const y = WHITE.y * labFInv(fy);
  const z = WHITE.z * labFInv(fy - lab.b / 200);
  return {
    r: 3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    g: -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    b: 0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  };
}

/** Lab to sRGB 0..255, clipped to the sRGB gamut. */
export function labToRgb(lab: Lab): RgbColor {
  return linearToRgb(labToLinear(lab));
}

// ---- Oklab / OKLCH (Björn Ottosson, public domain) ----
// A perceptual space: equal steps in hue look like equal changes, and lightness
// stays even when hue rotates. Used to build color schemes.

export interface Oklch {
  l: number; // 0..1
  c: number; // chroma, ~0..0.37
  h: number; // hue, degrees
}

export function linearToOklab(c: LinearRgb): { l: number; a: number; b: number } {
  const l = Math.cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  const m = Math.cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  const s = Math.cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToLinear(lab: { l: number; a: number; b: number }): LinearRgb {
  const l = (lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
  const m = (lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
  const s = (lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

export function rgbToOklch(color: RgbColor): Oklch {
  const lab = linearToOklab(rgbToLinear(color));
  return { l: lab.l, c: Math.hypot(lab.a, lab.b), h: ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360 };
}

/** OKLCH to sRGB, reducing chroma (keeping hue and lightness) until the color fits in sRGB. */
export function oklchToRgb(color: Oklch): RgbColor {
  const l = Math.min(1, Math.max(0, color.l));
  const rad = (color.h * Math.PI) / 180;
  const fits = (c: number) => {
    const lin = oklabToLinear({ l, a: c * Math.cos(rad), b: c * Math.sin(rad) });
    return lin.r >= -1e-4 && lin.g >= -1e-4 && lin.b >= -1e-4 && lin.r <= 1.0001 && lin.g <= 1.0001 && lin.b <= 1.0001;
  };
  let c = Math.max(0, color.c);
  if (!fits(c)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  return linearToRgb(oklabToLinear({ l, a: c * Math.cos(rad), b: c * Math.sin(rad) }));
}
