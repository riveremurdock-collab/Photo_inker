// Paper presets for the background/paper color.
// Ink presets (approximate Riso ink colors) will be added later; for now inks
// are chosen freely and identified by their hex code.

export interface NamedColor {
  name: string;
  hex: string;
}

export const PAPER_PRESETS: readonly NamedColor[] = [
  { name: "White", hex: "#ffffff" },
  { name: "Natural", hex: "#f6f3ec" },
  { name: "Cream", hex: "#f3e9d2" },
  { name: "Newsprint", hex: "#e8e4d8" },
  { name: "Kraft", hex: "#c9a77c" },
  { name: "Gray", hex: "#b9b8b4" },
  { name: "Black", hex: "#1e1e1e" },
];
