// CPU version of gamutCompress() in engine/gl/inkShader.ts (keep them in sync):
// out-of-gamut colors are desaturated toward their own luminance just enough
// to fit in sRGB; colors already inside are returned unchanged.

export function gamutCompress(c: number[]): number[] {
  let [r, g, b] = c as [number, number, number];
  const y = Math.min(1, Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b));
  const lo = Math.min(r, g, b);
  if (lo < 0) {
    const t = y / Math.max(y - lo, 1e-6);
    r = y + (r - y) * t;
    g = y + (g - y) * t;
    b = y + (b - y) * t;
  }
  const hi = Math.max(r, g, b);
  if (hi > 1) {
    const t = (1 - y) / Math.max(hi - y, 1e-6);
    r = y + (r - y) * t;
    g = y + (g - y) * t;
    b = y + (b - y) * t;
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp(r), clamp(g), clamp(b)];
}
