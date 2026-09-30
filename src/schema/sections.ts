// Every section of the side panel, in workflow order. A section's settings are
// defined here once; the panel, defaults, and (later) presets all read from this.

import { SCHEMES } from "../app/colorSchemes";
import { HALFTONE_SECTIONS, HALFTONE_TYPE_OPTIONS } from "../plugins/halftone/registry";
import { SPLIT_METHOD_OPTIONS, SPLIT_SECTIONS } from "../plugins/splitting/registry";
import { PRINT_SIM_SECTIONS } from "./printSimSections";
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
        { value: "scheme", label: "Scheme" },
        { value: "auto", label: "Auto" },
      ],
    },
    {
      kind: "select",
      key: "scheme",
      label: "Scheme",
      default: "triad",
      hidden: true,
      stage: null,
      options: SCHEMES.map((sc) => ({ value: sc.id, label: `${sc.label} (${sc.count})` })),
    },
    {
      kind: "toggle",
      key: "schemeIncludeBackground",
      label: "Include background in scheme",
      default: false,
      hidden: true,
      stage: null,
    },
    {
      // The scheme's first color (ink 1); the others are generated from it.
      kind: "color",
      key: "schemeBase",
      label: "First color",
      default: "#0078bf",
      hidden: true,
      stage: null,
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
    { kind: "number", key: "levelsBlack", label: "Levels: start", perInk: true, default: 0, min: 0, max: 100, step: 0.5, unit: "%", hidden: true },
    { kind: "number", key: "levelsWhite", label: "Levels: full", perInk: true, default: 100, min: 0, max: 100, step: 0.5, unit: "%", hidden: true },
    { kind: "number", key: "levelsMid", label: "Levels: midtone", perInk: true, default: 0, min: -100, max: 100, step: 1, hidden: true },
    {
      kind: "curve",
      key: "curve",
      label: "Curve",
      perInk: true,
      default: [
        [0, 0],
        [1, 1],
      ],
      hidden: true,
    },
    // Knockout: this layer clears the layers printed before it where it has ink.
    { kind: "toggle", key: "knockout", label: "Knockout", perInk: true, default: false, hidden: true },
    // Choke (−) or spread (+), in output pixels.
    { kind: "number", key: "trap", label: "Choke / spread", perInk: true, default: 0, min: -8, max: 8, step: 0.5, unit: "px", hidden: true },
    {
      kind: "number",
      key: "inkLimit",
      label: "Total ink limit",
      default: 400,
      min: 100,
      max: 400,
      step: 5,
      unit: "%",
      help: "Caps the combined coverage of all inks at any spot. 400% = no limit. Lower it to reduce heavy, muddy overlaps.",
    },
    // Preview only: never affects exports.
    { kind: "toggle", key: "solo", label: "Solo", perInk: true, default: false, hidden: true, stage: "mix" },
    { kind: "toggle", key: "mute", label: "Mute", perInk: true, default: false, hidden: true, stage: "mix" },
  ],
});

// One halftone type for the whole image; each type has its own sub-section
// (plugins/halftone). The minimum dot size is shared by every type.
export const halftoneSection = defineSection({
  id: "halftone",
  title: "Halftone",
  stage: "halftone",
  settings: [
    { kind: "select", key: "type", label: "Type", default: "am", options: HALFTONE_TYPE_OPTIONS },
    {
      kind: "number",
      key: "minDot",
      label: "Minimum dot size",
      perInk: true,
      default: 1.5,
      min: 0,
      max: 8,
      step: 0.5,
      unit: "px",
      help: "Smallest dot allowed, in output pixels (1–2 px at 600 DPI). Riso machines struggle to print tiny dots.",
      visibleWhen: (h) => h.type !== "none",
    },
    {
      kind: "select",
      key: "minDotMode",
      label: "Tones lighter than the minimum",
      default: "drop",
      display: "segmented",
      options: [
        { value: "drop", label: "Drop to paper" },
        { value: "round", label: "Round up" },
      ],
      visibleWhen: (h) => h.type === "am",
    },
  ],
});

