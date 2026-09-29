// Color schemes: generate a palette from a first color. Hues are rotated in
// OKLCH (a perceptual space), so the generated colors keep the first color's
// lightness and look evenly spaced. Each scheme locks in its number of colors.

import { hexToRgb, oklchToRgb, rgbToHex, rgbToOklch } from "../util/color";

export type SchemeId = "complementary" | "analogous" | "triad" | "square" | "monotone" | "cmyk";

export const SCHEMES: readonly { id: SchemeId; label: string; count: number }[] = [
  { id: "complementary", label: "Complementary", count: 2 },
  { id: "analogous", label: "Analogous", count: 3 },
  { id: "triad", label: "Triad", count: 3 },
  { id: "square", label: "Square", count: 4 },
  { id: "monotone", label: "Monotone", count: 3 },
  { id: "cmyk", label: "CMYK analog", count: 4 },
];

/**
 * CMYK analog: four riso inks standing in for C, M, Y, K. Hex codes are
 * approximate screen colors (to be replaced with measured values later).
 */
export const CMYK_ANALOG = [
  { name: "Medium Blue", hex: "#3255a4" },
  { name: "Fluorescent Pink", hex: "#ff48b0" },
  { name: "Yellow", hex: "#ffe800" },
  { name: "Black", hex: "#000000" },
] as const;

export function schemeCount(id: string): number {
  return SCHEMES.find((s) => s.id === id)?.count ?? 3;
}

/** All the scheme's colors, first color first. */
function schemeColors(id: SchemeId, baseHex: string): string[] {
  if (id === "cmyk") return CMYK_ANALOG.map((i) => i.hex);
  const base = rgbToOklch(hexToRgb(baseHex) ?? { r: 0, g: 120, b: 191 });
  const rotate = (deg: number) => rgbToHex(oklchToRgb({ ...base, h: (base.h + deg + 360) % 360 }));
  switch (id) {
    case "complementary":
      return [baseHex, rotate(180)];
    case "analogous":
      return [baseHex, rotate(-30), rotate(30)];
    case "triad":
      return [baseHex, rotate(120), rotate(240)];
    case "square":
      return [baseHex, rotate(90), rotate(180), rotate(270)];
    case "monotone":
      // Same hue: the first color, a lighter tint, and a darker shade.
      return [
        baseHex,
        rgbToHex(oklchToRgb({ l: Math.min(0.95, base.l + 0.25), c: base.c * 0.55, h: base.h })),
        rgbToHex(oklchToRgb({ l: Math.max(0.12, base.l - 0.25), c: base.c * 0.9, h: base.h })),
      ];
  }
}

export interface SchemeResult {
  inks: string[];
  /** The paper color, when the background takes one of the scheme's slots. */
  paper: string | null;
}

/** Paper-like tint of a scheme color: same hue, very light, gentle chroma, so inks stay visible on it. */
function paperTint(hex: string): string {
  const c = rgbToOklch(hexToRgb(hex) ?? { r: 255, g: 255, b: 255 });
  return rgbToHex(oklchToRgb({ l: 0.95, c: Math.min(c.c, 0.035), h: c.h }));
}

/**
 * Generates the palette. With includeBackground, the lightest color other
 * than the first takes the background slot (so a triad gives 2 inks +
 * background), as a pale paper tint of that color.
 */
export function generateScheme(id: SchemeId, baseHex: string, includeBackground: boolean): SchemeResult {
  const colors = schemeColors(id, baseHex);
  if (!includeBackground) return { inks: colors, paper: null };
  const firstIndex = id === "cmyk" ? -1 : 0;
  let lightest = -1;
  let lightestL = -Infinity;
  colors.forEach((hex, i) => {
    if (i === firstIndex) return;
    const l = rgbToOklch(hexToRgb(hex)!).l;
    if (l > lightestL) {
      lightestL = l;
      lightest = i;
    }
  });
  const slot = colors[lightest];
  return { inks: colors.filter((_, i) => i !== lightest), paper: slot ? paperTint(slot) : null };
}
