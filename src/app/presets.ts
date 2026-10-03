// Presets: the look of a project (palette, adjustments, color splitting,
// layers, halftone, border, print simulation) as a small JSON file, and a
// list of presets saved in this browser.
//
// Not included: Upload (mode, project name) and Export (page, resolution,
// files), so loading a style never changes the page or the file names; the
// photo's crop, rotation and straightening; and the preview-only layer solo/mute.
//
// Loading walks the schema: each setting in the file is checked against its
// definition (coerceValue, plus a shape check for curves); settings missing
// from the file (e.g. added to the app after it was saved) get their
// defaults, and anything unknown is ignored.

import { coerceValue, defaultsForSection } from "../schema/registry";
import { SECTIONS, type ProjectSettings } from "../schema/sections";
import type { SectionSchema, SettingDef } from "../schema/types";

export const PRESET_VERSION = 1;
const APP = "photo-inker";
const STORAGE_KEY = "photo-inker.presets.v1";

/** Sections a preset leaves alone. */
const NOT_IN_PRESETS = new Set(["upload", "presets", "export"]);
/** Settings kept as they are when a preset is applied: the photo's geometry, and preview-only ones. */
const KEPT_ON_APPLY = new Set(["adjust.turn", "adjust.straighten", "adjust.cropX", "adjust.cropY", "adjust.cropW", "adjust.cropH", "layers.solo", "layers.mute"]);

export interface PresetFile {
  app: typeof APP;
  kind: "preset";
  version: number;
  name: string;
  savedAt: string;
  settings: Record<string, Record<string, unknown>>;
}

export class PresetError extends Error {}

const lookSections = () => (SECTIONS as readonly SectionSchema[]).filter((s) => !NOT_IN_PRESETS.has(s.id));

/** The current look as a preset. */
export function makePreset(name: string, settings: ProjectSettings): PresetFile {
  const all = settings as unknown as Record<string, Record<string, unknown>>;
  const look: PresetFile["settings"] = {};
  for (const section of lookSections()) {
    const values: Record<string, unknown> = {};
    for (const def of section.settings) {
      if (!KEPT_ON_APPLY.has(`${section.id}.${def.key}`)) values[def.key] = all[section.id]?.[def.key];
    }
    look[section.id] = values;
  }
  return { app: APP, kind: "preset", version: PRESET_VERSION, name: name.trim() || "Preset", savedAt: new Date().toISOString(), settings: JSON.parse(JSON.stringify(look)) };
}

/** Reads a preset file's text. Throws PresetError with a message for the user. */
export function parsePreset(text: string): PresetFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PresetError("That file isn't a Photo Inker preset (it isn't valid JSON).");
  }
  const p = data as Partial<PresetFile> | null;
  if (!p || typeof p !== "object" || p.app !== APP || p.kind !== "preset" || typeof p.settings !== "object" || !p.settings) {
    throw new PresetError("That file isn't a Photo Inker preset.");
  }
  return {
    app: APP,
    kind: "preset",
    version: typeof p.version === "number" ? p.version : 1,
    name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : "Preset",
    savedAt: typeof p.savedAt === "string" ? p.savedAt : "",
    settings: p.settings as PresetFile["settings"],
  };
}

/** A curve must be [x, y] pairs in 0..1, at least two of them. */
function validCurve(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1))
  );
}

function checked(def: SettingDef, value: unknown, fallback: unknown): unknown {
  if (def.kind === "curve") {
    if (def.perInk) {
      const arr = Array.isArray(value) ? value : [];
      const fb = fallback as unknown[];
      return fb.map((d, i) => (validCurve(arr[i]) ? arr[i] : d));
    }
    return validCurve(value) ? value : fallback;
  }
  return coerceValue(def, value);
}

/** The project with the preset's look applied (the rest of the project unchanged). */
export function applyPreset(current: ProjectSettings, preset: PresetFile): ProjectSettings {
  const next = { ...(current as unknown as Record<string, Record<string, unknown>>) };
  for (const section of lookSections()) {
    const defaults = defaultsForSection(section);
    const values = preset.settings[section.id] ?? {};
    const out: Record<string, unknown> = { ...next[section.id] };
    for (const def of section.settings) {
      if (KEPT_ON_APPLY.has(`${section.id}.${def.key}`)) continue;
      out[def.key] = def.key in values ? checked(def, JSON.parse(JSON.stringify(values[def.key])), defaults[def.key]) : defaults[def.key];
    }
    next[section.id] = out;
  }
  return next as unknown as ProjectSettings;
}

/** The preset as a downloadable file. */
export function presetBlob(preset: PresetFile): Blob {
  return new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" });
}

// ---- Presets saved in this browser ----
// Storage can be unavailable (private windows, blocked site data): every
// access is guarded, and the panel says so instead of failing.

export function savedPresets(): PresetFile[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
      try {
        return [parsePreset(JSON.stringify(item))];
      } catch {
        return [];
      }
    });
  } catch {
    return null;
  }
}

function writeSaved(list: PresetFile[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Saves (or replaces, by name) a preset in this browser. Returns false if storage isn't available. */
export function savePreset(preset: PresetFile): boolean {
  const list = savedPresets();
  if (!list) return false;
  const i = list.findIndex((p) => p.name.toLowerCase() === preset.name.toLowerCase());
  if (i >= 0) list[i] = preset;
  else list.push(preset);
  list.sort((a, b) => a.name.localeCompare(b.name));
  return writeSaved(list);
}

export function deletePreset(name: string): boolean {
  const list = savedPresets();
  if (!list) return false;
  return writeSaved(list.filter((p) => p.name !== name));
}
