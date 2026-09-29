// All color splitting methods. To add one: write its file (section + method)
// and add it to both lists below.

import { inkMatching, inkMatchingSection } from "./inkMatching";
import { toneMap, toneMapSection } from "./toneMap";
import type { SplitMethod } from "./types";

const METHODS = [inkMatching, toneMap];

/** Each method's settings section, in the order they appear in the panel. */
export const SPLIT_SECTIONS = [inkMatchingSection, toneMapSection] as const;

export const SPLIT_METHOD_OPTIONS = METHODS.map((m) => ({ value: m.id, label: m.label }));

/**
 * Looks a method up by id (falls back to the first). Returned with its settings
 * typed loosely: the pipeline passes each method its own section's values.
 */
export function splitMethod(id: string): SplitMethod {
  return (METHODS.find((m) => m.id === id) ?? METHODS[0]!) as unknown as SplitMethod;
}
