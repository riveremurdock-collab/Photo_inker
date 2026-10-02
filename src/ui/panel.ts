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
const COMING_IN: Partial<Record<SectionId, string>> = {};

interface BoundControl {
  sectionId: string;
  def: SettingDef;
  /** The row (or the collapsible wrapper around it) that is hidden when the setting is. */
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
  /** Controls placed at the end of their section, after its sub-sections (SettingDef.placement). */
  private atEnd: { container: HTMLElement; element: HTMLElement }[] = [];

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
    // End-placed controls go in one block per section, set apart from the sub-sections above.
    const endBlocks = new Map<HTMLElement, HTMLElement>();
    for (const { container, element } of this.atEnd) {
      let block = endBlocks.get(container);
      if (!block) {
        block = document.createElement("div");
        block.className = "panel-end";
        container.append(block);
        endBlocks.set(container, block);
      }
      block.append(element);
    }

    this.refresh();
    store.subscribe(() => this.refresh());
  }

  private addControls(section: SectionSchema, container: HTMLElement): void {
    for (const def of section.settings) {
      if (def.hidden) continue;
      const bound = def.perInk ? this.perInkControl(section.id, def) : this.scalarControl(section.id, def);
      if (def.collapsed) bound.element = collapsible(def.collapsed, bound.element);
      if (def.placement === "end") this.atEnd.push({ container, element: bound.element });
      else container.append(bound.element);
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

  /**
   * A labelled group with one control per active ink, rebuilt when the inks
   * change. Per-ink numbers can be linked ("Same for all inks"): one slider
   * then sets every ink. Linking is a view choice, not a setting: it starts
   * from SettingDef.linkInks, but only when the inks already share a value.
   */
  private perInkControl(sectionId: string, def: SettingDef): BoundControl {
    const element = document.createElement("div");
    element.className = "control-group";
    const head = document.createElement("div");
    head.className = "control-group-head";
    const label = document.createElement("span");
    label.className = "control-label";
    label.textContent = def.label;
    head.append(label);
    const rows = document.createElement("div");
    rows.className = "control-group-rows";
    element.append(head, rows);
    if (def.help) {
      const help = document.createElement("p");
      help.className = "control-help";
      help.textContent = def.help;
      element.append(help);
    }

    const store = this.store;
    const linkable = def.kind === "number";
    let linked: boolean | null = null;
    const linkBox = document.createElement("input");
    if (linkable) {
      const linkLabel = document.createElement("label");
      linkLabel.className = "control-link";
      linkBox.type = "checkbox";
      linkLabel.append(linkBox, "Same for all inks");
      head.append(linkLabel);
      linkBox.addEventListener("change", () => {
        linked = linkBox.checked;
        // Linking gives every ink the first ink's value.
        if (linked) setAll((store.getValue(sectionId, def.key) as unknown[])[0], true);
        else this.refresh();
      });
    }
    const setAll = (value: unknown, commit: boolean) => {
      const n = store.get().palette.inkCount;
      const values = store.getValue(sectionId, def.key) as unknown[];
      store.setValue(sectionId, def.key, values.map((v, i) => (i < n ? value : v)), { commit });
    };
    const dot = (color: string) => {
      const d = document.createElement("span");
      d.className = "ink-dot";
      d.style.setProperty("--swatch", color);
      return d;
    };

    let signature = "";
    let controls: Control[] = [];

    return {
      sectionId,
      def,
      element,
      update(settings) {
        const { inkCount, inkColor } = settings.palette;
        const values = store.getValue(sectionId, def.key) as unknown[];
        const active = values.slice(0, inkCount);
        const allSame = active.every((v) => v === active[0]);
        linked ??= def.linkInks !== false && allSame;
        const showLinked = linkable && linked && inkCount > 1;
        if (linkable) {
          linkBox.checked = showLinked;
          linkBox.parentElement!.hidden = inkCount < 2;
        }
        // A linked group whose inks drifted apart (e.g. an ink was just added): bring them back together.
        if (showLinked && !allSame) queueMicrotask(() => setAll(values[0], true));

        const nextSignature = `${inkCount}|${inkColor.join("|")}|${showLinked}`;
        if (nextSignature !== signature) {
          signature = nextSignature;
          rows.innerHTML = "";
          controls = [];
          if (showLinked) {
            const control = createControl({ ...def, help: undefined }, values[0], (value, commit) => setAll(value, commit), "All inks");
            const labelEl = control.element.querySelector(".control-label");
            for (let slot = inkCount - 1; slot >= 0; slot--) labelEl?.prepend(dot(inkColor[slot] ?? "#000"));
            rows.append(control.element);
            controls.push(control);
            return;
          }
          for (let slot = 0; slot < inkCount; slot++) {
            const control = createControl(
              { ...def, help: undefined },
              values[slot],
              (value, commit) => store.setInkValue(sectionId, def.key, slot, value, { commit }),
              (inkColor[slot] ?? "").toUpperCase(),
            );
            control.element.querySelector(".control-label")?.prepend(dot(inkColor[slot] ?? "#000"));
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

/** Wraps a control in a collapsed row (SettingDef.collapsed). */
function collapsible(summaryText: string, content: HTMLElement): HTMLElement {
  const details = document.createElement("details");
  details.className = "control-more";
  const summary = document.createElement("summary");
  summary.textContent = summaryText;
  details.append(summary, content);
  return details;
}
