// Side panel: one collapsible section per schema section, in workflow order.
// Controls are generated from the schema; sections that need more than
// generated controls (upload drop zone, palette list, histogram…) get a
// custom block placed above their generated controls. Sections with a parent
// (e.g. each splitting method) are shown as sub-groups inside the parent,
// only while their visibleWhen condition holds.

import type { SettingsStore } from "../app/store";
import { isSettingVisible } from "../schema/registry";
import { SECTIONS, type ProjectSettings, type SectionId } from "../schema/sections";
import type { SectionSchema, SettingDef } from "../schema/types";
import { createControl, type Control } from "./controls/controls";

/** Shown in sections that have no settings yet. */
const COMING_IN: Partial<Record<SectionId, string>> = {
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

interface SubSection {
  section: SectionSchema;
  element: HTMLElement;
}

export class Panel {
  readonly element: HTMLElement;
  private controls: BoundControl[] = [];
  private subSections: SubSection[] = [];

  constructor(
    private store: SettingsStore,
    customBlocks: Partial<Record<SectionId, HTMLElement>> = {},
    /** Custom blocks placed after a section's generated controls. */
    afterBlocks: Partial<Record<SectionId, HTMLElement>> = {},
  ) {
    this.element = document.createElement("aside");
    this.element.className = "panel";
    this.element.setAttribute("aria-label", "Settings");

    const bodies = new Map<string, HTMLElement>();
    for (const section of SECTIONS as readonly SectionSchema[]) {
      if (section.parent) {
        const parentBody = bodies.get(section.parent);
        if (!parentBody) throw new Error(`Section ${section.id}: parent ${section.parent} must come first`);
        const sub = document.createElement("div");
        sub.className = "panel-subsection";
        sub.dataset.section = section.id;
        const title = document.createElement("h3");
        title.textContent = section.title;
        sub.append(title);
        if (section.description) {
          const d = document.createElement("p");
          d.className = "control-help";
          d.textContent = section.description;
          sub.append(d);
        }
        const custom = customBlocks[section.id as SectionId];
        if (custom) sub.append(custom);
        this.addControls(section, sub);
        const subAfter = afterBlocks[section.id as SectionId];
        if (subAfter) sub.append(subAfter);
        parentBody.append(sub);
        this.subSections.push({ section, element: sub });
        continue;
      }

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
      bodies.set(section.id, body);

      const custom = customBlocks[section.id as SectionId];
      if (custom) body.append(custom);
      this.addControls(section, body);
      const after = afterBlocks[section.id as SectionId];
      if (after) body.append(after);

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

  private addControls(section: SectionSchema, container: HTMLElement): void {
    for (const def of section.settings) {
      if (def.hidden) continue;
      const bound = def.perInk ? this.perInkControl(section.id, def) : this.scalarControl(section.id, def);
      container.append(bound.element);
      this.controls.push(bound);
    }
  }

  private scalarControl(sectionId: string, def: SettingDef): BoundControl {
    const control = createControl(def, this.store.getValue(sectionId, def.key), (value, commit) =>
      this.store.setValue(sectionId, def.key, value, { commit }),
    );
    if (def.kind === "select" && def.inkChoice) return this.inkChoiceControl(sectionId, def, control);
    return {
      sectionId,
      def,
      element: control.element,
      update: () => control.update(this.store.getValue(sectionId, def.key)),
    };
  }

  /**
   * A dropdown listing the palette's current inks ("Ink 1 · #0078BF"). A stored
   * slot beyond the ink count shows the ink actually used (the last one).
   */
  private inkChoiceControl(sectionId: string, def: SettingDef & { kind: "select" }, control: Control): BoundControl {
    const fixed = def.options.filter((o) => !/^\d+$/.test(o.value));
    let signature = "";
    return {
      sectionId,
      def,
      element: control.element,
      update: (settings) => {
        const { inkCount, inkColor } = settings.palette;
        const next = `${inkCount}|${inkColor.slice(0, inkCount).join()}`;
        if (next !== signature) {
          signature = next;
          control.setOptions?.([
            ...fixed,
            ...Array.from({ length: inkCount }, (_, i) => ({ value: String(i), label: `Ink ${i + 1} · ${(inkColor[i] ?? "").toUpperCase()}` })),
          ]);
        }
        const value = String(this.store.getValue(sectionId, def.key));
        control.update(/^\d+$/.test(value) && Number(value) >= inkCount ? String(inkCount - 1) : value);
      },
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
    if (def.help) {
      const help = document.createElement("p");
      help.className = "control-help";
      help.textContent = def.help;
      element.append(help);
    }

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
    for (const { section, element } of this.subSections) {
      element.hidden = section.visibleWhen ? !section.visibleWhen(settings as unknown as Record<string, Record<string, unknown>>) : false;
    }
    for (const bound of this.controls) {
      bound.update(settings);
      bound.element.hidden = !isSettingVisible(bound.def, settings, bound.sectionId);
    }
  }
}
