// Heavy halftone jobs off the main thread: phyllotaxis spiral point tables and
// error diffusion, noise grid nudge fields.
import { errorDiffuse, type DiffusionOptions } from "../engine/halftone/errorDiffusion";
import { buildNoiseField } from "../engine/halftone/noiseField";
import { buildSpiral } from "../engine/halftone/spiral";
import type { HalftoneJob, HalftoneJobResult } from "./halftoneTypes";
import type { WorkerRequest, WorkerResponse } from "./protocol";

let latest = -1;

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
