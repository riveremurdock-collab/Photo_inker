// Riso ink and paper presets, and automatic ink naming.
//
// Hex values are approximate screen colors for common Riso inks, extended from
// the stipple tool's list. They are not calibrated against printed swatches
// (calibration is in the outline's "Save for Later" list).

import { deltaE76, hexToRgb, rgbToLab, type Lab } from "../util/color";

export interface NamedColor {
  name: string;
  hex: string;
}

export const RISO_INKS: readonly NamedColor[] = [
  { name: "Black", hex: "#000000" },
  { name: "Blue", hex: "#0078bf" },
  { name: "Medium Blue", hex: "#3255a4" },
  { name: "Federal Blue", hex: "#3d5588" },
  { name: "Cornflower", hex: "#62a8e5" },
  { name: "Aqua", hex: "#5ec8e5" },
  { name: "Teal", hex: "#00838a" },
  { name: "Green", hex: "#00a95c" },
  { name: "Kelly Green", hex: "#67b346" },
  { name: "Hunter Green", hex: "#407060" },
  { name: "Fluorescent Green", hex: "#44d62c" },
  { name: "Yellow", hex: "#ffe800" },
  { name: "Sunflower", hex: "#ffb511" },
  { name: "Orange", hex: "#ff6c2f" },
  { name: "Fluorescent Orange", hex: "#ff7477" },
  { name: "Bright Red", hex: "#f15060" },
  { name: "Scarlet", hex: "#f65058" },
  { name: "Red", hex: "#ff665e" },
  { name: "Fluorescent Red", hex: "#ff4c65" },
  { name: "Fluorescent Pink", hex: "#ff48b0" },
  { name: "Bubble Gum", hex: "#f984ca" },
  { name: "Cranberry", hex: "#d1517a" },
  { name: "Burgundy", hex: "#914e72" },
  { name: "Purple", hex: "#765ba7" },
  { name: "Violet", hex: "#9d7ad2" },
  { name: "Brown", hex: "#925f52" },
  { name: "Flat Gold", hex: "#bb8b41" },
  { name: "Metallic Gold", hex: "#ac936e" },
  { name: "Light Gray", hex: "#88898a" },
  { name: "Charcoal", hex: "#70747c" },
  { name: "White", hex: "#ffffff" },
];

export const PAPER_PRESETS: readonly NamedColor[] = [
  { name: "White", hex: "#ffffff" },
  { name: "Natural", hex: "#f6f3ec" },
  { name: "Cream", hex: "#f3e9d2" },
  { name: "Newsprint", hex: "#e8e4d8" },
  { name: "Kraft", hex: "#c9a77c" },
  { name: "Gray", hex: "#b9b8b4" },
  { name: "Black", hex: "#1e1e1e" },
];

const inkLabs = RISO_INKS.map((ink) => ({ ...ink, lab: rgbToLab(hexToRgb(ink.hex)!) }));

/** A Riso ink this close (ΔE76) counts as "that ink" for naming. */
const PRESET_MATCH_DISTANCE = 6;

/** Plain hue name, used when a color isn't close to a known ink. */
function describe(lab: Lab): string {
  const chroma = Math.hypot(lab.a, lab.b);
  if (chroma < 12) {
    if (lab.l < 20) return "Black";
    if (lab.l > 92) return "White";
    return "Gray";
  }
  const hue = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
  // Lab hue angles: red ≈ 40°, yellow ≈ 95°, green ≈ 150°, cyan ≈ 200°, blue ≈ 270–306°, magenta ≈ 330°.
  if (lab.l < 45 && hue > 30 && hue < 100) return "Brown";
  if (hue < 22 || hue >= 335) return "Pink";
  if (hue < 50) return "Red";
  if (hue < 75) return "Orange";
  if (hue < 110) return "Yellow";
  if (hue < 170) return "Green";
  if (hue < 240) return "Teal";
  if (hue < 310) return "Blue";
  return "Purple";
}

/** Name for an ink color: the matching Riso ink if there is one, otherwise a hue name. */
export function inkNameFor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "Ink";
  const lab = rgbToLab(rgb);
  let best: { name: string; d: number } | null = null;
  for (const ink of inkLabs) {
    const d = deltaE76(lab, ink.lab);
    if (!best || d < best.d) best = { name: ink.name, d };
  }
  return best && best.d <= PRESET_MATCH_DISTANCE ? best.name : describe(lab);
}
