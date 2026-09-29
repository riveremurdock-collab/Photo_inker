// Side panel: one collapsible section per schema section, in workflow order.
// Controls are generated from the schema; sections that need more than
// generated controls (upload drop zone, palette list, histogram…) get a
// custom block placed above their generated controls.

import type { SettingsStore } from "../app/store";
import { isSettingVisible } from "../schema/registry";
import { SECTIONS, type ProjectSettings, type SectionId } from "../schema/sections";
import type { SectionSchema, SettingDef } from "../schema/types";
import { createControl, type Control } from "./controls/controls";

/** Shown in sections that have no settings yet. */
const COMING_IN: Partial<Record<SectionId, string>> = {
  adjust: "Image adjustments arrive in Step 4.",
  split: "Color splitting arrives in Step 4.",
  halftone: "Halftone options arrive in Step 5.",
  border: "Border options arrive in Step 11.",
  printSim: "Print simulation arrives in Step 12.",
};

interface BoundControl {
  sectionId: string;
  def: SettingDef;
  element: HTMLElement;
  update(settings: ProjectSettings): void;
}

export class Panel {
  readonly element: HTMLElement;
  private controls: BoundControl[] = [];

  constructor(
    private store: SettingsStore,
    customBlocks: Partial<Record<SectionId, HTMLElement>> = {},
  ) {
    this.element = document.createElement("aside");
    this.element.className = "panel";
    this.element.setAttribute("aria-label", "Settings");

    for (const section of SECTIONS as readonly SectionSchema[]) {
      const details = document.createElement("details");
      details.className = "panel-section";
      details.dataset.section = section.id;
      details.open = section.id === "upload" || section.id === "palette";

      const summary = document.createElement("summary");
      summary.textContent = section.title;
      details.append(summary);

      const body = document.createElement("div");
      body.className = "panel-section-body";
      details.append(body);

      const custom = customBlocks[section.id as SectionId];
      if (custom) body.append(custom);

      for (const def of section.settings) {
        if (def.hidden) continue;
        const bound = def.perInk ? this.perInkControl(section.id, def) : this.scalarControl(section.id, def);
        body.append(bound.element);
        this.controls.push(bound);
      }

      const note = COMING_IN[section.id as SectionId];
      if (note && section.settings.length === 0 && !custom) {
        const p = document.createElement("p");
        p.className = "panel-placeholder";
        p.textContent = note;
        body.append(p);
      }

      this.element.append(details);
    }

    this.refresh();
    store.subscribe(() => this.refresh());
  }

  private scalarControl(sectionId: string, def: SettingDef): BoundControl {
    const control = createControl(def, this.store.getValue(sectionId, def.key), (value, commit) =>
      this.store.setValue(sectionId, def.key, value, { commit }),
    );
    return {
      sectionId,
      def,
      element: control.element,
      update: () => control.update(this.store.getValue(sectionId, def.key)),
    };
  }

  /** A labelled group with one control per active ink, rebuilt when the inks change. */
  private perInkControl(sectionId: string, def: SettingDef): BoundControl {
    const element = document.createElement("div");
    element.className = "control-group";
    const label = document.createElement("span");
    label.className = "control-label";
    label.textContent = def.label;
    const rows = document.createElement("div");
    rows.className = "control-group-rows";
    element.append(label, rows);

    let signature = "";
    let controls: Control[] = [];
    const store = this.store;

    return {
      sectionId,
      def,
      element,
      update(settings) {
        const { inkCount, inkColor } = settings.palette;
        const nextSignature = `${inkCount}|${inkColor.join("|")}`;
        const values = store.getValue(sectionId, def.key) as unknown[];
        if (nextSignature !== signature) {
          signature = nextSignature;
          rows.innerHTML = "";
          controls = [];
          for (let slot = 0; slot < inkCount; slot++) {
            const control = createControl(
              { ...def, help: undefined },
              values[slot],
              (value, commit) => store.setInkValue(sectionId, def.key, slot, value, { commit }),
              (inkColor[slot] ?? "").toUpperCase(),
            );
            const labelEl = control.element.querySelector(".control-label");
            const dot = document.createElement("span");
            dot.className = "ink-dot";
            dot.style.setProperty("--swatch", inkColor[slot] ?? "#000");
            labelEl?.prepend(dot);
            rows.append(control.element);
            controls.push(control);
          }
        } else {
          controls.forEach((c, slot) => c.update(values[slot]));
        }
      },
    };
  }

  /** Syncs every control's value and visibility (mode, visibleWhen) with the store. */
  private refresh(): void {
    const settings = this.store.get();
    for (const bound of this.controls) {
      bound.update(settings);
      bound.element.hidden = !isSettingVisible(bound.def, settings, bound.sectionId);
    }
  }
}
