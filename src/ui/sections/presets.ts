// Presets section: save the current look (in this browser and/or as a .json
// file), apply or delete saved ones, and load a preset file. Applying a
// preset is one undo step.

import { applyPreset, deletePreset, makePreset, parsePreset, PresetError, presetBlob, savedPresets, savePreset, type PresetFile } from "../../app/presets";
import type { SettingsStore } from "../../app/store";
import { downloadBlob, fileBaseName } from "../../export/exporter";

function button(text: string, title?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (title) b.title = title;
  return b;
}

function labelled(text: string, ...children: HTMLElement[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "control";
  const label = document.createElement("span");
  label.className = "control-label";
  label.textContent = text;
  const body = document.createElement("div");
  body.className = "control-body";
  body.append(...children);
  el.append(label, body);
  return el;
}

export function createPresetsBlock(store: SettingsStore): HTMLElement {
  const element = document.createElement("div");
  element.className = "presets-block";

  const help = document.createElement("p");
  help.className = "control-help";
  help.textContent = "A preset keeps the look: palette, adjustments, color splitting, halftone, border and print simulation. Mode, export and page settings stay as they are.";

  // ---- Save ----
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.maxLength = 60;
  nameInput.placeholder = "Preset name";
  nameInput.setAttribute("aria-label", "Preset name");
  const saveButton = button("Save", "Save the current look in this browser");
  const downloadButton = button("Download", "Download the current look as a .json file");
  const saveRow = labelled("Save the current look", nameInput);
  const saveButtons = document.createElement("div");
  saveButtons.className = "button-row";
  saveButtons.append(saveButton, downloadButton);

  // ---- Saved in this browser ----
  const list = document.createElement("select");
  list.setAttribute("aria-label", "Saved presets");
  const applyButton = button("Apply");
  const deleteButton = button("Delete");
  const savedRow = labelled("Saved in this browser", list);
  const savedButtons = document.createElement("div");
  savedButtons.className = "button-row";
  savedButtons.append(applyButton, deleteButton);
  const emptyNote = document.createElement("p");
  emptyNote.className = "control-help";

  // ---- Upload ----
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.hidden = true;
  const uploadButton = button("Upload preset file…", "Apply a preset .json file (it is also saved in this browser)");
  uploadButton.className = "presets-upload";

  const message = document.createElement("p");
  message.className = "control-help presets-message";
  message.setAttribute("aria-live", "polite");

  element.append(help, saveRow, saveButtons, savedRow, savedButtons, emptyNote, uploadButton, fileInput, message);

  let saved: PresetFile[] | null = [];
  const say = (text: string, error = false) => {
    message.textContent = text;
    message.classList.toggle("presets-error", error);
  };

  function refreshList(select?: string): void {
    saved = savedPresets();
    const current = select ?? list.value;
    list.replaceChildren(
      ...(saved ?? []).map((p) => {
        const o = document.createElement("option");
        o.value = p.name;
        o.textContent = p.name;
        return o;
      }),
    );
    if (saved?.some((p) => p.name === current)) list.value = current;
    const none = !saved || saved.length === 0;
    savedRow.hidden = none;
    savedButtons.hidden = none;
    saveButton.hidden = saved === null;
    emptyNote.hidden = !none;
    emptyNote.textContent = saved === null ? "This browser isn't letting the app save presets (private window or blocked site data). Use Download and Upload instead." : "No presets saved yet.";
  }

  const apply = (preset: PresetFile) => {
    store.replace(applyPreset(store.get(), preset));
    say(`Applied “${preset.name}”. Undo goes back to how it was.`);
  };
  const currentName = () => nameInput.value.trim() || store.get().upload.projectName || "Preset";

  saveButton.addEventListener("click", () => {
    const preset = makePreset(currentName(), store.get());
    const replaced = saved?.some((p) => p.name.toLowerCase() === preset.name.toLowerCase());
    if (!savePreset(preset)) return say("Couldn't save in this browser. Use Download instead.", true);
    refreshList(preset.name);
    say(replaced ? `Updated “${preset.name}”.` : `Saved “${preset.name}”.`);
  });
  downloadButton.addEventListener("click", () => {
    const preset = makePreset(currentName(), store.get());
    downloadBlob(presetBlob(preset), `${fileBaseName(preset.name)}.photo-inker.json`);
    say(`Downloaded “${preset.name}”.`);
  });
  applyButton.addEventListener("click", () => {
    const preset = saved?.find((p) => p.name === list.value);
    if (preset) apply(preset);
  });
  deleteButton.addEventListener("click", () => {
    const name = list.value;
    if (!name || !confirm(`Delete the preset “${name}” from this browser?`)) return;
    deletePreset(name);
    refreshList();
    say(`Deleted “${name}”.`);
  });
  uploadButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ""; // allow the same file again
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new PresetError("That file is too big to be a Photo Inker preset.");
      const preset = parsePreset(await file.text());
      apply(preset);
      if (savePreset(preset)) refreshList(preset.name);
    } catch (err) {
      say(err instanceof PresetError ? err.message : "Couldn't read that file.", true);
      if (!(err instanceof PresetError)) console.error(err);
    }
  });

  refreshList();
  return element;
}
