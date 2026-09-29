// Layers (shared options for every splitting method): one row per ink, in
// print order, with density, invert, solo/mute (preview only), and ▲/▼ to
// change print order.

import type { PaletteActions } from "../../app/palette";
import type { SettingsStore } from "../../app/store";

interface Row {
  element: HTMLElement;
  density: HTMLInputElement;
  densityNumber: HTMLInputElement;
  invert: HTMLButtonElement;
  solo: HTMLButtonElement;
  mute: HTMLButtonElement;
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

      head.append(order, name, invert, solo, mute, move);

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

      li.append(head, densityRow);
      list.append(li);
      rows.push({ element: li, density, densityNumber, invert, solo, mute });
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
      const hidden = anySolo ? !layers.solo[slot] : Boolean(layers.mute[slot]);
      row.element.classList.toggle("layer-hidden", hidden);
    });
  }

  refresh();
  store.subscribe(refresh);
  return element;
}
