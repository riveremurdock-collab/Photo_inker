// Heavy halftone jobs off the main thread: phyllotaxis spiral point tables and
// error diffusion, noise grid nudge fields, stipple point sets and tone tables.
import { errorDiffuse, type DiffusionOptions } from "../engine/halftone/errorDiffusion";
import { buildNoiseField } from "../engine/halftone/noiseField";
import { buildSpiral } from "../engine/halftone/spiral";
import {
  bucketStipplePoints,
  generateStipplePoints,
  measureStipple,
  STIPPLE_DENSITY,
  STIPPLE_TILE,
} from "../engine/halftone/stipple";
import type { HalftoneJob, HalftoneJobResult } from "./halftoneTypes";
import type { WorkerRequest, WorkerResponse } from "./protocol";

let latest = -1;

// The stipple point set is fixed (the seed only moves each ink's view of it), so it is built once.
let stipplePoints: Float32Array | null = null;
let stippleBuckets: { irregularity: number; data: Uint8Array } | null = null;

function stippleData(irregularity: number): Uint8Array {
  stipplePoints ??= generateStipplePoints(STIPPLE_TILE, STIPPLE_TILE * STIPPLE_TILE * STIPPLE_DENSITY, 1);
  if (stippleBuckets?.irregularity !== irregularity) {
    stippleBuckets = { irregularity, data: bucketStipplePoints(stipplePoints, STIPPLE_TILE, irregularity) };
  }
  return stippleBuckets.data;
}

self.onmessage = async (event: MessageEvent<WorkerRequest<HalftoneJob>>) => {
  const { requestId, payload } = event.data;
  latest = requestId;
  try {
    let result: HalftoneJobResult;
    let transfer: ArrayBuffer[];
    if (payload.kind === "spiral") {
      const s = buildSpiral(payload.count, payload.divergence);
      result = { kind: "spiral", ...s };
      transfer = [s.data.buffer as ArrayBuffer];
    } else if (payload.kind === "stipplePoints") {
      const data = stippleData(payload.irregularity).slice();
      result = { kind: "stipplePoints", data };
      transfer = [data.buffer as ArrayBuffer];
    } else if (payload.kind === "stippleMeasure") {
      const table = measureStipple(stippleData(payload.irregularity), STIPPLE_TILE, payload.params);
      result = { kind: "stippleMeasure", table };
      transfer = [table.buffer as ArrayBuffer];
    } else if (payload.kind === "noiseField") {
      const data = buildNoiseField(payload.noise, payload.cluster, payload.seed);
      result = { kind: "noiseField", data };
      transfer = [data.buffer as ArrayBuffer];
    } else {
      const bits = errorDiffuse(payload.coverage, payload.width, payload.height, payload.inkCount, payload.options as DiffusionOptions);
      result = { kind: "diffusion", bits };
      transfer = [bits.buffer as ArrayBuffer];
    }
    if (latest !== requestId) return;
    const response: WorkerResponse<HalftoneJobResult> = { requestId, type: "done", result };
    (self as unknown as Worker).postMessage(response, transfer);
  } catch (err) {
    const response: WorkerResponse<HalftoneJobResult> = {
      requestId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
