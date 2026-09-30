// Messages for halftone.worker.ts.
import type { DiffusionOptions } from "../engine/halftone/errorDiffusion";
import type { NoiseKind } from "../engine/halftone/noiseField";
import type { SpiralBuckets } from "../engine/halftone/spiral";
import type { StippleParams } from "../engine/halftone/stipple";

export type HalftoneJob =
  | { kind: "spiral"; count: number; divergence: number }
  | { kind: "noiseField"; noise: NoiseKind; cluster: number; seed: number }
  | { kind: "stipplePoints"; irregularity: number }
  | { kind: "stippleMeasure"; irregularity: number; params: StippleParams }
  | { kind: "diffusion"; coverage: Uint8Array; width: number; height: number; inkCount: number; options: DiffusionOptions };

export type HalftoneJobResult = ({ kind: "spiral" } & SpiralBuckets) | { kind: "diffusion"; bits: Uint8Array }
  | { kind: "noiseField"; data: Uint8Array }
  | { kind: "stipplePoints"; data: Uint8Array }
  | { kind: "stippleMeasure"; table: Float32Array };
