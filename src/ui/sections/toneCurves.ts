// Tone Map Advanced mode: one curve editor per ink (lightness → density), a
// preset menu per ink, and "Link curves": dragging a point on one ink's curve
// moves the nearest point on every other ink's curve by the same amount.

import type { SettingsStore } from "../../app/store";
import { MAX_INKS } from "../../pipeline/coverage";
import { findSetting } from "../../schema/registry";
import { CURVE_PRESETS } from "../../plugins/splitting/toneCurves";
import type { CurvePoint } from "../../util/curve";
import { createControl } from "../controls/controls";
import { createCurveEditor, type CurveEditor } from "../controls/curveEditor";

type Points = [number, number][];

const copy = (p: readonly CurvePoint[]): Points => p.map(([x, y]) => [x, y]);

/** Moves the point of `curve` that corresponds to a point moved from `from` by (dx, dy). */
function moveMatching(curve: Points, from: [number, number], dx: number, dy: number, endpoint: "first" | "last" | null): Points {
  const out = copy(curve);
  let i: number;
  if (endpoint === "first") i = 0;
  else if (endpoint === "last") i = out.length - 1;
  else {
    // Nearest interior point in x; skip if the curve only has its two end points.
    if (out.length <= 2) return out;
    i = 1;
    for (let k = 2; k < out.length - 1; k++) if (Math.abs(out[k]![0] - from[0]) < Math.abs(out[i]![0] - from[0])) i = k;
  }
  const [x, y] = out[i]!;
  const lo = i > 0 ? out[i - 1]![0] + 0.01 : 0;
  const hi = i < out.length - 1 ? out[i + 1]![0] - 0.01 : 1;
  out[i] = [endpoint ? x : Math.min(hi, Math.max(lo, x + dx)), Math.min(1, Math.max(0, y + dy))];
  return out;
}

export function createToneCurvesBlock(store: SettingsStore): HTMLElement {
  const element = document.createElement("div");
  element.className = "tone-curves";

  const linkControl = createControl(findSetting("splitToneMap", "linkCurves")!, store.get().splitToneMap.linkCurves, (v) =>
    store.setValue("splitToneMap", "linkCurves", v),
  );
  linkControl.element.classList.add("control-inline");
  const help = document.createElement("p");
  help.className = "control-help";
  help.textContent =
    "Each curve maps lightness (left = dark, right = light) to how much of that ink prints. Inks stack like a duotone or tritone.";
  const rows = document.createElement("div");
  rows.className = "tone-curve-rows";
  element.append(help, linkControl.element, rows);

  let signature = "";
  let editors: CurveEditor[] = [];
  let last: Points[] = [];

  const curves = () => store.get().splitToneMap.inkCurve.map(copy);

  function setCurves(next: Points[], commit: boolean): void {
    last = next.map(copy);
    store.setValue("splitToneMap", "inkCurve", next, { commit });
  }

  function onEdit(slot: number, points: Points, commit: boolean): void {
    const all = curves();
    const prev = last[slot] ?? all[slot] ?? [];
    all[slot] = points;
    const n = store.get().palette.inkCount;
    if (store.get().splitToneMap.linkCurves && prev.length === points.length) {
      // Find the point that moved and apply the same move to the other inks.
      let k = -1;
      let biggest = 1e-6;
      points.forEach(([x, y], i) => {
        const d = Math.abs(x - prev[i]![0]) + Math.abs(y - prev[i]![1]);
        if (d > biggest) {
          biggest = d;
          k = i;
        }
      });
      if (k >= 0) {
        const dx = points[k]![0] - prev[k]![0];
        const dy = points[k]![1] - prev[k]![1];
        const endpoint = k === 0 ? "first" : k === points.length - 1 ? "last" : null;
        for (let j = 0; j < n; j++) {
          if (j === slot) continue;
          all[j] = moveMatching(all[j]!, prev[k]!, dx, dy, endpoint);
          editors[j]?.update(all[j]!);
        }
      }
    }
    setCurves(all, commit);
  }

  function build(): void {
    const { palette } = store.get();
    rows.innerHTML = "";
    editors = [];
    last = curves();
    for (let slot = 0; slot < palette.inkCount; slot++) {
      const row = document.createElement("div");
      row.className = "tone-curve-row";
      const head = document.createElement("div");
      head.className = "tone-curve-head";
      const name = document.createElement("span");
      name.className = "layer-name";
      const dot = document.createElement("span");
      dot.className = "ink-dot";
      dot.style.setProperty("--swatch", palette.inkColor[slot] ?? "#000");
      name.append(dot, `${slot + 1} · ${(palette.inkColor[slot] ?? "").toUpperCase()}`);
      const preset = document.createElement("select");
      preset.setAttribute("aria-label", `Preset for ink ${slot + 1}`);
      preset.innerHTML = `<option value="">Preset…</option>` + CURVE_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("");
      preset.addEventListener("change", () => {
        const chosen = CURVE_PRESETS.find((p) => p.id === preset.value);
        preset.value = "";
        if (!chosen) return;
        const all = curves();
        all[slot] = copy(chosen.points);
        editors[slot]?.update(all[slot]!);
        setCurves(all, true);
      });
      head.append(name, preset);
      const editor = createCurveEditor(`Ink ${slot + 1} curve`, last[slot] ?? [], (points, commit) => onEdit(slot, points, commit));
      row.append(head, editor.element);
      rows.append(row);
      editors.push(editor);
    }
  }

  function refresh(): void {
    const { palette, splitToneMap } = store.get();
    linkControl.update(splitToneMap.linkCurves);
    const next = `${palette.inkCount}|${palette.inkColor.slice(0, MAX_INKS).join()}`;
    if (next !== signature) {
      signature = next;
      build();
      return;
    }
    const all = curves();
    editors.forEach((e, i) => e.update(all[i] ?? []));
    last = all;
  }

  refresh();
  store.subscribe((_, change) => {
    if (change.section === "splitToneMap" || change.section === "palette" || change.section === "*") refresh();
  });
  return element;
}
