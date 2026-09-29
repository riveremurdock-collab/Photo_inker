// Selective Color custom block: one card per color range (hue, width,
// saturation and lightness limits, feather, ink), with an eyedropper to set a
// range from the image, a mask preview toggle, and add/remove.

import type { SourceStore } from "../../app/source";
import type { SettingsStore } from "../../app/store";
import { MAX_RANGES, RANGE_FIELDS } from "../../plugins/splitting/selectiveColor";
import { findSetting } from "../../schema/registry";
import { hexToRgb } from "../../util/color";
import { createControl, type Control } from "../controls/controls";
import { sameTarget, type Eyedropper, type PickTarget } from "../preview/eyedropper";

const EYEDROPPER_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M20.7 5.6 18.4 3.3a1 1 0 0 0-1.4 0l-3.1 3.1-1.3-1.3-1.4 1.4 1.3 1.3-7.8 7.8-.7 3.5-.9.9 1.4 1.4.9-.9 3.5-.7 7.8-7.8 1.3 1.3 1.4-1.4-1.3-1.3 3.1-3.1a1 1 0 0 0 0-1.4ZM8 18.3l-1.9.4.4-1.9 7.7-7.7 1.5 1.5L8 18.3Z"/></svg>`;

/** Hue, saturation, lightness (0..360, 0..1, 0..1) of a hex color. */
function hsl(hex: string): [number, number, number] {
  const c = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  const s = d < 1e-5 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d > 1e-5) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [h * 60, Math.min(1, s), l];
}

