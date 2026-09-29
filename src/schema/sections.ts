// Every section of the side panel, in workflow order. A section's settings are
// defined here once; the panel, defaults, and (later) presets all read from this.

import { SPLIT_METHOD_OPTIONS, SPLIT_SECTIONS } from "../plugins/splitting/registry";
import { defineSection, type SectionValues } from "./types";

export const uploadSection = defineSection({
  id: "upload",
  title: "Upload",
  stage: "upload",
  settings: [
    {
      kind: "select",
      key: "mode",
      label: "Mode",
      default: "digital",
      display: "segmented",
      stage: null,
      options: [
        { value: "digital", label: "Digital" },
        { value: "print", label: "Print" },
      ],
      help: "Digital exports one riso-style image. Print exports each ink as a separate black-and-white layer.",
    },
    {
      kind: "text",
      key: "projectName",
      label: "Project name",
      default: "Untitled",
      maxLength: 60,
      stage: null,
      help: "Used to name exported files.",
    },
  ],
});

// The palette's controls are a custom block (ui/sections/palette.ts), so every
// setting here is hidden from the generated panel.
export const paletteSection = defineSection({
  id: "palette",
  title: "Palette",
  stage: "overlapTable",
  settings: [
    {
      kind: "select",
      key: "source",
      label: "Colors",
      default: "manual",
      display: "segmented",
      hidden: true,
      stage: null,
      options: [
        { value: "manual", label: "Manual" },
        { value: "auto", label: "Auto" },
      ],
    },
    {
      kind: "toggle",
      key: "autoIncludeBackground",
      label: "Pick the background from the image too",
      default: false,
      hidden: true,
      stage: null,
    },
    {
      kind: "number",
      key: "inkCount",
      label: "Number of inks",
      default: 3,
      min: 1,
      max: 4,
      step: 1,
      hidden: true,
      stage: "split",
    },
    {
      kind: "color",
      key: "inkColor",
      label: "Ink color",
      perInk: true,
      default: "#000000",
      slotDefaults: ["#0078bf", "#ff48b0", "#ffe800", "#000000"],
      hidden: true,
    },
    {
      kind: "color",
      key: "paper",
      label: "Paper",
      default: "#f6f3ec",
      hidden: true,
    },
    {
      kind: "number",
      key: "inkOpacity",
      label: "Ink opacity",
      perInk: true,
      default: 0,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      help: "Riso inks are transparent (0%). Raise this for dense inks like metallics or white, which partly cover inks printed before them.",
    },
  ],
});

// Applied to the image before color splitting, so they affect every method.
export const adjustSection = defineSection({
  id: "adjust",
  title: "Image Adjustments",
  stage: "adjust",
  settings: [
    { kind: "number", key: "blackPoint", label: "Levels: black point", default: 0, min: 0, max: 100, step: 0.5, unit: "%" },
    { kind: "number", key: "whitePoint", label: "Levels: white point", default: 100, min: 0, max: 100, step: 0.5, unit: "%" },
    {
      kind: "number",
      key: "midtone",
      label: "Levels: midtone",
      default: 0,
      min: -100,
      max: 100,
      step: 1,
      help: "Positive brightens the midtones, negative darkens them.",
    },
    {
      kind: "curve",
      key: "curve",
      label: "Contrast curve",
      default: [
        [0, 0],
        [1, 1],
      ],
      help: "Click to add a point, drag to move it, double-click a point to remove it.",
    },
    {
      kind: "number",
      key: "saturation",
      label: "Saturation boost",
      default: 0,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      help: "Most useful with Ink Matching.",
    },
    {
      kind: "number",
      key: "smoothing",
      label: "Smoothing",
      default: 0,
      min: 0,
      max: 10,
      step: 0.1,
      help: "Softens noise and fine texture while keeping edges.",
    },
  ],
});

export const splitSection = defineSection({
  id: "split",
  title: "Color Splitting",
  stage: "split",
  settings: [{ kind: "select", key: "method", label: "Method", default: "inkMatching", options: SPLIT_METHOD_OPTIONS }],
});

// Shared layer options: act on each ink layer, whatever method made it.
// Edited in a custom block (ui/sections/layers.ts).
export const layersSection = defineSection({
  id: "layers",
  title: "Layers",
  stage: "layerOptions",
  parent: "split",
  settings: [
    { kind: "number", key: "density", label: "Density", perInk: true, default: 100, min: 0, max: 200, step: 1, unit: "%", hidden: true },
    { kind: "toggle", key: "invert", label: "Invert", perInk: true, default: false, hidden: true },
    // Preview only: never affects exports.
    { kind: "toggle", key: "solo", label: "Solo", perInk: true, default: false, hidden: true, stage: "mix" },
    { kind: "toggle", key: "mute", label: "Mute", perInk: true, default: false, hidden: true, stage: "mix" },
  ],
});

export const halftoneSection = defineSection({
  id: "halftone",
  title: "Halftone",
  stage: "halftone",
  settings: [],
});

export const borderSection = defineSection({
  id: "border",
  title: "Border",
  stage: "border",
  settings: [],
});

export const printSimSection = defineSection({
  id: "printSim",
  title: "Print Simulation",
  stage: "printSim",
  settings: [],
});

export const exportSection = defineSection({
  id: "export",
  title: "Export",
  stage: null,
  settings: [
    {
      kind: "select",
      key: "digitalFormat",
      label: "Format",
      default: "png",
      display: "segmented",
      modes: ["digital"],
      options: [
        { value: "png", label: "PNG" },
        { value: "jpg", label: "JPG" },
      ],
    },
    {
      kind: "number",
      key: "dpi",
      label: "Resolution",
      default: 600,
      min: 150,
      max: 1200,
      step: 50,
      unit: "DPI",
      modes: ["print"],
      help: "Riso machines print at 600 DPI.",
    },
  ],
});

export const SECTIONS = [
  uploadSection,
  paletteSection,
  adjustSection,
  splitSection,
  ...SPLIT_SECTIONS,
  layersSection,
  halftoneSection,
  borderSection,
  printSimSection,
  exportSection,
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** All project settings, derived from the schema above. */
export type ProjectSettings = {
  [S in (typeof SECTIONS)[number] as S["id"]]: SectionValues<S>;
};
