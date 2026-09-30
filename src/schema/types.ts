// Settings schema. Every setting is defined once: its default, range or
// options, which pipeline stage it invalidates, and whether it is stored per
// ink. The UI builds controls from these definitions, and presets, save/load,
// and randomize walk the same definitions.

import type { StageId } from "../pipeline/stage";

export type AppMode = "digital" | "print";

/** Point curve: sorted [x, y] pairs in 0..1. */
export type CurvePoints = readonly (readonly [number, number])[];

interface SettingBase<T> {
  /** Key inside its section's settings object. */
  readonly key: string;
  readonly label: string;
  readonly default: T;
  /** One value per ink slot (stored as an array of length MAX_INKS). */
  readonly perInk?: boolean;
  /** Per-ink only: a different default for each slot (falls back to `default`). */
  readonly slotDefaults?: readonly T[];
  /** No generated control: a section's custom block edits this value. */
  readonly hidden?: boolean;
  /** Only shown in these modes. Omit to show in both. */
  readonly modes?: readonly AppMode[];
  /** Hidden behind the section's Basic/Advanced toggle. */
  readonly advanced?: boolean;
  /**
   * Pipeline stage that reruns when this setting changes. Defaults to the
   * section's stage; null means it never affects the preview (export-only or UI-only).
   */
  readonly stage?: StageId | null;
  /** Shown only when this returns true for the section's current values. */
  readonly visibleWhen?: (section: Record<string, unknown>) => boolean;
  readonly help?: string;
}

export interface NumberSetting extends SettingBase<number> {
  readonly kind: "number";
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit?: string;
}

export interface SelectSetting extends SettingBase<string> {
  readonly kind: "select";
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** Segmented buttons suit 2–4 short options; dropdown is the default. */
  readonly display?: "dropdown" | "segmented";
  /**
   * The options whose value is an ink slot ("0"–"3") are replaced by the
   * palette's current inks, labelled with their hex codes (dropdown only).
   * Other options (e.g. "auto") stay first.
   */
  readonly inkChoice?: boolean;
}

export interface ToggleSetting extends SettingBase<boolean> {
  readonly kind: "toggle";
}

export interface ColorSetting extends SettingBase<string> {
  readonly kind: "color";
}

export interface TextSetting extends SettingBase<string> {
  readonly kind: "text";
  readonly maxLength?: number;
}

export interface SeedSetting extends SettingBase<number> {
  readonly kind: "seed";
}

export interface CurveSetting extends SettingBase<CurvePoints> {
  readonly kind: "curve";
}

export type SettingDef =
  | NumberSetting
  | SelectSetting
  | ToggleSetting
  | ColorSetting
  | TextSetting
  | SeedSetting
  | CurveSetting;

export interface SectionSchema {
  readonly id: string;
  readonly title: string;
  /** Pipeline stage that reruns when a setting in this section changes (unless the setting overrides it). */
  readonly stage: StageId | null;
  readonly settings: readonly SettingDef[];
  /**
   * Shows this section as a sub-group inside another section (e.g. a splitting
   * method's settings inside Color Splitting) instead of as its own panel section.
   */
  readonly parent?: string;
  /** Sub-sections only: one line shown under the sub-section title. */
  readonly description?: string;
  /** Sub-sections only: shown when this returns true for the current project settings. */
  readonly visibleWhen?: (settings: Record<string, Record<string, unknown>>) => boolean;
}

/** Keeps literal keys and option values so ProjectSettings can be derived from the schema. */
export function defineSection<const S extends SectionSchema>(section: S): S {
  return section;
}

// ---- Types derived from the schema ----

export type SettingValue<D extends SettingDef> = D extends {
  kind: "select";
  options: readonly { value: infer V }[];
}
  ? V
  : D extends { kind: "number" | "seed" }
    ? number
    : D extends { kind: "toggle" }
      ? boolean
      : D extends { kind: "curve" }
        ? CurvePoints
        : string;

export type StoredValue<D extends SettingDef> = D extends { perInk: true }
  ? SettingValue<D>[]
  : SettingValue<D>;

export type SectionValues<S extends SectionSchema> = {
  [D in S["settings"][number] as D["key"]]: StoredValue<D>;
};
