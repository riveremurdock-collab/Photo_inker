// Upload section's custom block: drop zone + file picker, and a summary of the
// loaded image. Mode and project name below it are generated from the schema.

import { ACCEPT_ATTRIBUTE } from "../../app/loadImage";
import type { SourceImage } from "../../app/source";

export interface UploadBlock {
  element: HTMLElement;
  showImage(image: SourceImage): void;
  setBusy(busy: boolean): void;
}

export function createUploadBlock(onFiles: (files: FileList) => void): UploadBlock {
  const element = document.createElement("div");
  element.className = "upload-block";

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ACCEPT_ATTRIBUTE;
  input.hidden = true;
  input.addEventListener("change", () => {
    if (input.files?.length) onFiles(input.files);
    input.value = ""; // allow picking the same file again
  });

  const zone = document.createElement("label");
  zone.className = "drop-zone";
  zone.tabIndex = 0;
  zone.innerHTML = `<span class="drop-zone-title">Choose an image</span><span class="drop-zone-hint">or drag one here · JPG, PNG, WebP</span>`;
  zone.addEventListener("click", (e) => {
    e.preventDefault();
    input.click();
  });
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("drag-over");
    if (e.dataTransfer?.files.length) onFiles(e.dataTransfer.files);
  });

  const info = document.createElement("p");
  info.className = "upload-info";
  info.hidden = true;

  element.append(zone, input, info);

  const title = zone.querySelector<HTMLElement>(".drop-zone-title")!;
  let idleTitle = "Choose an image";

  return {
    element,
    showImage(image) {
      idleTitle = "Replace image";
      title.textContent = idleTitle;
      info.hidden = false;
      info.textContent = `${image.fileName} · ${image.width} × ${image.height} px`;
    },
    setBusy(busy) {
      zone.classList.toggle("busy", busy);
      title.textContent = busy ? "Opening…" : idleTitle;
    },
  };
}
