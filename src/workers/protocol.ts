// Shared message envelope for every worker. Each job type defines its own
// payload and result types; the envelope handles request ids, progress, and errors.

export interface WorkerRequest<P> {
  requestId: number;
  payload: P;
}

export type WorkerResponse<R> =
  | { requestId: number; type: "progress"; fraction: number }
  | { requestId: number; type: "done"; result: R }
  | { requestId: number; type: "error"; message: string };
