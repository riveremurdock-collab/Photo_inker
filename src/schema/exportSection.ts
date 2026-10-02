// Export settings. Digital mode exports one image; Print mode exports a page
// for a riso (one black-and-white layer per ink) or a standard printer (one
// color page). Page geometry lives in app/layout.ts.
//
// Settings that change the output size change how big halftone dots are
// relative to the image, so they rerun the halftone stage.

import { defineSection } from "./types";

const inDigital = ["digital"] as const;
const inPrint = ["print"] as const;

const MARGIN_HELP = "Riso machines can't print within about 5 mm (0.2 in) of the paper edge; shown as a dashed guide in the preview.";
const BLEED_HELP = "Extra paper around the page for artwork that runs off the edge; the file grows by this much on each side.";

export const exportSection = defineSection({
  id: "export",
  title: "Export",
  stage: null,
  settings: [
    // ---- Digital ----
    {
      kind: "select",
      key: "digitalSize",
      label: "Size",
      default: "original",
      display: "segmented",
      modes: inDigital,
      stage: "halftone",
      options: [
        { value: "half", label: "0.5×" },
        { value: "original", label: "1×" },
        { value: "double", label: "2×" },
        { value: "triple", label: "3×" },
        { value: "custom", label: "Custom" },
      ],
      help: "Scale of the uploaded image. Halftone sizes are measured in output pixels.",
    },
    { kind: "toggle", key: "lockAspect", label: "Lock aspect ratio", default: true, modes: inDigital, stage: "halftone", visibleWhen: (e) => e.digitalSize === "custom" },
    { kind: "number", key: "digitalWidth", label: "Width", default: 3000, min: 16, max: 16000, step: 1, unit: "px", modes: inDigital, stage: "halftone", visibleWhen: (e) => e.digitalSize === "custom" },
    {
      kind: "number",
      key: "digitalHeight",
      label: "Height",
      default: 2000,
      min: 16,
      max: 16000,
      step: 1,
      unit: "px",
      modes: inDigital,
      stage: "halftone",
      visibleWhen: (e) => e.digitalSize === "custom" && e.lockAspect === false,
    },
    {
      kind: "select",
      key: "digitalFit",
      label: "Image placement",
      default: "fit",
      display: "segmented",
      modes: inDigital,
      stage: "halftone",
      options: [
        { value: "fit", label: "Fit" },
        { value: "fill", label: "Fill" },
      ],
      help: "Fit: the whole image shows, with paper around it. Fill: covers the whole size, cropping the image.",
      visibleWhen: (e) => e.digitalSize === "custom" && e.lockAspect === false,
    },
    {
      kind: "select",
      key: "digitalFormat",
      label: "File format",
      default: "png",
      display: "segmented",
      modes: inDigital,
      options: [
        { value: "png", label: "PNG" },
        { value: "jpg", label: "JPG" },
      ],
    },
    { kind: "number", key: "jpgQuality", label: "JPG quality", default: 92, min: 40, max: 100, step: 1, unit: "%", modes: inDigital, visibleWhen: (e) => e.digitalFormat === "jpg" },
    {
      kind: "toggle",
      key: "transparent",
      label: "Transparent background",
      default: false,
      modes: inDigital,
      help: "The paper becomes transparent; ink keeps its printed color.",
      visibleWhen: (e) => e.digitalFormat === "png",
    },

    // ---- Print: printer, then the page, then the file, then marks and extras ----
    {
      kind: "select",
      key: "printTarget",
      label: "Printer",
      default: "riso",
      display: "segmented",
      modes: inPrint,
      stage: "printSim",
      options: [
        { value: "riso", label: "Riso layers" },
        { value: "standard", label: "Standard printer" },
      ],
      help: "Riso: one black-and-white file per ink. Standard printer: one color page, without print simulation.",
    },
    {
      kind: "select",
      key: "pageSize",
      label: "Page size",
      default: "letter",
      modes: inPrint,
      stage: "halftone",
      options: [
        { value: "letter", label: "Letter (8.5 × 11 in)" },
        { value: "legal", label: "Legal (8.5 × 14 in)" },
        { value: "tabloid", label: "Tabloid (11 × 17 in)" },
        { value: "a4", label: "A4 (210 × 297 mm)" },
        { value: "a3", label: "A3 (297 × 420 mm)" },
        { value: "b4", label: "B4 (257 × 364 mm)" },
        { value: "custom", label: "Custom" },
        { value: "image", label: "Image only (no page)" },
      ],
    },
    {
      kind: "select",
      key: "units",
      label: "Units",
      default: "in",
      display: "segmented",
      modes: inPrint,
      stage: "halftone",
      options: [
        { value: "in", label: "in" },
        { value: "mm", label: "mm" },
      ],
      help: "For margins, bleed, image width and custom page sizes. Switching converts them.",
    },
    { kind: "number", key: "pageWidth", label: "Page width", default: 8.5, min: 1, max: 1000, step: 0.01, modes: inPrint, stage: "halftone", visibleWhen: (e) => e.pageSize === "custom" },
    { kind: "number", key: "pageHeight", label: "Page height", default: 11, min: 1, max: 1000, step: 0.01, modes: inPrint, stage: "halftone", visibleWhen: (e) => e.pageSize === "custom" },
    {
      kind: "select",
      key: "orientation",
      label: "Orientation",
      default: "portrait",
      display: "segmented",
      modes: inPrint,
      stage: "halftone",
      options: [
        { value: "portrait", label: "Portrait" },
        { value: "landscape", label: "Landscape" },
      ],
      visibleWhen: (e) => e.pageSize !== "image",
    },
    {
      kind: "select",
      key: "placement",
      label: "Image placement",
      default: "fit",
      display: "segmented",
      modes: inPrint,
      stage: "halftone",
      options: [
        { value: "fit", label: "Fit" },
        { value: "fill", label: "Fill" },
        { value: "custom", label: "Custom" },
      ],
      help: "Fit: as large as possible inside the margins. Fill: covers the whole page (and bleed), cropping the image. Custom: set the width and position.",
      visibleWhen: (e) => e.pageSize !== "image",
    },
    {
      kind: "number",
      key: "imageWidth",
      label: "Image width",
      default: 6,
      min: 0.1,
      max: 1000,
      step: 0.01,
      modes: inPrint,
      stage: "halftone",
      help: "Width of the artwork (image plus any border), in the units above.",
      visibleWhen: (e) => e.pageSize === "image" || e.placement === "custom",
    },
    { kind: "number", key: "positionX", label: "Position across", default: 50, min: 0, max: 100, step: 0.5, unit: "%", modes: inPrint, stage: "halftone", visibleWhen: (e) => e.pageSize !== "image" && e.placement === "custom" },
    { kind: "number", key: "positionY", label: "Position down", default: 50, min: 0, max: 100, step: 0.5, unit: "%", modes: inPrint, stage: "halftone", visibleWhen: (e) => e.pageSize !== "image" && e.placement === "custom" },
    // Margins and bleed are stored once per unit (each with a range that suits
    // it); switching Units converts between them (ui/sections/export.ts).
    {
      kind: "number",
      key: "margin",
      label: "Margins",
      default: 5,
      min: 0,
      max: 50,
      step: 0.5,
      unit: "mm",
      modes: inPrint,
      stage: "halftone",
      help: MARGIN_HELP,
      visibleWhen: (e) => e.pageSize !== "image" && e.units === "mm",
    },
    {
      kind: "number",
      key: "marginIn",
      label: "Margins",
      default: 0.2,
      min: 0,
      max: 2,
      step: 0.01,
      unit: "in",
      modes: inPrint,
      stage: "halftone",
      help: MARGIN_HELP,
      visibleWhen: (e) => e.pageSize !== "image" && e.units !== "mm",
    },
    {
      kind: "number",
      key: "bleed",
      label: "Bleed",
      default: 0,
      min: 0,
      max: 10,
      step: 0.5,
      unit: "mm",
      modes: inPrint,
      stage: "halftone",
      help: BLEED_HELP,
      visibleWhen: (e) => e.pageSize !== "image" && e.units === "mm",
    },
    {
      kind: "number",
      key: "bleedIn",
      label: "Bleed",
      default: 0,
      min: 0,
      max: 0.4,
      step: 0.01,
      unit: "in",
      modes: inPrint,
      stage: "halftone",
      help: BLEED_HELP,
      visibleWhen: (e) => e.pageSize !== "image" && e.units !== "mm",
    },
    {
      kind: "select",
      key: "dpiPreset",
      label: "Resolution",
      default: "600",
      display: "segmented",
      modes: inPrint,
      stage: "halftone",
      options: [
        { value: "300", label: "300 DPI" },
        { value: "600", label: "600 DPI" },
        { value: "1200", label: "1200 DPI" },
        { value: "custom", label: "Custom" },
      ],
      help: "Riso machines print at 600 DPI.",
    },
    {
      kind: "number",
      key: "dpi",
      label: "Custom resolution",
      stage: "halftone",
      default: 600,
      min: 150,
      max: 1200,
      step: 50,
      unit: "DPI",
      modes: inPrint,
      visibleWhen: (e) => e.dpiPreset === "custom",
    },
    {
      kind: "select",
      key: "fileFormat",
      label: "File format",
      default: "png",
      display: "segmented",
      modes: inPrint,
      stage: null,
      options: [
        { value: "png", label: "PNG" },
        { value: "pdf", label: "PDF" },
      ],
      help: "Riso PDF: one page per layer.",
    },
    { kind: "toggle", key: "cropMarks", label: "Crop marks", default: false, modes: inPrint, stage: null, help: "Where to trim, at the artwork's corners (the page's with Fill)." },
    { kind: "toggle", key: "regMarks", label: "Registration marks", default: false, modes: inPrint, stage: null, help: "Targets on every layer for lining the inks up.", visibleWhen: (e) => e.printTarget === "riso" },
    { kind: "toggle", key: "layerLabels", label: "Layer labels", default: false, modes: inPrint, stage: null, help: "Project name, ink and print order in the bottom margin of each layer.", visibleWhen: (e) => e.printTarget === "riso" },
    { kind: "toggle", key: "includeProof", label: "Composite proof", default: true, modes: inPrint, stage: null, help: "A color preview of the whole page (150 DPI), added to the zip.", visibleWhen: (e) => e.printTarget === "riso" },
    { kind: "toggle", key: "includeSheet", label: "Print sheet", default: true, modes: inPrint, stage: null, help: "A page listing the inks, print order and settings, added to the zip.", visibleWhen: (e) => e.printTarget === "riso" },
    {
      kind: "toggle",
      key: "gainCompensation",
      label: "Dot gain compensation",
      default: false,
      modes: inPrint,
      stage: "printSim",
      help: "Shrinks dots in the riso layers so they print at the intended size after the ink spreads. Uses the Dot gain settings in Print Simulation.",
      visibleWhen: (e) => e.printTarget === "riso",
    },

    // ---- Both modes ----
    {
      kind: "toggle",
      key: "embedProfile",
      label: "Embed sRGB profile",
      default: true,
      stage: null,
      help: "Tags color files as sRGB so other apps show the colors as intended.",
      // Riso layers are grayscale: only the color proof would carry it.
      visibleWhen: (e, s) => s.upload?.mode !== "print" || e.printTarget === "standard" || e.includeProof === true,
    },
  ],
});

/** The resolution in DPI (a preset, or the custom value). */
export function exportDpi(e: { dpiPreset: string; dpi: number }): number {
  return e.dpiPreset === "custom" ? e.dpi : Number(e.dpiPreset);
}

/** Margins and bleed in mm, from whichever unit is in use. */
export function exportMarginMm(e: { units: string; margin: number; marginIn: number }): number {
  return e.units === "mm" ? e.margin : e.marginIn * 25.4;
}
export function exportBleedMm(e: { units: string; bleed: number; bleedIn: number }): number {
  return e.units === "mm" ? e.bleed : e.bleedIn * 25.4;
}
