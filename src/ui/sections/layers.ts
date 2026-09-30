// Layers (shared options for every splitting method): one row per ink, in
// print order, with density, invert, knockout, solo/mute (preview only), ▲/▼
// to change print order, and a collapsible area for levels, curve, and
// choke/spread (trapping).

import type { PaletteActions } from "../../app/palette";
import type { SettingsStore } from "../../app/store";
import { findSetting } from "../../schema/registry";
import type { SettingDef } from "../../schema/types";
import { createControl, type Control } from "../controls/controls";

/** Per-layer settings shown in each layer's collapsible area. */
const MORE_KEYS = ["levelsBlack", "levelsWhite", "levelsMid", "curve", "trap"] as const;
const MORE_LABELS: Record<(typeof MORE_KEYS)[number], string> = {
  levelsBlack: "Levels: ink starts at",
  levelsWhite: "Levels: full ink at",
  levelsMid: "Levels: midtone",
  curve: "Curve",
  trap: "Choke (−) / spread (+)",
};

interface Row {
  element: HTMLElement;
  density: HTMLInputElement;
  densityNumber: HTMLInputElement;
  invert: HTMLButtonElement;
  knockout: HTMLButtonElement;
  solo: HTMLButtonElement;
  mute: HTMLButtonElement;
  more: { key: (typeof MORE_KEYS)[number]; control: Control }[];
}

function toggleButton(text: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "layer-toggle";
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.setAttribute("aria-pressed", "false");
  return b;
}

