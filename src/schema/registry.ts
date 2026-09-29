// Lookups and generic operations over the schema: defaults, value checking,
// and which pipeline stage a setting belongs to.

import { MAX_INKS } from "../pipeline/coverage";
import type { StageId } from "../pipeline/stage";
import { SECTIONS, type ProjectSettings } from "./sections";
import type { SectionSchema, SettingDef } from "./types";

export function findSection(sectionId: string): SectionSchema | undefined {
  return SECTIONS.find((s) => s.id === sectionId);
}

export function findSetting(sectionId: string, key: string): SettingDef | undefined {
  return findSection(sectionId)?.settings.find((d) => d.key === key);
}

/** Pipeline stage that reruns when this setting changes, or null if it doesn't affect the preview. */
export function stageFor(sectionId: string, key: string): StageId | null {
  const section = findSection(sectionId);
  const def = section?.settings.find((d) => d.key === key);
  if (!section || !def) return null;
  return def.stage === undefined ? section.stage : def.stage;
}

/** Default for one ink slot (or the scalar default when slot is omitted). */
export function slotDefault(def: SettingDef, slot?: number): unknown {
  const slotValues = def.slotDefaults as readonly unknown[] | undefined;
  const value = slot !== undefined && slotValues?.[slot] !== undefined ? slotValues[slot] : def.default;
  return def.kind === "curve" ? (value as typeof def.default).map((p) => [p[0], p[1]] as const) : value;
}

function defaultValue(def: SettingDef): unknown {
  return def.perInk ? Array.from({ length: MAX_INKS }, (_, i) => slotDefault(def, i)) : slotDefault(def);
}

export function defaultsForSection(section: SectionSchema): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const def of section.settings) values[def.key] = defaultValue(def);
  return values;
}

export function defaultProjectSettings(): ProjectSettings {
  const settings: Record<string, unknown> = {};
  for (const section of SECTIONS) settings[section.id] = defaultsForSection(section);
  return settings as ProjectSettings;
}

/** Coerces one (non-per-ink) value to something valid for its definition, falling back to the default. */
export function coerceScalar(def: SettingDef, value: unknown, slot?: number): unknown {
  if (value === undefined) return slotDefault(def, slot);
  switch (def.kind) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return def.default;
      return Math.min(def.max, Math.max(def.min, n));
    }
    case "seed": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? Math.floor(Math.abs(n)) % 2 ** 31 : def.default;
    }
    case "select":
      return def.options.some((o) => o.value === value) ? value : def.default;
    case "toggle":
      return typeof value === "boolean" ? value : def.default;
    case "color":
      return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : def.default;
    case "text": {
      if (typeof value !== "string") return def.default;
      return def.maxLength ? value.slice(0, def.maxLength) : value;
    }
    case "curve":
      return Array.isArray(value) ? value : def.default;
  }
}

/** Coerces a stored value (an array for per-ink settings). */
export function coerceValue(def: SettingDef, value: unknown): unknown {
  if (!def.perInk) return coerceScalar(def, value);
  const arr = Array.isArray(value) ? value : [];
  return Array.from({ length: MAX_INKS }, (_, i) => coerceScalar(def, arr[i], i));
}

/** Whether a setting is shown for the current mode and section values. */
export function isSettingVisible(def: SettingDef, settings: ProjectSettings, sectionId: string): boolean {
  if (def.modes && !def.modes.includes(settings.upload.mode)) return false;
  if (def.visibleWhen) {
    const section = (settings as Record<string, Record<string, unknown>>)[sectionId] ?? {};
    return def.visibleWhen(section);
  }
  return true;
}
