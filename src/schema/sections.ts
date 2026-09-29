// Every section of the side panel, in workflow order. A section's settings are
// defined here once; the panel, defaults, and (later) presets all read from this.

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
      kind: "text",
      key: "inkName",
      label: "Ink name",
      perInk: true,
      default: "Ink",
      slotDefaults: ["Blue", "Fluorescent Pink", "Yellow", "Black"],
      maxLength: 40,
      hidden: true,
      stage: null,
    },
    {
      // True once the user types a name, so later color changes stop renaming the ink.
      kind: "toggle",
      key: "inkNameEdited",
      label: "Ink name edited",
      perInk: true,
      default: false,
      hidden: true,
      stage: null,
    },
    {
      kind: "color",
      key: "paper",
      label: "Paper",
      default: "#f6f3ec",
      hidden: true,
    },
  ],
});

export const adjustSection = defineSection({
  id: "adjust",
  title: "Image Adjustments",
  stage: "adjust",
  settings: [],
});

export const splitSection = defineSection({
  id: "split",
  title: "Color Splitting",
  stage: "split",
  settings: [],
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
