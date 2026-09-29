// Messages for inkMatch.worker.ts (kept separate so the app can import them
// without pulling the worker file into the main-thread build).
import type { SolveOptions } from "../engine/spectral/solver";

export interface InkMatchRequest {
  options: SolveOptions;
  size: number;
}

export interface InkMatchResult {
  size: number;
  lut: Uint8Array;
}
