// Holds the one ProjectSettings object. Every change goes through set(), which
// coerces the value against the schema and tells listeners which setting (and
// therefore which pipeline stage) changed.

import type { StageId } from "../pipeline/stage";
import { coerceValue, defaultProjectSettings, findSetting, stageFor } from "../schema/registry";
import type { ProjectSettings } from "../schema/sections";

export interface SettingChange {
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

    const change: SettingChange = { section, key, stage: stageFor(section, key), commit };
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