export function createLayersBlock(store: SettingsStore, actions: PaletteActions): HTMLElement {
  const element = document.createElement("div");
  element.className = "layers-block";
  const note = document.createElement("p");
  note.className = "control-help";
  note.textContent = "Top prints first. Solo and mute only affect the preview.";
  const list = document.createElement("ol");
  list.className = "layer-list";
  element.append(note, list);

  let signature = "";
  let rows: Row[] = [];
  const openMore = new Set<number>();

  function build(): void {
    const p = store.get().palette;
    list.innerHTML = "";
    rows = [];
    for (let slot = 0; slot < p.inkCount; slot++) {
      const li = document.createElement("li");
      li.className = "layer-row";

      const head = document.createElement("div");
      head.className = "layer-head";
      const order = document.createElement("span");
      order.className = "ink-order";
      order.textContent = String(slot + 1);
      const name = document.createElement("span");
      name.className = "layer-name";
      const dot = document.createElement("span");
      dot.className = "ink-dot";
      dot.style.setProperty("--swatch", p.inkColor[slot] ?? "#000");
      name.append(dot, (p.inkColor[slot] ?? "").toUpperCase());

      const invert = toggleButton("Invert", `Invert layer ${slot + 1}`);
      invert.addEventListener("click", () =>
        store.setInkValue("layers", "invert", slot, !store.get().layers.invert[slot]),
      );
      const solo = toggleButton("S", `Solo layer ${slot + 1} (preview only)`);
      solo.addEventListener("click", () => store.setInkValue("layers", "solo", slot, !store.get().layers.solo[slot]));
      const mute = toggleButton("M", `Mute layer ${slot + 1} (preview only)`);
      const knockout = toggleButton("KO", `Knockout: layer ${slot + 1} clears the layers printed before it where it has ink`);
      knockout.addEventListener("click", () =>
        store.setInkValue("layers", "knockout", slot, !store.get().layers.knockout[slot]),
      );
      mute.addEventListener("click", () => store.setInkValue("layers", "mute", slot, !store.get().layers.mute[slot]));

      const move = document.createElement("span");
      move.className = "ink-move";
      const up = document.createElement("button");
      up.type = "button";
      up.className = "icon-button";
      up.textContent = "▲";
      up.title = `Print layer ${slot + 1} earlier`;
      up.setAttribute("aria-label", up.title);
      up.disabled = slot === 0;
      up.addEventListener("click", () => actions.moveInk(slot, -1));
      const down = document.createElement("button");
      down.type = "button";
      down.className = "icon-button";
      down.textContent = "▼";
      down.title = `Print layer ${slot + 1} later`;
      down.setAttribute("aria-label", down.title);
      down.disabled = slot === p.inkCount - 1;
      down.addEventListener("click", () => actions.moveInk(slot, 1));
      move.append(up, down);

      head.append(order, name, invert, knockout, solo, mute, move);

      const densityRow = document.createElement("label");
      densityRow.className = "layer-density";
      const densityLabel = document.createElement("span");
      densityLabel.textContent = "Density";
      const density = document.createElement("input");
      density.type = "range";
      density.min = "0";
      density.max = "200";
      density.step = "1";
      density.setAttribute("aria-label", `Layer ${slot + 1} density`);
      const densityNumber = document.createElement("input");
      densityNumber.type = "number";
      densityNumber.className = "control-number";
      densityNumber.min = "0";
      densityNumber.max = "200";
      densityNumber.setAttribute("aria-label", `Layer ${slot + 1} density value`);
      density.addEventListener("input", () => {
        densityNumber.value = density.value;
        store.setInkValue("layers", "density", slot, Number(density.value), { commit: false });
      });
      density.addEventListener("change", () => store.setInkValue("layers", "density", slot, Number(density.value)));
      densityNumber.addEventListener("change", () => store.setInkValue("layers", "density", slot, Number(densityNumber.value)));
      const pct = document.createElement("span");
      pct.className = "control-unit";
      pct.textContent = "%";
      densityRow.append(densityLabel, density, densityNumber, pct);

      // Levels, curve, and trapping, in a collapsible area.
      const details = document.createElement("details");
      details.className = "layer-more";
      details.open = openMore.has(slot);
      details.addEventListener("toggle", () => (details.open ? openMore.add(slot) : openMore.delete(slot)));
      const summary = document.createElement("summary");
      summary.textContent = "Levels, curve, trapping";
      details.append(summary);
      const more: Row["more"] = [];
      const values = store.get().layers as unknown as Record<string, unknown[]>;
      for (const key of MORE_KEYS) {
        const def = findSetting("layers", key)!;
        const scalar = { ...def, perInk: false, hidden: false, help: undefined } as SettingDef;
        const control = createControl(scalar, values[key]?.[slot], (v, commit) => store.setInkValue("layers", key, slot, v, { commit }), MORE_LABELS[key]);
        details.append(control.element);
        more.push({ key, control });
      }
      const trapHelp = document.createElement("p");
      trapHelp.className = "control-help";
      trapHelp.textContent = "In output pixels. Spread a lower layer (or choke a knockout layer) so small registration shifts don't leave paper gaps.";
      details.append(trapHelp);

      li.append(head, densityRow, details);
      list.append(li);
      rows.push({ element: li, density, densityNumber, invert, knockout, solo, mute, more });
    }
  }

  function refresh(): void {
    const { palette, layers } = store.get();
    const next = `${palette.inkCount}|${palette.inkColor.slice(0, palette.inkCount).join()}`;
    if (next !== signature) {
      signature = next;
      build();
    }
    const anySolo = layers.solo.slice(0, palette.inkCount).some(Boolean);
    rows.forEach((row, slot) => {
      const d = String(layers.density[slot] ?? 100);
      if (document.activeElement !== row.density) row.density.value = d;
      if (document.activeElement !== row.densityNumber) row.densityNumber.value = d;
      const set = (b: HTMLButtonElement, on: boolean) => {
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      };
      set(row.invert, Boolean(layers.invert[slot]));
      set(row.solo, Boolean(layers.solo[slot]));
      set(row.mute, Boolean(layers.mute[slot]));
      set(row.knockout, Boolean(layers.knockout[slot]));
      const values = layers as unknown as Record<string, unknown[]>;
      for (const { key, control } of row.more) control.update(values[key]?.[slot]);
      const hidden = anySolo ? !layers.solo[slot] : Boolean(layers.mute[slot]);
      row.element.classList.toggle("layer-hidden", hidden);
    });
  }

  refresh();
  store.subscribe(refresh);
  return element;
}
