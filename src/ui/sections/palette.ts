// Palette section: Manual/Auto switch, the ink list (top to bottom = print
// order), and the paper/background color. Each ink row has a swatch (opens the
// Riso ink presets), a name, a hex field, an eyedropper, reorder buttons, and
// a remove button.

import { PAPER_PRESETS, RISO_INKS } from "../../app/inkLibrary";
import type { PaletteActions } from "../../app/palette";
import type { SourceStore } from "../../app/source";
import type { SettingsStore } from "../../app/store";
import { MAX_INKS } from "../../pipeline/coverage";
import { findSetting } from "../../schema/registry";
import { createControl } from "../controls/controls";
import { normalizeHex, openSwatchPopover } from "../controls/swatchPopover";
import { sameTarget, type Eyedropper, type PickTarget } from "../preview/eyedropper";

const EYEDROPPER_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M20.7 5.6 18.4 3.3a1 1 0 0 0-1.4 0l-3.1 3.1-1.3-1.3-1.4 1.4 1.3 1.3-7.8 7.8-.7 3.5-.9.9 1.4 1.4.9-.9 3.5-.7 7.8-7.8 1.3 1.3 1.4-1.4-1.3-1.3 3.1-3.1a1 1 0 0 0 0-1.4ZM8 18.3l-1.9.4.4-1.9 7.7-7.7 1.5 1.5L8 18.3Z"/></svg>`;

interface InkRow {
  element: HTMLElement;
  order: HTMLElement;
  swatch: HTMLButtonElement;
  name: HTMLInputElement;
  hex: HTMLInputElement;
  eyedropper: HTMLButtonElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  remove: HTMLButtonElement;
}

function iconButton(label: string, html: string, className = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `icon-button ${className}`.trim();
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = html;
  return b;
}

function hexField(label: string, onCommit: (hex: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "control-hex";
  input.maxLength = 7;
  input.spellcheck = false;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => {
    const v = normalizeHex(input.value);
    if (v) onCommit(v);
    else input.value = input.dataset.value ?? "";
  });
  input.addEventListener("blur", () => (input.value = input.dataset.value ?? input.value));
  return input;
}

