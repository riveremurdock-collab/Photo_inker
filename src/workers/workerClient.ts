// Generalized from the stipple tool's StippleWorkerClient.
import type { WorkerRequest, WorkerResponse } from "./protocol";

/** Rejects a run() promise when a newer run() call supersedes it before it finishes. */
export class SupersededError extends Error {
  constructor() {
    super("Superseded by a newer request");
    this.name = "SupersededError";
  }
}

interface Pending<R> {
  resolve: (result: R) => void;
  reject: (error: Error) => void;
  onProgress: ((fraction: number) => void) | null;
}

/**
 * Main-thread handle to one worker. Each run() call supersedes any run still in
 * progress; only the latest request's messages are acted on, so stale results
 * from an old setting never reach the screen.
 */
export class WorkerClient<P, R> {
  private worker: Worker;
  private nextRequestId = 0;
  private latestRequestId = -1;
  private pending: Pending<R> | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<WorkerResponse<R>>) => {
      const message = event.data;
      if (message.requestId !== this.latestRequestId || !this.pending) return;

      if (message.type === "progress") {
        this.pending.onProgress?.(message.fraction);
      } else if (message.type === "done") {
        this.pending.resolve(message.result);
        this.pending = null;
      } else {
        this.pending.reject(new Error(message.message));
        this.pending = null;
      }
    };
  }

  run(payload: P, options: { transfer?: Transferable[]; onProgress?: (fraction: number) => void } = {}): Promise<R> {
    this.pending?.reject(new SupersededError());

    const requestId = this.nextRequestId++;
    this.latestRequestId = requestId;

    return new Promise<R>((resolve, reject) => {
      this.pending = { resolve, reject, onProgress: options.onProgress ?? null };
      const message: WorkerRequest<P> = { requestId, payload };
      this.worker.postMessage(message, options.transfer ?? []);
    });
  }

  terminate(): void {
    this.pending?.reject(new SupersededError());
    this.pending = null;
    this.worker.terminate();
  }
}
