// Builds void-and-cluster blue noise threshold maps off the main thread.
import { roundDotCoverage, voidAndCluster } from "../engine/halftone/voidAndCluster";
import type { BlueNoiseRequest, BlueNoiseResult } from "./blueNoiseTypes";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { yieldToEventLoop } from "./yield";

let latest = -1;

self.onmessage = async (event: MessageEvent<WorkerRequest<BlueNoiseRequest>>) => {
  const { requestId, payload } = event.data;
  latest = requestId;
  try {
    const thresholds = await voidAndCluster(payload.size, payload.sigma, yieldToEventLoop, () => latest !== requestId);
    if (!thresholds) return;
    const roundCoverage = roundDotCoverage(thresholds, payload.size);
    const response: WorkerResponse<BlueNoiseResult> = {
      requestId,
      type: "done",
      result: { size: payload.size, thresholds, roundCoverage },
    };
    (self as unknown as Worker).postMessage(response, [thresholds.buffer, roundCoverage.buffer]);
  } catch (err) {
    const response: WorkerResponse<BlueNoiseResult> = {
      requestId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
