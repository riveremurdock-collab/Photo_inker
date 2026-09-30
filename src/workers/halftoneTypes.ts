// Messages for halftone.worker.ts.
import type { DiffusionOptions } from "../engine/halftone/errorDiffusion";
import type { SpiralBuckets } from "../engine/halftone/spiral";

export type HalftoneJob =
  | { kind: "spiral"; count: number; divergence: number }
  | { kind: "diffusion"; coverage: Uint8Array; width: number; height: number; inkCount: number; options: DiffusionOptions };

export type HalftoneJobResult = ({ kind: "spiral" } & SpiralBuckets) | { kind: "diffusion"; bits: Uint8Array };
