// Worker clients for heavy halftone jobs. Preview and export each get their
// own worker, so a preview update can never cancel a running export.
import type { HalftoneJob, HalftoneJobResult } from "../../workers/halftoneTypes";
import { WorkerClient } from "../../workers/workerClient";

const clients = new Map<string, WorkerClient<HalftoneJob, HalftoneJobResult>>();

export function halftoneWorker(purpose: "preview" | "export" | "spiral"): WorkerClient<HalftoneJob, HalftoneJobResult> {
  let client = clients.get(purpose);
  if (!client) {
    client = new WorkerClient(new Worker(new URL("../../workers/halftone.worker.ts", import.meta.url), { type: "module" }));
    clients.set(purpose, client);
  }
  return client;
}
