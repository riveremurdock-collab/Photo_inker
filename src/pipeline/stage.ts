// Pipeline stages, in processing order. Each stage caches its output keyed by
// a hash of its own settings slice plus the versions of its inputs, so a
// setting change reruns only its own stage and the stages after it.

export const STAGE_ORDER = [
  "upload",
  "fadeBorder",
  "adjust",
  "split",
  "layerOptions",
  "halftone",
  "border",
  "printSim",
  "overlapTable",
  "mix",
] as const;

export type StageId = (typeof STAGE_ORDER)[number];

export interface StageContext {
  /** Preview renders at screen resolution; export at full resolution in tiles. */
  purpose: "preview" | "export";
  signal: AbortSignal;
}

export interface Stage<In, Out, S> {
  id: StageId;
  /** Stages whose outputs this stage reads. */
  inputs: StageId[];
  /** Picks the part of the project settings this stage depends on (hashed for the cache key). */
  selectSettings(project: unknown): S;
  run(input: In, settings: S, ctx: StageContext): Promise<Out>;
}
