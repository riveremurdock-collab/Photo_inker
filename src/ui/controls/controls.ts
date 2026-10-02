// One builder per SettingDef kind. Each control edits a single (non-per-ink)
// value; per-ink settings get one control per ink slot, built by the panel.
//
// Slider pattern from the stipple tool: 'input' events preview (commit=false),
// 'change' events commit (commit=true).

import { createCurveEditor } from "./curveEditor";
import type {
  ColorSetting,
  CurvePoints,
  NumberSetting,
  SeedSetting,
  SelectSetting,
  SettingDef,
  TextSetting,
  ToggleSetting,
} from "../../schema/types";

export type ChangeHandler = (value: unknown, commit: boolean) => void;

export interface Control {
  /** The full row: label, input(s), and help text. */
  element: HTMLElement;
  /** Sets the shown value without firing change events. */
  update(value: unknown): void;
  /** Dropdowns only: replaces the options (e.g. when the palette's inks change). */
  setOptions?(options: readonly { value: string; label: string; group?: string }[]): void;
}

let idCounter = 0;
function nextId(): string {
  return `ctl-${++idCounter}`;
}

function row(def: SettingDef, labelFor: string | null, labelText = def.label): { row: HTMLElement; body: HTMLElement } {
  const el = document.createElement("div");
  el.className = `control control-${def.kind}`;
  const label = document.createElement(labelFor ? "label" : "span");
  label.className = "control-label";
  label.textContent = labelText;
  if (labelFor) (label as HTMLLabelElement).htmlFor = labelFor;
  const body = document.createElement("div");
  body.className = "control-body";
  el.append(label, body);
  if (def.help) {
    const help = document.createElement("p");
    help.className = "control-help";
    help.textContent = def.help;
    el.append(help);
  }
  return { row: el, body };
}

function decimals(step: number): number {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

function numberControl(def: NumberSetting, value: number, onChange: ChangeHandler, label?: string): Control {
  const id = nextId();
  const { row: el, body } = row(def, id, label);

  const range = document.createElement("input");
  range.type = "range";
  range.id = id;
  range.min = String(def.min);
  range.max = String(def.max);
  range.step = String(def.step);

  const num = document.createElement("input");
  num.type = "number";
  num.className = "control-number";
  num.min = range.min;
  num.max = range.max;
  num.step = range.step;
  num.setAttribute("aria-label", `${def.label} value`);

  const fmt = (v: number) => v.toFixed(decimals(def.step));
  const show = (v: number) => {
    range.value = String(v);
    num.value = fmt(v);
  };
  show(value);

  range.addEventListener("input", () => {
    num.value = fmt(Number(range.value));
    onChange(Number(range.value), false);
  });
  range.addEventListener("change", () => onChange(Number(range.value), true));
  num.addEventListener("change", () => {
    const v = Number(num.value);
    if (Number.isFinite(v)) onChange(v, true);
  });

  body.append(range, num);
  if (def.unit) {
    const unit = document.createElement("span");
    unit.className = "control-unit";
    unit.textContent = def.unit;
    body.append(unit);
  }
  return { element: el, update: (v) => show(Number(v)) };
}

function selectControl(def: SelectSetting, value: string, onChange: ChangeHandler, label?: string): Control {
  if (def.display === "segmented") {
    const { row: el, body } = row(def, null, label);
    const group = document.createElement("div");
    group.className = "segmented";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label ?? def.label);
    const buttons = def.options.map((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt.label;
      b.setAttribute("role", "radio");
      b.dataset.value = opt.value;
      b.addEventListener("click", () => onChange(opt.value, true));
      group.append(b);
      return b;
    });
    const show = (v: unknown) => {
      for (const b of buttons) {
        const on = b.dataset.value === v;
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", String(on));
      }
    };
    show(value);
    body.append(group);
    return { element: el, update: show };
  }

  const id = nextId();
  const { row: el, body } = row(def, id, label);
  const select = document.createElement("select");
  select.id = id;
  const setOptions = (options: readonly { value: string; label: string; group?: string }[]) => {
    const current = select.value;
    // Consecutive options with the same group go under one heading.
    const items: HTMLElement[] = [];
    let group: HTMLOptGroupElement | null = null;
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (!opt.group) {
        group = null;
        items.push(o);
        continue;
      }
      if (group?.label !== opt.group) {
        group = document.createElement("optgroup");
        group.label = opt.group;
        items.push(group);
      }
      group.append(o);
    }
    select.replaceChildren(...items);
    select.value = current;
  };
  setOptions(def.options);
  select.value = value;
  select.addEventListener("change", () => onChange(select.value, true));
  body.append(select);
  return { element: el, update: (v) => (select.value = String(v)), setOptions };
}