export function createSelectiveColorBlock(store: SettingsStore, source: SourceStore, eyedropper: Eyedropper): HTMLElement {
  const element = document.createElement("div");
  element.className = "selective-block";
  const cards = document.createElement("div");
  cards.className = "selective-cards";
  const buttons = document.createElement("div");
  buttons.className = "button-row";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.textContent = "+ Add range";
  const pickButton = document.createElement("button");
  pickButton.type = "button";
  pickButton.innerHTML = `${EYEDROPPER_ICON} Add range from image`;
  pickButton.className = "icon-text-button";
  buttons.append(addButton, pickButton);
  element.append(cards, buttons);

  const get = (key: string) => store.getValue("splitSelective", key);
  const set = (key: string, value: unknown, commit = true) => store.setValue("splitSelective", key, value, { commit });
  const count = () => Number(get("rangeCount"));

  /** Sets range r from a picked color: its hue, and limits around its saturation and lightness. */
  function fromColor(r: number, hex: string): void {
    const [h, s, l] = hsl(hex);
    set(`r${r}Hue`, Math.round(h));
    set(`r${r}Width`, 40);
    set(`r${r}SatMin`, Math.max(0, Math.round(s * 100 - 35)));
    set(`r${r}SatMax`, 100);
    set(`r${r}LightMin`, Math.max(0, Math.round(l * 100 - 35)));
    set(`r${r}LightMax`, Math.min(100, Math.round(l * 100 + 35)));
  }

  addButton.addEventListener("click", () => {
    if (count() < MAX_RANGES) set("rangeCount", count() + 1);
  });
  const pickNewTarget: PickTarget = {
    kind: "custom",
    id: "selective-new",
    onPick: (hex) => {
      if (count() >= MAX_RANGES) return;
      const r = count();
      fromColor(r, hex);
      set("rangeCount", r + 1);
    },
  };
  pickButton.addEventListener("click", () => eyedropper.toggle(pickNewTarget));

  function removeRange(r: number): void {
    const n = count();
    // Shift later ranges down one place.
    for (let k = r; k < n - 1; k++) {
      for (const f of RANGE_FIELDS) set(`r${k}${f}`, get(`r${k + 1}${f}`));
    }
    set("rangeCount", n - 1);
    set("maskPreview", "none");
  }

  let signature = "";
  let controls: { key: string; control: Control }[] = [];
  let swatches: HTMLElement[] = [];
  let maskButtons: HTMLButtonElement[] = [];
  let pickButtons: HTMLButtonElement[] = [];

  function build(): void {
    const palette = store.get().palette;
    cards.innerHTML = "";
    controls = [];
    swatches = [];
    maskButtons = [];
    pickButtons = [];
    for (let r = 0; r < count(); r++) {
      const card = document.createElement("div");
      card.className = "channel-card";
      const head = document.createElement("div");
      head.className = "tone-curve-head";
      const title = document.createElement("h4");
      const sw = document.createElement("span");
      sw.className = "ink-dot";
      title.append(sw, `Range ${r + 1}`);
      swatches.push(sw);
      const tools = document.createElement("span");
      tools.className = "button-row";
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "icon-button eyedropper";
      pick.innerHTML = EYEDROPPER_ICON;
      pick.title = `Set range ${r + 1} from a color in the image`;
      pick.setAttribute("aria-label", pick.title);
      const target: PickTarget = { kind: "custom", id: `selective-${r}`, onPick: (hex) => fromColor(r, hex) };
      pick.addEventListener("click", () => eyedropper.toggle(target));
      pickButtons.push(pick);
      const mask = document.createElement("button");
      mask.type = "button";
      mask.className = "layer-toggle";
      mask.textContent = "Mask";
      mask.title = `Show what range ${r + 1} selects (preview only)`;
      mask.addEventListener("click", () => set("maskPreview", get("maskPreview") === String(r) ? "none" : String(r)));
      maskButtons.push(mask);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-button remove";
      remove.textContent = "×";
      remove.title = `Remove range ${r + 1}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => removeRange(r));
      tools.append(pick, mask, remove);
      head.append(title, tools);
      card.append(head);

      for (const f of RANGE_FIELDS) {
        const key = `r${r}${f}`;
        if (f === "Ink") {
          const row = document.createElement("label");
          row.className = "control";
          row.innerHTML = `<span class="control-label">Ink</span>`;
          const select = document.createElement("select");
          select.innerHTML = Array.from({ length: palette.inkCount }, (_, i) => `<option value="${i}">Ink ${i + 1} · ${(palette.inkColor[i] ?? "").toUpperCase()}</option>`).join("");
          select.value = String(get(key));
          select.addEventListener("change", () => set(key, select.value));
          row.append(select);
          card.append(row);
          controls.push({ key, control: { element: row, update: (v) => (select.value = String(v)) } });
          continue;
        }
        const def = findSetting("splitSelective", key)!;
        const control = createControl(def, get(key), (v, commit) => set(key, v, commit));
        if (f === "Hue") control.element.classList.add("hue-control");
        card.append(control.element);
        controls.push({ key, control });
      }
      cards.append(card);
    }
    addButton.disabled = count() >= MAX_RANGES;
    pickButton.disabled = count() >= MAX_RANGES || !source.get();
  }

  function refresh(): void {
    const palette = store.get().palette;
    const next = `${count()}|${palette.inkCount}|${palette.inkColor.join()}`;
    if (next !== signature) {
      signature = next;
      build();
    }
    for (const { key, control } of controls) control.update(get(key));
    for (let r = 0; r < swatches.length; r++) {
      swatches[r]!.style.setProperty("--swatch", `hsl(${Number(get(`r${r}Hue`))} 80% 50%)`);
      const on = get("maskPreview") === String(r);
      maskButtons[r]!.classList.toggle("active", on);
      maskButtons[r]!.setAttribute("aria-pressed", String(on));
      pickButtons[r]!.disabled = !source.get();
      pickButtons[r]!.classList.toggle("active", sameTarget(eyedropper.active, { kind: "custom", id: `selective-${r}`, onPick: () => {} }));
    }
    pickButton.disabled = count() >= MAX_RANGES || !source.get();
    pickButton.classList.toggle("active", sameTarget(eyedropper.active, pickNewTarget));
  }

  refresh();
  store.subscribe((_, change) => {
    if (change.section === "splitSelective" || change.section === "palette" || change.section === "*") refresh();
  });
  source.subscribe(refresh);
  eyedropper.subscribe(refresh);
  return element;
}
