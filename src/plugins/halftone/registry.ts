// All halftone types. "None" (printer halftone) is built in: smooth coverage,
// no method code. To add a type: write its file (section + method) and add it
// to the lists below.

import { amHex, amHexSection } from "./amHex";
import { amNoise, amNoiseSection } from "./amNoise";
import { amRings, amRingsSection } from "./amRings";
import { amSpiral, amSpiralSection } from "./amSpiral";
import { amSquare, amSquareSection } from "./amSquare";
import { amTuring, amTuringSection } from "./amTuring";
import { fmBlueNoise, fmBlueNoiseSection } from "./fmBlueNoise";
import { fmDiffusion, fmDiffusionSection } from "./fmDiffusion";
import { fmStipple, fmStippleSection } from "./fmStipple";
import type { HalftoneMethod } from "./types";

// In the outline's order: AM grids, then FM placements.
const METHODS = [amSquare, amHex, amNoise, amSpiral, amRings, amTuring, fmBlueNoise, fmStipple, fmDiffusion];

export const HALFTONE_SECTIONS = [
  amSquareSection,
  amHexSection,
  amNoiseSection,
  amSpiralSection,
  amRingsSection,
  amTuringSection,
  fmBlueNoiseSection,
  fmStippleSection,
  fmDiffusionSection,
] as const;

const GROUPS: Record<string, string> = { AM: "Amplitude (AM): dot size shows tone", FM: "Frequency (FM): dot count shows tone" };

/** "AM: square grid" → "Square grid" under the AM heading. */
export const HALFTONE_TYPE_OPTIONS = [
  { value: "none", label: "None (printer halftone)" },
  ...METHODS.map((m) => {
    const [, prefix = "", name = m.label] = /^(AM|FM): (.*)$/.exec(m.label) ?? [];
    return { value: m.id, label: name.charAt(0).toUpperCase() + name.slice(1), group: GROUPS[prefix] };
  }),
];

/** The method for a halftone type, or null for "none". */
export function halftoneMethod(id: string): HalftoneMethod | null {
  return (METHODS.find((m) => m.id === id) ?? null) as unknown as HalftoneMethod | null;
}
