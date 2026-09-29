// Data passed between stages: one coverage map per ink.
// 0 = no ink, 1 = full ink. Up to 4 inks, so on the GPU a CoverageSet is a
// single RGBA texture with one ink per channel.

export const MAX_INKS = 4;

export interface CoverageSet {
  width: number;
  height: number;
  inkCount: number;
  /** Interleaved RGBA-style: pixel i, ink k at data[i * 4 + k]. Unused channels are 0. */
  data: Float32Array;
}

export function createCoverageSet(width: number, height: number, inkCount: number): CoverageSet {
  return { width, height, inkCount, data: new Float32Array(width * height * MAX_INKS) };
}
