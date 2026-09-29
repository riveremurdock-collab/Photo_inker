// All halftone types. "None" (printer halftone) is built in: smooth coverage,
// no method code. To add a type: write its file (section + method) and add it
// to both lists below.

import { amSquare, amSquareSection } from "./amSquare";
import { fmBlueNoise, fmBlueNoiseSection } from "./fmBlueNoise";
import type { HalftoneMethod } from "./types";

const METHODS = [amSquare, fmBlueNoise];

export const HALFTONE_SECTIONS = [amSquareSection, fmBlueNoiseSection] as const;

export const HALFTONE_TYPE_OPTIONS = [
  { value: "none", label: "None (printer halftone)" },
  ...METHODS.map((m) => ({ value: m.id, label: m.label })),
];

/** The method for a halftone type, or null for "none". */
export function halftoneMethod(id: string): HalftoneMethod | null {
  return (METHODS.find((m) => m.id === id) ?? null) as unknown as HalftoneMethod | null;
}
