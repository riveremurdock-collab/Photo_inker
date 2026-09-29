// Settings schema. Every setting is defined once: its default,
// range or options, which pipeline stage it invalidates, and whether it is
// stored per ink. The UI builds controls from these definitions, and presets,
// save/load, and randomize walk the same definitions.

import type { StageId } from "../pipeline/stage";

export type AppMode = "digital" | "print";

interface SettingBase<T> {
  /** Key inside its section's settings object. */
  key: string;
  label: string;
  default: T;
  /** One value per ink (stored as an array indexed by ink slot). */
  perInk?: boolean;
  /** Only shown in these modes. Omit to show in both. */
  modes?: AppMode[];
  /** Hidden behind the section's Basic/Advanced toggle. */
  advanced?: boolean;
  help?: string;
}

export interface NumberSetting extends SettingBase<number> {
  kind: "number";
  min: number;
  max: number;
  step: number;
  unit?: string;
}

export interface SelectSetting extends SettingBase<string> {
  kind: "select";
  options: { value: string; label: string }[];
}

export interface ToggleSetting extends SettingBase<boolean> {
  kind: "toggle";
}

export interface ColorSetting extends SettingBase<string> {
  kind: "color";
}

export interface SeedSetting extends SettingBase<number> {
  kind: "seed";
}

/** Point curve: sorted [x, y] pairs in 0..1. */
export interface CurveSetting extends SettingBase<[number, number][]> {
  kind: "curve";
}

export type SettingDef =
  | NumberSetting
  | SelectSetting
  | ToggleSetting
  | ColorSetting
  | SeedSetting
  | CurveSetting;

export interface SectionSchema {
  id: string;
  title: string;
  /** Pipeline stage that reruns when a setting in this section changes. */
  stage: StageId;
  settings: SettingDef[];
  /** Section is hidden unless this returns true (e.g. mode-specific sections). */
  modes?: AppMode[];
}
