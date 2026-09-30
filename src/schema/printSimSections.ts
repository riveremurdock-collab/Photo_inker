// Print Simulation settings: a master switch and one sub-section per effect.
// The effects act on the ink layers before they are mixed. They show in the
// preview in both modes, are baked into Digital exports, and never reach riso
// layer exports (dot gain compensation, an Export setting, is the exception:
// it uses the Dot gain settings below).

import { defineSection } from "./types";

export const printSimSection = defineSection({
  id: "printSim",
  title: "Print Simulation",
  stage: "printSim",
  settings: [
    {
      kind: "toggle",
      key: "enabled",
      label: "Simulate printing",
      default: false,
      help: "Preview how the print will really look. Baked into Digital exports; never added to riso layers.",
    },
  ],
});

export const simMisregSection = defineSection({
  id: "simMisreg",
  title: "Layer misregistration",
  stage: "printSim",
  parent: "printSim",
  description: "Each ink layer lands slightly off from the others.",
  settings: [
    { kind: "toggle", key: "on", label: "Misregistration", default: true },
    {
      kind: "number",
      key: "shift",
      label: "Shift",
      default: 3,
      min: 0,
      max: 40,
      step: 0.5,
      unit: "px",
      help: "Largest random offset of a layer, in output pixels (about 1 mm is 24 px at 600 DPI).",
      visibleWhen: (s) => s.on === true,
    },
    {
      kind: "number",
      key: "rotation",
      label: "Rotation",
      default: 0.05,
      min: 0,
      max: 1,
      step: 0.01,
      unit: "°",
      help: "Largest random rotation of a layer, around the image center.",
      visibleWhen: (s) => s.on === true,
    },
    { kind: "seed", key: "seed", label: "Random seed", default: 1, visibleWhen: (s) => s.on === true },
  ],
});

export const simLowInkSection = defineSection({
  id: "simLowInk",
  title: "Low-ink patches",
  stage: "printSim",
  parent: "printSim",
  description: "Patches where the drum runs short of ink and the print goes grainy and light, mostly in big solid areas.",
  settings: [
    { kind: "toggle", key: "on", label: "Low-ink patches", default: true },
    { kind: "number", key: "intensity", label: "Intensity", default: 35, min: 0, max: 100, step: 1, unit: "%", help: "How much ink is lost inside a patch.", visibleWhen: (s) => s.on === true },
    { kind: "number", key: "size", label: "Patch size", default: 15, min: 2, max: 60, step: 0.5, unit: "%", help: "% of the image's shorter side.", visibleWhen: (s) => s.on === true },
    {
      kind: "select",
      key: "shape",
      label: "Patch shape",
      default: "fractal",
      display: "segmented",
      options: [
        { value: "fractal", label: "Blotches" },
        { value: "streaks", label: "Drum streaks" },
        { value: "edge", label: "Edge fade" },
      ],
      visibleWhen: (s) => s.on === true,
    },
    { kind: "number", key: "detail", label: "Detail", default: 4, min: 1, max: 6, step: 1, help: "Layers of noise: more gives more intricate edges.", visibleWhen: (s) => s.on === true && s.shape === "fractal" },
    { kind: "number", key: "roughness", label: "Roughness", default: 50, min: 0, max: 100, step: 1, unit: "%", visibleWhen: (s) => s.on === true && s.shape === "fractal" },
    {
      kind: "number",
      key: "direction",
      label: "Feed direction",
      default: 90,
      min: 0,
      max: 180,
      step: 1,
      unit: "°",
      help: "Direction the paper travels: streaks run this way (90° = top to bottom).",
      visibleWhen: (s) => s.on === true && s.shape === "streaks",
    },
    { kind: "number", key: "streakLength", label: "Streak length", default: 8, min: 1, max: 30, step: 0.5, unit: "×", help: "How much longer streaks are than they are wide.", visibleWhen: (s) => s.on === true && s.shape === "streaks" },
    { kind: "number", key: "frequency", label: "Streak frequency", default: 1.5, min: 0.25, max: 6, step: 0.25, unit: "×", visibleWhen: (s) => s.on === true && s.shape === "streaks" },
    {
      kind: "select",
      key: "side",
      label: "Thin side",
      default: "right",
      display: "segmented",
      options: [
        { value: "top", label: "Top" },
        { value: "bottom", label: "Bottom" },
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
      ],
      visibleWhen: (s) => s.on === true && s.shape === "edge",
    },
    { kind: "number", key: "falloff", label: "Falloff distance", default: 40, min: 5, max: 100, step: 1, unit: "%", help: "% of the image width or height.", visibleWhen: (s) => s.on === true && s.shape === "edge" },
    {
      kind: "number",
      key: "influence",
      label: "Coverage influence",
      default: 70,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      help: "How strongly patches are drawn to heavily inked areas.",
      visibleWhen: (s) => s.on === true,
    },
    { kind: "number", key: "softness", label: "Edge softness", default: 40, min: 0, max: 100, step: 1, unit: "%", visibleWhen: (s) => s.on === true },
    { kind: "toggle", key: "shared", label: "Same patches on every ink", default: false, visibleWhen: (s) => s.on === true },
    { kind: "seed", key: "seed", label: "Random seed", default: 1, visibleWhen: (s) => s.on === true },
  ],
});