// Sizes are in % of the image's shorter side, so a border looks the same in
// the preview and in an export at any size or DPI.
export const borderSection = defineSection({
  id: "border",
  title: "Border",
  stage: "border",
  settings: [
    {
      kind: "toggle",
      key: "fade",
      label: "Fade edges",
      default: false,
      help: "A soft vignette to black or white. Applied before processing, so it is split and halftoned like the rest of the image.",
    },
    {
      kind: "select",
      key: "fadeColor",
      label: "Fade to",
      default: "white",
      display: "segmented",
      options: [
        { value: "white", label: "White" },
        { value: "black", label: "Black" },
      ],
      visibleWhen: (b) => b.fade === true,
    },
    { kind: "number", key: "fadeDistance", label: "Fade distance", default: 12, min: 0.5, max: 50, step: 0.5, unit: "%", help: "How far the fade reaches in from the edge (% of the shorter side).", visibleWhen: (b) => b.fade === true },
    { kind: "number", key: "fadeRadius", label: "Fade corner radius", default: 0, min: 0, max: 50, step: 0.5, unit: "%", visibleWhen: (b) => b.fade === true },
    { kind: "number", key: "fadeOpacity", label: "Fade opacity", default: 100, min: 0, max: 100, step: 1, unit: "%", visibleWhen: (b) => b.fade === true },
    {
      kind: "select",
      key: "fadeCurve",
      label: "Fade curve",
      default: "smooth",
      options: [
        { value: "linear", label: "Linear (even)" },
        { value: "smooth", label: "Smooth (like a camera vignette)" },
        { value: "exponential", label: "Exponential (strong at the edge, then drops off)" },
        { value: "custom", label: "Custom" },
      ],
      visibleWhen: (b) => b.fade === true,
    },
    {
      kind: "curve",
      key: "fadeCustom",
      label: "Custom fade (edge → inside)",
      default: [
        [0, 1],
        [1, 0],
      ],
      visibleWhen: (b) => b.fade === true && b.fadeCurve === "custom",
    },
    {
      kind: "number",
      key: "fadeMidpoint",
      label: "Fade midpoint",
      default: 50,
      min: 5,
      max: 95,
      step: 1,
      unit: "%",
      help: "Where the fade is at half strength, as a share of the fade distance.",
      visibleWhen: (b) => b.fade === true,
    },
    {
      kind: "select",
      key: "frame",
      label: "Border",
      default: "none",
      display: "segmented",
      options: [
        { value: "none", label: "None" },
        { value: "ink", label: "Solid ink" },
        { value: "paper", label: "Paper" },
      ],
      help: "Solid ink: one ink, not halftoned, with every other ink removed there. Paper: bare paper.",
    },
    {
      kind: "select",
      key: "frameInk",
      label: "Border ink",
      default: "0",
      inkChoice: true,
      options: [
        { value: "0", label: "Ink 1" },
        { value: "1", label: "Ink 2" },
        { value: "2", label: "Ink 3" },
        { value: "3", label: "Ink 4" },
      ],
      visibleWhen: (b) => b.frame === "ink",
    },
    {
      kind: "number",
      key: "frameThickness",
      label: "Thickness",
      default: 4,
      min: -25,
      max: 25,
      step: 0.25,
      unit: "%",
      help: "Positive grows the canvas outward around the image; negative covers the image's edge.",
      visibleWhen: (b) => b.frame !== "none",
    },
    { kind: "number", key: "frameRadius", label: "Corner radius", default: 0, min: 0, max: 50, step: 0.5, unit: "%", help: "Rounds the corners of the image opening.", visibleWhen: (b) => b.frame !== "none" },
  ],
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
      kind: "select",
      key: "digitalSize",
      label: "Output size",
      default: "original",
      display: "segmented",
      modes: ["digital"],
      stage: "halftone",
      options: [
        { value: "original", label: "Original" },
        { value: "double", label: "2×" },
        { value: "custom", label: "Custom" },
      ],
      help: "Halftone sizes are measured in output pixels.",
    },
    {
      kind: "number",
      key: "digitalWidth",
      label: "Output width",
      default: 3000,
      min: 100,
      max: 16000,
      step: 10,
      unit: "px",
      modes: ["digital"],
      stage: "halftone",
      visibleWhen: (e) => e.digitalSize === "custom",
    },
    {
      kind: "number",
      key: "printWidth",
      label: "Print width",
      default: 8,
      min: 1,
      max: 40,
      step: 0.1,
      unit: "in",
      modes: ["print"],
      stage: "halftone",
      help: "Width of the printed image. Page size and placement come later.",
    },
    {
      kind: "number",
      key: "dpi",
      label: "Resolution",
      stage: "halftone",
      default: 600,
      min: 150,
      max: 1200,
      step: 50,
      unit: "DPI",
      modes: ["print"],
      help: "Riso machines print at 600 DPI.",
    },
    {
      kind: "toggle",
      key: "gainCompensation",
      label: "Dot gain compensation",
      default: false,
      modes: ["print"],
      stage: "printSim",
      help: "Shrinks dots in the riso layers so they print at the intended size after the ink spreads. Uses the Dot gain settings in Print Simulation.",
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
  ...HALFTONE_SECTIONS,
  borderSection,
  ...PRINT_SIM_SECTIONS,
  exportSection,
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** All project settings, derived from the schema above. */
export type ProjectSettings = {
  [S in (typeof SECTIONS)[number] as S["id"]]: SectionValues<S>;
};
