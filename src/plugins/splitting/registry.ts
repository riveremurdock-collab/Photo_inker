// All color splitting methods. To add one: write its file (section + method)
// and add it to both lists below.

import { channelSplit, channelSplitSection } from "./channelSplit";
import { detailSplit, detailSplitSection } from "./detailSplit";
import { inkMatching, inkMatchingSection } from "./inkMatching";
import { selectiveColor, selectiveColorSection } from "./selectiveColor";
import { toneMap, toneMapSection } from "./toneMap";
import type { SplitMethod } from "./types";

const METHODS = () => [inkMatching, toneMap, channelSplit, selectiveColor, detailSplit];

/** Each method's settings section, in the order they appear in the panel. */
export const SPLIT_SECTIONS = [inkMatchingSection, toneMapSection, channelSplitSection, selectiveColorSection, detailSplitSection] as const;

export const SPLIT_METHOD_OPTIONS = [
  { value: "inkMatching", label: "Ink Matching" },
  { value: "toneMap", label: "Tone Map" },
  { value: "channel", label: "Channel Split" },
  { value: "selective", label: "Selective Color" },
  { value: "detail", label: "Detail Split" },
];

/**
 * Looks a method up by id (falls back to the first). Returned with its settings
 * typed loosely: the pipeline passes each method its own section's values.
 */
export function splitMethod(id: string): SplitMethod {
  const methods = METHODS();
  return (methods.find((m) => m.id === id) ?? methods[0]!) as unknown as SplitMethod;
}
