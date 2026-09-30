// Export block (below the Export settings): a summary of what will be
// exported, the Export button, and a progress bar with Cancel.

import type { SourceStore } from "../../app/source";
import type { SettingsStore } from "../../app/store";
import { downloadBlob, ExportCancelled, exportImage, planExport } from "../../export/exporter";
import type { Pipeline } from "../../pipeline/pipeline";

export function createExportBlock(store: SettingsStore, source: SourceStore, pipeline: Pipeline): HTMLElement {
  const element = document.createElement("div");
  element.className = "export-block";

  const summary = document.createElement("p");
  summary.className = "export-summary";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "export-button";
  const progressRow = document.createElement("div");
  progressRow.className = "export-progress";
  progressRow.hidden = true;
  const bar = document.createElement("progress");
  bar.max = 1;
  bar.value = 0;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  progressRow.append(bar, cancel);
  const message = document.createElement("p");
  message.className = "control-help export-message";
  message.setAttribute("aria-live", "polite");
  element.append(summary, button, progressRow, message);

  let running = false;
  let cancelled = false;

  function refresh(): void {
    const image = source.get();
    const settings = store.get();
    const e = settings.export;
    const isPrint = settings.upload.mode === "print";
    button.textContent = !isPrint
      ? `Export ${e.digitalFormat.toUpperCase()}`
      : e.printTarget === "standard"
        ? `Export ${e.fileFormat.toUpperCase()} page`
        : "Export riso layers";
    button.disabled = running || !image;
    if (!image) {
      summary.textContent = "Upload an image to export.";
      return;
    }
    const plan = planExport(settings, image.width, image.height);
    const size = `${plan.width} × ${plan.height} px`;
    const inches = `${(plan.width / (plan.dpi ?? 600)).toFixed(2)} × ${(plan.height / (plan.dpi ?? 600)).toFixed(2)} in`;
    if (plan.kind === "riso") {
      const halftone = settings.halftone.type === "none" ? "smooth grayscale (the riso screens it)" : "black and white";
      const files = plan.format === "pdf" ? "one PDF, a page per layer" : "PNGs";
      const extras = [e.includeProof && "a color proof", e.includeSheet && "a print sheet"].filter(Boolean).join(" and ");
      summary.textContent = `${plan.inkCount} ${plan.inkCount === 1 ? "layer" : "layers"}, ${halftone}, ${inches} at ${plan.dpi} DPI (${size}), as ${files}${extras ? ` with ${extras}` : ""}, zipped.`;
    } else if (plan.kind === "standard") {
      summary.textContent = `One color page, ${inches} at ${plan.dpi} DPI (${size}), as ${plan.format.toUpperCase()}. No print simulation.`;
    } else {
      summary.textContent = `${plan.format.toUpperCase()}, ${size}${plan.format === "png" && e.transparent ? ", transparent background" : ""}.`;
    }
  }

  button.addEventListener("click", async () => {
    if (running) return;
    running = true;
    cancelled = false;
    progressRow.hidden = false;
    bar.value = 0;
    message.textContent = "Starting…";
    refresh();
    const t0 = performance.now();
    try {
      const result = await exportImage(
        pipeline,
        store.get(),
        source.get()?.fileName ?? "",
        (fraction, text) => {
          bar.value = fraction;
          message.textContent = text;
        },
        () => cancelled,
      );
      downloadBlob(result.blob, result.fileName);
      const mb = result.blob.size / (1024 * 1024);
      message.textContent = `Saved ${result.fileName} (${mb.toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    } catch (err) {
      message.textContent = err instanceof ExportCancelled ? "Export cancelled." : `Export failed: ${err instanceof Error ? err.message : String(err)}`;
      if (!(err instanceof ExportCancelled)) console.error(err);
    } finally {
      running = false;
      progressRow.hidden = true;
      refresh();
    }
  });
  cancel.addEventListener("click", () => {
    cancelled = true;
    message.textContent = "Cancelling…";
  });

  refresh();
  store.subscribe(refresh);
  source.subscribe(refresh);
  return element;
}
