// Messages for halftone.worker.ts.
import type { DiffusionOptions } from "../engine/halftone/errorDiffusion";
import type { NoiseKind } from "../engine/halftone/noiseField";
import type { SpiralBuckets } from "../engine/halftone/spiral";

export type HalftoneJob =
  | { kind: "spiral"; count: number; divergence: number }
  | { kind: "noiseField"; noise: NoiseKind; cluster: number; seed: number }
  | { kind: "diffusion"; coverage: Uint8Array; width: number; height: number; inkCount: number; options: DiffusionOptions };

export type HalftoneJobResult = ({ kind: "spiral" } & SpiralBuckets) | { kind: "diffusion"; bits: Uint8Array }
  | { kind: "noiseField"; data: Uint8Array };
