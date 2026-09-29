// Builds Ink Matching lookup tables off the main thread.
import { buildInkLut } from "../engine/spectral/solver";
import type { InkMatchRequest, InkMatchResult } from "./inkMatchTypes";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { yieldToEventLoop } from "./yield";

// The newest request id seen. A running build checks this between slices and
// stops if a newer request has arrived.
let latest = -1;

self.onmessage = async (event: MessageEvent<WorkerRequest<InkMatchRequest>>) => {
  const { requestId, payload } = event.data;
  latest = requestId;
  try {
    const lut = await buildInkLut(payload.options, payload.size, () => latest !== requestId, yieldToEventLoop);
    if (!lut) return;
    const response: WorkerResponse<InkMatchResult> = { requestId, type: "done", result: { size: payload.size, lut } };
    (self as unknown as Worker).postMessage(response, [lut.buffer]);
  } catch (err) {
    const response: WorkerResponse<InkMatchResult> = {
      requestId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
