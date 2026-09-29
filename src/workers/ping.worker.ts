// Smoke-test worker for Step 0: proves module workers build and run.
// Removed once a real worker exists.
import type { WorkerRequest, WorkerResponse } from "./protocol";

self.onmessage = (event: MessageEvent<WorkerRequest<string>>) => {
  const { requestId, payload } = event.data;
  const response: WorkerResponse<string> = { requestId, type: "done", result: `pong: ${payload}` };
  self.postMessage(response);
};
