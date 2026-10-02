import "./style.css";
import { baseName, loadImageFile, UploadError } from "./app/loadImage";
import { SourceStore } from "./app/source";
import { SettingsStore } from "./app/store";
import { findSetting } from "./schema/registry";
import { createUploadBlock } from "./ui/sections/upload";
import { Panel } from "./ui/panel";
import { Preview } from "./ui/preview/preview";
import { hexToRgb, srgbToLinearChannel } from "./util/color";
import { PaletteActions } from "./app/palette";
import { Eyedropper } from "./ui/preview/eyedropper";
import { createPaletteBlock } from "./ui/sections/palette";
import { InkTestView } from "./ui/inkTestView";
import { Pipeline } from "./pipeline/pipeline";
import { createLayersBlock } from "./ui/sections/layers";
import { createToneMapBlock } from "./ui/sections/toneMap";
import { createAmBlock, createHexBlock } from "./ui/sections/halftone";
import { createExportBlock } from "./ui/sections/export";
import { createChannelSplitBlock } from "./ui/sections/channelSplit";
import { createSelectiveColorBlock } from "./ui/sections/selectiveColor";
import { outputLayout } from "./app/layout";
import { layerLabels, markShapes } from "./export/marks";
import { GPU_RESET_MESSAGE } from "./export/exporter";

const DEBUG = new URLSearchParams(location.search).has("debug");

// Matches --color-light-sage (#edf2e9), in linear light for the renderer.
const PREVIEW_BACKGROUND: [number, number, number] = [0xed, 0xf2, 0xe9].map((v) => srgbToLinearChannel(v / 255)) as [
  number,
  number,
  number,
];