export function createPaletteBlock(
  store: SettingsStore,
  source: SourceStore,
  actions: PaletteActions,
  eyedropper: Eyedropper,
): HTMLElement {
  const element = document.createElement("div");
  element.className = "palette-block";

  // ---- Manual / Auto ----
  const sourceDef = findSetting("palette", "source")!;
  const sourceControl = createControl(sourceDef, store.get().palette.source, (v) =>
    store.setValue("palette", "source", v),
  );
  const includeBgDef = findSetting("palette", "autoIncludeBackground")!;
  const includeBgControl = createControl(includeBgDef, store.get().palette.autoIncludeBackground, (v) =>
    store.setValue("palette", "autoIncludeBackground", v),
  );
  includeBgControl.element.classList.add("control-inline");
  const autoNote = document.createElement("p");
  autoNote.className = "control-help";
  element.append(sourceControl.element, includeBgControl.element, autoNote);

  // ---- Inks ----
  const inksHeading = document.createElement("div");
  inksHeading.className = "palette-heading";
  inksHeading.innerHTML = `<span class="control-label">Inks</span><span class="control-help">Top prints first</span>`;
  const list = document.createElement("ol");
  list.className = "ink-list";
  element.append(inksHeading, list);

  const rows: InkRow[] = [];
  for (let slot = 0; slot < MAX_INKS; slot++) {
    const li = document.createElement("li");
    li.className = "ink-row";

    const order = document.createElement("span");
    order.className = "ink-order";
    order.textContent = String(slot + 1);

    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "swatch";
    swatch.setAttribute("aria-label", `Ink ${slot + 1} color: choose a Riso ink or custom color`);
    swatch.addEventListener("click", () =>
      openSwatchPopover({
        anchor: swatch,
        title: "Riso inks",
        presets: RISO_INKS,
        current: store.get().palette.inkColor[slot] ?? "#000000",
        onPick: (hex, commit) => actions.setInkColor(slot, hex, commit),
      }),
    );

    const name = document.createElement("input");
    name.type = "text";
    name.className = "ink-name";
    name.maxLength = 40;
    name.setAttribute("aria-label", `Ink ${slot + 1} name`);
    name.addEventListener("input", () => actions.setInkName(slot, name.value, false));
    name.addEventListener("change", () => actions.setInkName(slot, name.value, true));
    name.addEventListener("blur", () => (name.value = name.dataset.value ?? name.value));

    const hex = hexField(`Ink ${slot + 1} hex code`, (v) => actions.setInkColor(slot, v));
    const target: PickTarget = { kind: "ink", slot };
    const eye = iconButton(`Pick ink ${slot + 1} from the image`, EYEDROPPER_ICON, "eyedropper");
    eye.addEventListener("click", () => eyedropper.toggle(target));

    const move = document.createElement("span");
    move.className = "ink-move";
    const up = iconButton(`Print ink ${slot + 1} earlier`, "▲");
    const down = iconButton(`Print ink ${slot + 1} later`, "▼");
    up.addEventListener("click", () => actions.moveInk(slot, -1));
    down.addEventListener("click", () => actions.moveInk(slot, 1));
    move.append(up, down);

    const remove = iconButton(`Remove ink ${slot + 1}`, "×", "remove");
    remove.addEventListener("click", () => actions.removeInk(slot));

    li.append(order, swatch, name, hex, eye, move, remove);
    list.append(li);
    rows.push({ element: li, order, swatch, name, hex, eyedropper: eye, up, down, remove });
  }

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "add-ink";
  addButton.textContent = "+ Add ink";
  addButton.addEventListener("click", () => actions.addInk());
  element.append(addButton);

  // ---- Paper / background ----
  const paperRow = document.createElement("div");
  paperRow.className = "paper-row";
  const paperLabel = document.createElement("span");
  paperLabel.className = "control-label";
  const paperSwatch = document.createElement("button");
  paperSwatch.type = "button";
  paperSwatch.className = "swatch";
  paperSwatch.addEventListener("click", () =>
    openSwatchPopover({
      anchor: paperSwatch,
      title: paperLabel.textContent ?? "Paper",
      presets: PAPER_PRESETS,
      current: store.get().palette.paper,
      onPick: (hex, commit) => actions.setPaper(hex, commit),
    }),
  );
  const paperHex = hexField("Paper hex code", (v) => actions.setPaper(v));
  const paperTarget: PickTarget = { kind: "paper" };
  const paperEye = iconButton("Pick the paper color from the image", EYEDROPPER_ICON, "eyedropper");
  paperEye.addEventListener("click", () => eyedropper.toggle(paperTarget));
  paperRow.append(paperLabel, paperSwatch, paperHex, paperEye);
  element.append(paperRow);

  // ---- Sync with the store ----
  const setField = (input: HTMLInputElement, value: string) => {
    input.dataset.value = value;
    if (document.activeElement !== input) input.value = value;
  };

  function refresh(): void {
    const settings = store.get();
    const p = settings.palette;
    const hasImage = source.get() !== null;
    const isAuto = p.source === "auto";

    sourceControl.update(p.source);
    includeBgControl.update(p.autoIncludeBackground);
    includeBgControl.element.hidden = !isAuto;
    autoNote.hidden = !isAuto;
    autoNote.textContent = hasImage
      ? "Colors are picked from the image. Editing a color switches back to Manual."
      : "Upload an image to pick colors from it.";

    const active = eyedropper.active;
    rows.forEach((row, slot) => {
      const shown = slot < p.inkCount;
      row.element.hidden = !shown;
      if (!shown) return;
      const color = p.inkColor[slot] ?? "#000000";
      row.swatch.style.setProperty("--swatch", color);
      row.swatch.title = `${p.inkName[slot]} ${color}`;
      setField(row.name, p.inkName[slot] ?? "");
      setField(row.hex, color);
      row.eyedropper.disabled = !hasImage;
      row.eyedropper.classList.toggle("active", sameTarget(active, { kind: "ink", slot }));
      row.up.disabled = slot === 0;
      row.down.disabled = slot === p.inkCount - 1;
      row.remove.disabled = p.inkCount <= 1;
    });
    addButton.disabled = p.inkCount >= MAX_INKS;

    paperLabel.textContent = settings.upload.mode === "print" ? "Paper" : "Background";
    paperSwatch.style.setProperty("--swatch", p.paper);
    paperSwatch.setAttribute("aria-label", `${paperLabel.textContent} color: choose a preset or custom color`);
    setField(paperHex, p.paper);
    paperEye.disabled = !hasImage;
    paperEye.classList.toggle("active", sameTarget(active, paperTarget));
  }

  refresh();
  store.subscribe(refresh);
  source.subscribe(refresh);
  eyedropper.subscribe(refresh);
  return element;
}
