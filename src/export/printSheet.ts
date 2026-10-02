// The print sheet: a letter-size page (150 DPI PNG) to keep with a riso job,
// listing the page setup, the inks in print order (swatch, hex, file) and the
// settings that shaped the layers. Setting names and values come from the
// schema, so it stays in step with the panel.

import type { OutputLayout } from "../app/layout";
import { isSettingVisible, slotDefault } from "../schema/registry";
import { SECTIONS, type ProjectSettings } from "../schema/sections";
import type { SectionSchema, SettingDef } from "../schema/types";

const W = 1275;
const H = 1650;

function formatValue(def: SettingDef, value: unknown, inkCount: number): string {
  const one = (v: unknown): string => {
    switch (def.kind) {
      case "number":
        return `${Number(v).toFixed(def.step < 1 ? (def.step < 0.1 ? 2 : 1) : 0)}${def.unit ? (def.unit === "%" || def.unit === "°" ? def.unit : ` ${def.unit}`) : ""}`;
      case "select": {
        const opt = def.options.find((o) => o.value === v);
        if (!opt) return String(v);
        // Grouped options keep their group's short name, e.g. "AM: Square grid".
        const short = opt.group ? /\((\w+)\)/.exec(opt.group)?.[1] : undefined;
        return short ? `${short}: ${opt.label}` : opt.label;
      }
      case "toggle":
        return v ? "on" : "off";
      case "curve": {
        const pts = v as [number, number][];
        return pts.length === 2 && pts[0]![0] === pts[0]![1] && pts[1]![0] === pts[1]![1] ? "straight" : `${pts.length}-point curve`;
      }
      default:
        return String(v);
    }
  };
  return def.perInk ? (value as unknown[]).slice(0, inkCount).map(one).join(" / ") : one(value);
}

/**
 * The visible settings of a section and its visible sub-sections, as "Label: value" lines.
 * Layers is a sub-section of Color Splitting but has its own column (describeLayers).
 */
function describe(settings: ProjectSettings, parentId: string): string[] {
  const values = settings as unknown as Record<string, Record<string, unknown>>;
  const n = settings.palette.inkCount;
  const lines: string[] = [];
  const add = (section: SectionSchema) => {
    for (const def of section.settings) {
      if (def.hidden || def.kind === "seed" || !isSettingVisible(def, settings, section.id)) continue;
      lines.push(`${def.label}: ${formatValue(def, values[section.id]![def.key], n)}`);
    }
  };
  for (const s of SECTIONS as readonly SectionSchema[]) {
    if (s.id === parentId) add(s);
    else if (s.parent === parentId && s.id !== "layers" && (!s.visibleWhen || s.visibleWhen(values))) add(s);
  }
  return lines;
}

/**
 * Layer options: the total ink limit, plus each per-ink option (edited in the
 * Layers block, so hidden from generated controls) that any ink has changed.
 * Solo and mute only affect the preview and are left out.
 */
function describeLayers(settings: ProjectSettings): string[] {
  const section = (SECTIONS as readonly SectionSchema[]).find((s) => s.id === "layers")!;
  const values = (settings as unknown as Record<string, Record<string, unknown>>).layers!;
  const n = settings.palette.inkCount;
  const lines: string[] = [];
  for (const def of section.settings) {
    if (def.stage === "mix") continue;
    const value = values[def.key];
    if (!def.perInk) {
      lines.push(`${def.label}: ${formatValue(def, value, n)}`);
      continue;
    }
    const slots = (value as unknown[]).slice(0, n);
    if (slots.some((v, i) => JSON.stringify(v) !== JSON.stringify(slotDefault(def, i)))) lines.push(`${def.label}: ${formatValue(def, value, n)}`);
  }
  return lines;
}

export async function printSheet(settings: ProjectSettings, layout: OutputLayout, layerFiles: string[], imageName: string): Promise<Blob> {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  const x0 = 90;
  let y = 110;
  const text = (s: string, size: number, weight = "normal", color = "#222", x = x0) => {
    ctx.font = `${weight} ${size}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  };

  text(settings.upload.projectName || "Photo Inker", 40, "bold");
  y += 38;
  text(`Riso print sheet · ${new Date().toLocaleDateString()}`, 22, "normal", "#666");
  y += 60;

  const dpi = layout.dpi ?? 600;
  const inch = (px: number) => `${(px / dpi).toFixed(2)} in (${((px / dpi) * 25.4).toFixed(1)} mm)`;
  const e = settings.export;
  const pageLabel = findLabel("export", "pageSize", e.pageSize);
  const lines = [
    `Page: ${pageLabel}${e.pageSize === "image" ? "" : `, ${e.orientation}`} · ${layout.width} × ${layout.height} px at ${dpi} DPI`,
    `Artwork: ${inch(layout.art.width)} × ${inch(layout.art.height)}, ${(layout.art.x / dpi).toFixed(2)} in from the left, ${(layout.art.y / dpi).toFixed(2)} in from the top`,
    e.pageSize === "image" ? "" : `Placement: ${e.placement} · margins ${e.units === "mm" ? `${e.margin} mm` : `${e.marginIn} in`} · bleed ${e.units === "mm" ? `${e.bleed} mm` : `${e.bleedIn} in`}`,
    `Marks: ${[e.cropMarks && "crop", e.regMarks && "registration", e.layerLabels && "labels"].filter(Boolean).join(", ") || "none"}`,
    `Source image: ${imageName}`,
  ].filter(Boolean);
  for (const l of lines) {
    text(l, 22);
    y += 34;
  }

  y += 30;
  text("Inks, in print order", 28, "bold");
  y += 20;
  const n = settings.palette.inkCount;
  for (let i = 0; i < n; i++) {
    y += 56;
    const hex = (settings.palette.inkColor[i] ?? "#000000").toUpperCase();
    ctx.fillStyle = hex;
    ctx.fillRect(x0, y - 36, 64, 44);
    ctx.strokeStyle = "#999";
    ctx.strokeRect(x0 + 0.5, y - 35.5, 63, 43);
    text(`${i + 1}.  ${hex}`, 26, "bold", "#222", x0 + 90);
    text(layerFiles[i] ?? "", 20, "normal", "#555", x0 + 330);
  }
  y += 40;
  text(`Paper: ${settings.palette.paper.toUpperCase()}`, 22);
  y += 60;

  const column = (title: string, entries: string[]) => {
    text(title, 26, "bold");
    y += 36;
    for (const l of entries) {
      if (y > H - 60) return;
      text(l, 19, "normal", "#333");
      y += 28;
    }
    y += 24;
  };
  column("Color splitting", describe(settings, "split"));
  column("Halftone", describe(settings, "halftone"));
  column("Layers", describeLayers(settings));
  return canvas.convertToBlob({ type: "image/png" });
}

function findLabel(sectionId: string, key: string, value: string): string {
  const s = (SECTIONS as readonly SectionSchema[]).find((x) => x.id === sectionId);
  const def = s?.settings.find((d) => d.key === key);
  return def?.kind === "select" ? (def.options.find((o) => o.value === value)?.label ?? value) : value;
}