function start(root: HTMLElement): void {
  const settings = new SettingsStore();
  const source = new SourceStore();

  // ---- Header ----
  const header = document.createElement("header");
  header.className = "app-header";
  header.innerHTML = `<h1 class="app-title">Photo Inker</h1><span class="mode-badge"></span>`;
  const modeBadge = header.querySelector<HTMLElement>(".mode-badge")!;

  // ---- Notices (errors and info), shown over the preview ----
  const notice = document.createElement("div");
  notice.className = "notice";
  notice.setAttribute("role", "alert");
  notice.hidden = true;
  const showNotice = (message: string, kind: "error" | "info" = "error", action?: { label: string; onClick: () => void }) => {
    notice.innerHTML = "";
    notice.className = `notice notice-${kind}`;
    const text = document.createElement("span");
    text.textContent = message;
    notice.append(text);
    if (action) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "notice-action";
      b.textContent = action.label;
      b.addEventListener("click", action.onClick);
      notice.append(b);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => (notice.hidden = true));
    notice.append(close);
    notice.hidden = false;
  };

  // ---- Upload handling ----
  let nameFollowsFile = true;
  const uploadBlock = createUploadBlock((files) => void handleFiles(files));

  async function handleFiles(files: FileList): Promise<void> {
    const file = files[0];
    if (!file) return;
    if (files.length > 1) showNotice("Only one image can be used at a time. Using the first one.", "info");
    else notice.hidden = true;

    uploadBlock.setBusy(true);
    try {
      const bitmap = await loadImageFile(file);
      source.set(file.name, bitmap);
      if (nameFollowsFile) {
        settings.set("upload", "projectName", baseName(file.name).slice(0, 60));
        nameFollowsFile = true; // the set() above isn't a user edit
      }
    } catch (err) {
      showNotice(err instanceof UploadError ? err.message : "Something went wrong opening that image.");
      if (!(err instanceof UploadError)) console.error(err);
    } finally {
      uploadBlock.setBusy(false);
    }
  }

  // ---- Status bar ----
  const status = document.createElement("footer");
  status.className = "status";
  let zoomPercent = 100;
  let busyMessage: string | null = null;
  function updateStatus(): void {
    const image = source.get();
    const parts = image ? [`${image.width} × ${image.height} px`, `${zoomPercent}%`] : ["No image loaded"];
    if (busyMessage) parts.push(busyMessage);
    status.textContent = parts.join(" · ");
  }

  // ---- Preview ----
  let pipelineRef: Pipeline | null = null;
  let preview: Preview;
  try {
    preview = new Preview({
      background: PREVIEW_BACKGROUND,
      onFilesDropped: (files) => void handleFiles(files),
      onViewSettled: () => pipelineRef?.renderDetail(),
      onViewChange: (scale) => {
        zoomPercent = Math.round(scale * 100);
        updateStatus();
      },
    });
  } catch (err) {
    root.innerHTML = "";
    const p = document.createElement("p");
    p.className = "fatal";
    p.textContent = err instanceof Error ? err.message : "Photo Inker couldn't start in this browser.";
    root.append(p);
    return;
  }
  preview.element.append(notice);
  // The GPU driver can reset (e.g. after a very long draw); the WebGL context is then gone for good.
  preview.onContextLost(() => showNotice(GPU_RESET_MESSAGE, "error", { label: "Reload", onClick: () => location.reload() }));

  // ---- Palette + eyedropper ----
  const palette = new PaletteActions(settings, source);
  const eyedropper = new Eyedropper(
    preview,
    () => source.get()?.bitmap ?? null,
    (target, hex) => {
      if (target.kind === "ink") palette.setInkColor(target.slot, hex);
      else if (target.kind === "paper") palette.setPaper(hex);
      else target.onPick(hex);
    },
  );
  const paletteBlock = createPaletteBlock(settings, source, palette, eyedropper);

  // Ink mixing test view (a development tool): only with ?debug in the URL.
  if (DEBUG) {
    const inkTest = new InkTestView(settings, DEBUG);
    preview.element.append(inkTest.element);
    const inkTestButton = document.createElement("button");
    inkTestButton.type = "button";
    inkTestButton.className = "ink-test-open";
    inkTestButton.textContent = "Show ink mixing test";
    inkTestButton.addEventListener("click", () => {
      inkTest.toggle();
      inkTestButton.textContent = inkTest.open ? "Hide ink mixing test" : "Show ink mixing test";
    });
    new MutationObserver(() => {
      inkTestButton.textContent = inkTest.open ? "Hide ink mixing test" : "Show ink mixing test";
    }).observe(inkTest.element, { attributes: true, attributeFilter: ["hidden"] });
    paletteBlock.append(inkTestButton);
  }

  const showPaper = () => {
    const rgb = hexToRgb(settings.get().palette.paper) ?? { r: 255, g: 255, b: 255 };
    preview.setPaper([rgb.r, rgb.g, rgb.b].map((v) => srgbToLinearChannel(v / 255)) as [number, number, number]);
  };
  showPaper();

  // ---- Pipeline (processing runs on the preview canvas GPU context) ----
  const pipeline = new Pipeline({ settings, source, preview, background: PREVIEW_BACKGROUND, debug: DEBUG });
  pipelineRef = pipeline;
  pipeline.onBusy((message) => {
    busyMessage = message;
    updateStatus();
  });
  pipeline.onError((message) => showNotice(message));

  // ---- Panel ----
  const panel = new Panel(settings, {
    upload: uploadBlock.element,
    palette: paletteBlock,
    splitToneMap: createToneMapBlock(settings, pipeline),
    layers: createLayersBlock(settings),
    halftoneAm: createAmBlock(settings),
    halftoneHex: createHexBlock(settings),
    splitChannel: createChannelSplitBlock(settings),
    splitSelective: createSelectiveColorBlock(settings, source, eyedropper),
  }, {
    export: createExportBlock(settings, source, pipeline),
  });

  const main = document.createElement("main");
  main.className = "app-main";
  main.append(panel.element, preview.element);
  root.append(header, main, status);

  // ---- Wiring ----
  // Print mode: show the page (sheet, margin guide, marks) around the artwork.
  const showPage = () => {
    const image = source.get();
    const s = settings.get();
    if (!image || s.upload.mode !== "print" || s.export.pageSize === "image") {
      preview.setPage(null);
      return;
    }
    const layout = outputLayout(s, image.width, image.height);
    const paper = s.export.printTarget === "standard" ? "#ffffff" : s.palette.paper;
    preview.setPage({ layout, marks: markShapes(layout, s, layerLabels(s)), paper });
  };

  source.subscribe((image) => {
    if (!image) return;
    eyedropper.stop();
    preview.setImageSize(image.width, image.height);
    showPage();
    uploadBlock.showImage(image);
    updateStatus();
  });

  const showMode = () => {
    const mode = settings.get().upload.mode;
    modeBadge.textContent = mode === "digital" ? "Digital mode" : "Print mode";
    document.body.dataset.mode = mode;
  };
  showMode();

  settings.subscribe((_, change) => {
    showPage();
    if (change.section === "upload" && change.key === "mode") showMode();
    if (change.section === "palette" && change.key === "paper") showPaper();
    // A typed project name stops following the uploaded file's name.
    if (change.section === "upload" && change.key === "projectName") nameFollowsFile = false;
    if (DEBUG && change.commit) {
      const def = findSetting(change.section, change.key);
      console.debug(`[settings] ${change.section}.${change.key} → stage: ${change.stage ?? "none"}`, def?.kind);
    }
  });

  // ---- Keyboard shortcuts (ignored while typing in a field) ----
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "0") preview.fit();
    else if (e.key === "1") preview.zoomTo(1);
    else if (e.key === "+" || e.key === "=") preview.zoomBy(Math.SQRT2);
    else if (e.key === "-" || e.key === "_") preview.zoomBy(1 / Math.SQRT2);
    else if (e.key === "i" || e.key === "I") preview.setDisplayMode("inks");
    else if (e.key === "o" || e.key === "O") preview.setDisplayMode("original");
    else return;
    e.preventDefault();
  });

  // Dropping a file anywhere else must not navigate away from the app.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  updateStatus();
}

const app = document.querySelector<HTMLElement>("#app");
if (app) start(app);
