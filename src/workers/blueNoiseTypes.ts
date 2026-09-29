// Messages for blueNoise.worker.ts.

export interface BlueNoiseRequest {
  size: number;
  sigma: number;
}

export interface BlueNoiseResult {
  size: number;
  /** size × size thresholds in 0..1 (row-major). */
  thresholds: Float32Array;
  /** Coverage of round dots at densities 0..1 in 64 steps (65 values). */
  roundCoverage: Float32Array;
}