export const simSpecksSection = defineSection({
  id: "simSpecks",
  title: "Specks",
  stage: "printSim",
  parent: "printSim",
  description: "Small spots of stray ink, and pinholes where ink is missing.",
  settings: [
    { kind: "toggle", key: "on", label: "Specks", default: true },
    { kind: "toggle", key: "ink", label: "Specks on", perInk: true, default: true, visibleWhen: (s) => s.on === true },
    { kind: "number", key: "density", label: "Density", default: 30, min: 0, max: 500, step: 1, unit: "/MP", help: "Specks per million output pixels.", visibleWhen: (s) => s.on === true },
    { kind: "number", key: "minSize", label: "Smallest speck", default: 2, min: 1, max: 30, step: 0.5, unit: "px", visibleWhen: (s) => s.on === true },
    { kind: "number", key: "maxSize", label: "Largest speck", default: 6, min: 1, max: 40, step: 0.5, unit: "px", visibleWhen: (s) => s.on === true },
    { kind: "number", key: "extra", label: "Extra ink", default: 40, min: 0, max: 100, step: 1, unit: "%", help: "Share of specks that add ink; the rest are pinholes (which only show inside ink).", visibleWhen: (s) => s.on === true },
    { kind: "number", key: "clumping", label: "Clumping", default: 30, min: 0, max: 100, step: 1, unit: "%", help: "0 = scattered evenly; higher = grouped together.", visibleWhen: (s) => s.on === true },
    {
      kind: "select",
      key: "placement",
      label: "Extra ink appears",
      default: "near",
      display: "segmented",
      options: [
        { value: "near", label: "Near ink" },
        { value: "anywhere", label: "Anywhere" },
      ],
      visibleWhen: (s) => s.on === true,
    },
    { kind: "number", key: "opacity", label: "Opacity", default: 100, min: 0, max: 100, step: 1, unit: "%", help: "Lower = patchier, broken-up specks.", visibleWhen: (s) => s.on === true },
    { kind: "seed", key: "seed", label: "Random seed", default: 1, visibleWhen: (s) => s.on === true },
  ],
});

export const simGainSection = defineSection({
  id: "simGain",
  title: "Dot gain",
  stage: "printSim",
  parent: "printSim",
  description: "Ink spreads into the paper, so dots print larger and darker. Also used by dot gain compensation (Export, Print mode).",
  settings: [
    { kind: "toggle", key: "on", label: "Dot gain", default: true },
    { kind: "number", key: "amount", label: "Gain at 50%", perInk: true, default: 12, min: 0, max: 40, step: 0.5, unit: "%", help: "How much darker a 50% tone prints (12% → prints as 62%)." },
    {
      kind: "select",
      key: "curve",
      label: "Gain curve",
      default: "midtone",
      display: "segmented",
      options: [
        { value: "midtone", label: "Midtone-weighted" },
        { value: "uniform", label: "Uniform" },
      ],
      help: "Real gain is strongest in the midtones.",
    },
    {
      kind: "select",
      key: "paper",
      label: "Paper absorbency",
      default: "uncoated",
      display: "segmented",
      options: [
        { value: "smooth", label: "Smooth" },
        { value: "uncoated", label: "Uncoated" },
        { value: "recycled", label: "Recycled" },
      ],
      help: "Scales the gain: smooth ×0.6, uncoated ×1, recycled ×1.4.",
    },
    { kind: "number", key: "roughness", label: "Edge roughness", default: 30, min: 0, max: 100, step: 1, unit: "%", help: "How ragged dot edges become." },
  ],
});

export const PRINT_SIM_SECTIONS = [printSimSection, simMisregSection, simLowInkSection, simSpecksSection, simGainSection] as const;
