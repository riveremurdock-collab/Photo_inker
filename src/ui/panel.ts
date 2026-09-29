// Side panel: one collapsible section per schema section, in workflow order.
// Controls are generated from the schema; sections that need more than
// generated controls (upload drop zone, palette list, histogram…) get a
// custom block placed above their generated controls.

import type { SettingsStore } from "../app/store";
import { isSettingVisible } from "../schema/registry";
import { SECTIONS, type SectionId } from "../schema/sections";
import type { SectionSchema, SettingDef } from "../schema/types";
import { createControl, type Control } from "./controls/controls";

/** Shown in sections that have no settings yet. */
const COMING_IN: Partial<Record<SectionId, string>> = {
  palette: "Palette options arrive in Step 2.",
  adjust: "Image adjustments arrive in Step 4.",
  split: "Color splitting arrives in Step 4.",
  halftone: "Halftone options arrive in Step 5.",
  border: "Border options arrive in Step 11.",
  printSim: "Print simulation arrives in Step 12.",
};

interface BoundControl {
  sectionId: string;
  def: SettingDef;
  control: Control;
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
      details.open = section.id === "upload";

      const summary = document.createElement("summary");
      summary.textContent = section.title;
      details.append(summary);

      const body = document.createElement("div");
      body.className = "panel-section-body";
      details.append(body);

      const custom = customBlocks[section.id as SectionId];
      if (custom) body.append(custom);

      for (const def of section.settings) {
        // Per-ink rows are added with the palette in Step 2.
        if (def.perInk) continue;
        const control = createControl(def, store.getValue(section.id, def.key), (value, commit) =>
          store.setValue(section.id, def.key, value, { commit }),
        );
        body.append(control.element);
        this.controls.push({ sectionId: section.id, def, control });
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

  /** Syncs every control's value and visibility (mode, visibleWhen) with the store. */
  private refresh(): void {
    const settings = this.store.get();
    for (const { sectionId, def, control } of this.controls) {
      control.update(this.store.getValue(sectionId, def.key));
      control.element.hidden = !isSettingVisible(def, settings, sectionId);
    }
  }
}
