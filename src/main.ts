import "./style.css";
import { WorkerClient } from "./workers/workerClient";

// Step 0: blank app shell. Real layout, sections, and preview arrive in Step 1.

function buildShell(root: HTMLElement): HTMLElement {
  root.innerHTML = `
    <header class="app-header">
      <h1 class="app-title">Photo Inker</h1>
    </header>
    <main class="app-main">
      <section class="preview" aria-label="Preview">
        <p class="preview-empty">Upload an image to begin.</p>
      </section>
      <aside class="panel" aria-label="Settings"></aside>
    </main>
    <footer class="status" aria-live="polite"></footer>
  `;
  return root.querySelector<HTMLElement>(".status")!;
}

async function checkEnvironment(status: HTMLElement): Promise<void> {
  const gl2 = !!document.createElement("canvas").getContext("webgl2");

  let workerOk = false;
  try {
    const client = new WorkerClient<string, string>(
      new Worker(new URL("./workers/ping.worker.ts", import.meta.url), { type: "module" }),
    );
    workerOk = (await client.run("hello")) === "pong: hello";
    client.terminate();
  } catch {
    workerOk = false;
  }

  status.textContent = `WebGL2: ${gl2 ? "OK" : "not available"} · Workers: ${workerOk ? "OK" : "failed"}`;
}

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  const status = buildShell(app);
  void checkEnvironment(status);
}
