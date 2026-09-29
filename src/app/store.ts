// Holds the one ProjectSettings object. Every change goes through set(), which
// coerces the value against the schema and tells listeners which setting (and
// therefore which pipeline stage) changed.

import type { StageId } from "../pipeline/stage";
import { coerceValue, defaultProjectSettings, findSetting, slotDefault, stageFor } from "../schema/registry";
import { SECTIONS, type ProjectSettings } from "../schema/sections";
import type { SectionSchema, SettingDef } from "../schema/types";

export interface SettingChange {
  /** "*" for changes spanning sections (ink reorder / reset). */
  section: string;
  key: string;
  stage: StageId | null;
  /**
   * false while a control is being dragged (preview only), true when the change
   * is final (slider released, option picked). Undo history records commits only.
   */
  commit: boolean;
}

export type SettingsListener = (settings: ProjectSettings, change: SettingChange) => void;

export class SettingsStore {
  private settings: ProjectSettings = defaultProjectSettings();
  private listeners = new Set<SettingsListener>();

  get(): ProjectSettings {
    return this.settings;
  }

  /** Reads one stored value by section and key (used by generated controls). */
  getValue(section: string, key: string): unknown {
    return (this.settings as Record<string, Record<string, unknown>>)[section]?.[key];
  }

  /** Typed setter for app code. */
  set<S extends keyof ProjectSettings, K extends keyof ProjectSettings[S] & string>(
    section: S,
    key: K,
    value: ProjectSettings[S][K],
    options: { commit?: boolean } = {},
  ): void {
    this.setValue(section, key, value, options);
  }

  /** Untyped setter for generated controls; the value is checked against the schema. */
  setValue(section: string, key: string, value: unknown, options: { commit?: boolean } = {}): void {
    const def = findSetting(section, key);
    if (!def) throw new Error(`Unknown setting ${section}.${key}`);
    const next = coerceValue(def, value);
    const commit = options.commit ?? true;
    const current = this.getValue(section, key);
    if (sameValue(current, next) && !commit) return;

    const sectionValues = (this.settings as Record<string, Record<string, unknown>>)[section] ?? {};
    // New objects along the changed path so listeners can compare by reference.
    this.settings = { ...this.settings, [section]: { ...sectionValues, [key]: next } } as ProjectSettings;

    this.emit({ section, key, stage: stageFor(section, key), commit });
  }

  /** Sets one ink slot of a per-ink setting. */
  setInkValue(section: string, key: string, slot: number, value: unknown, options: { commit?: boolean } = {}): void {
    const current = this.getValue(section, key);
    if (!Array.isArray(current)) throw new Error(`${section}.${key} is not a per-ink setting`);
    const next = current.slice();
    next[slot] = value;
    this.setValue(section, key, next, options);
  }

  /**
   * Reorders ink slots in every per-ink setting of every section, so each ink
   * keeps all its settings when print order changes. order[newSlot] = oldSlot.
   */
  permuteInks(order: readonly number[]): void {
    this.updateAllPerInk((_def, values) => values.map((_, i) => values[order[i] ?? i]));
    this.emit({ section: "*", key: "inkSlots", stage: "split", commit: true });
  }

  /** Resets every per-ink setting in one slot to its default (used when adding an ink). */
  resetInkSlot(slot: number): void {
    this.updateAllPerInk((def, values) => values.map((v, i) => (i === slot ? slotDefault(def, i) : v)));
    this.emit({ section: "*", key: "inkSlots", stage: "split", commit: true });
  }

  private updateAllPerInk(fn: (def: SettingDef, values: unknown[]) => unknown[]): void {
    const next = { ...this.settings } as Record<string, Record<string, unknown>>;
    for (const section of SECTIONS as readonly SectionSchema[]) {
      for (const def of section.settings) {
        if (!def.perInk) continue;
        const values = next[section.id]?.[def.key];
        if (!Array.isArray(values)) continue;
        next[section.id] = { ...next[section.id], [def.key]: coerceValue(def, fn(def, values)) };
      }
    }
    this.settings = next as ProjectSettings;
  }

  private emit(change: SettingChange): void {
    for (const listener of this.listeners) listener(this.settings, change);
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  return false;
}