function toggleControl(def: ToggleSetting, value: boolean, onChange: ChangeHandler, label?: string): Control {
  const id = nextId();
  const { row: el, body } = row(def, id, label);
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = id;
  box.checked = value;
  box.addEventListener("change", () => onChange(box.checked, true));
  body.append(box);
  return { element: el, update: (v) => (box.checked = Boolean(v)) };
}

function colorControl(def: ColorSetting, value: string, onChange: ChangeHandler, label?: string): Control {
  const id = nextId();
  const { row: el, body } = row(def, id, label);
  const picker = document.createElement("input");
  picker.type = "color";
  picker.id = id;
  const hex = document.createElement("input");
  hex.type = "text";
  hex.className = "control-hex";
  hex.maxLength = 7;
  hex.spellcheck = false;
  hex.setAttribute("aria-label", `${def.label} hex code`);
  const show = (v: unknown) => {
    picker.value = String(v);
    hex.value = String(v);
  };
  show(value);
  picker.addEventListener("input", () => {
    hex.value = picker.value;
    onChange(picker.value, false);
  });
  picker.addEventListener("change", () => onChange(picker.value, true));
  hex.addEventListener("change", () => {
    const v = hex.value.trim().startsWith("#") ? hex.value.trim() : `#${hex.value.trim()}`;
    if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v.toLowerCase(), true);
    else hex.value = picker.value;
  });
  body.append(picker, hex);
  return { element: el, update: show };
}

function textControl(def: TextSetting, value: string, onChange: ChangeHandler, label?: string): Control {
  const id = nextId();
  const { row: el, body } = row(def, id, label);
  const input = document.createElement("input");
  input.type = "text";
  input.id = id;
  if (def.maxLength) input.maxLength = def.maxLength;
  input.value = value;
  input.addEventListener("input", () => onChange(input.value, false));
  input.addEventListener("change", () => onChange(input.value, true));
  body.append(input);
  return {
    element: el,
    update: (v) => {
      if (document.activeElement !== input) input.value = String(v);
    },
  };
}

function seedControl(def: SeedSetting, value: number, onChange: ChangeHandler, label?: string): Control {
  const id = nextId();
  const { row: el, body } = row(def, id, label);
  const num = document.createElement("input");
  num.type = "number";
  num.id = id;
  num.className = "control-number";
  num.min = "0";
  num.step = "1";
  num.value = String(value);
  num.addEventListener("change", () => onChange(Number(num.value), true));
  const reroll = document.createElement("button");
  reroll.type = "button";
  reroll.textContent = "Re-roll";
  reroll.addEventListener("click", () => onChange(Math.floor(Math.random() * 2 ** 31), true));
  body.append(num, reroll);
  return { element: el, update: (v) => (num.value = String(v)) };
}

/** Builds the control for one value. `label` overrides the definition's label (used for per-ink rows). */
export function createControl(def: SettingDef, value: unknown, onChange: ChangeHandler, label?: string): Control {
  switch (def.kind) {
    case "number":
      return numberControl(def, Number(value), onChange, label);
    case "select":
      return selectControl(def, String(value), onChange, label);
    case "toggle":
      return toggleControl(def, Boolean(value), onChange, label);
    case "color":
      return colorControl(def, String(value), onChange, label);
    case "text":
      return textControl(def, String(value), onChange, label);
    case "seed":
      return seedControl(def, Number(value), onChange, label);
    case "curve": {
      const { row: el, body } = row(def, null, label);
      const editor = createCurveEditor(label ?? def.label, value as CurvePoints, (points, commit) => onChange(points, commit));
      body.append(editor.element);
      return { element: el, update: (v) => editor.update(v as CurvePoints) };
    }
  }
}
