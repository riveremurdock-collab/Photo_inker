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

export const paletteSection = defineSection({
  id: "palette",
  title: "Palette",
  stage: "overlapTable",
  settings: [],
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
