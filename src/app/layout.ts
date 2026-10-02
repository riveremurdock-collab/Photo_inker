// Output layout: how big the exported file is, and where the artwork (the
// image plus any border that grows the canvas) sits in it. Used by the export,
// the preview's page view, and everything that needs the output scale (output
// px per image px — halftone sizes are measured in output px).
//
// - Digital: the artwork at 0.5×–3× or a custom width; with the aspect ratio
//   unlocked, a custom width × height with the artwork fitted or filled.
// - Print: a page (preset or custom, portrait or landscape) at the chosen DPI,
//   plus bleed on every side. The artwork is fitted inside the margins,
//   filled over the whole page and bleed, or placed at a custom width and
//   position. "Image only" makes the page exactly the artwork.

import type { ProjectSettings } from "../schema/sections";
import { exportBleedMm, exportDpi, exportMarginMm } from "../schema/exportSection";
import { borderGeometry } from "./border";

export const PAGE_SIZES_MM: Record<string, readonly [number, number]> = {
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
  tabloid: [279.4, 431.8],
  a4: [210, 297],
  a3: [297, 420],
  b4: [257, 364],
};

const MM_PER_IN = 25.4;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OutputLayout {
  kind: "digital" | "print";
  dpi: number | null;
  /** Whole output in px (a print page includes its bleed). */
  width: number;
  height: number;
  /** The page itself (without bleed), output px. Equals the output for Digital. */
  trim: Rect;
  /** Inside the margins (Print with a page), for the preview's guide. */
  printable: Rect | null;
  /** The artwork: image plus any border that grows the canvas. */
  art: Rect;
  /** Where to trim: the artwork's edges, or the page's with Fill. */
  cut: Rect;
  /** Output px per image px, and the image's top-left corner in the output. */
  scale: number;
  imageX: number;
  imageY: number;
}

export function outputLayout(settings: ProjectSettings, imageWidth: number, imageHeight: number): OutputLayout {
  const e = settings.export;
  const border = borderGeometry(settings.border, imageWidth, imageHeight, settings.palette.inkCount).margin;
  // Artwork size in image px.
  const A = imageWidth + 2 * border;
  const B = imageHeight + 2 * border;

  const place = (width: number, height: number, art: Rect, scale: number, extra: Partial<OutputLayout>, kind: "digital" | "print", dpi: number | null): OutputLayout => ({
    kind,
    dpi,
    width,
    height,
    trim: { x: 0, y: 0, width, height },
    printable: null,
    art,
    cut: art,
    scale,
    imageX: art.x + border * scale,
    imageY: art.y + border * scale,
    ...extra,
  });
  const centered = (w: number, h: number, scale: number): Rect => ({ x: (w - A * scale) / 2, y: (h - B * scale) / 2, width: A * scale, height: B * scale });

  if (settings.upload.mode !== "print") {
    if (e.digitalSize === "custom" && !e.lockAspect) {
      const w = Math.max(1, Math.round(e.digitalWidth));
      const h = Math.max(1, Math.round(e.digitalHeight));
      const s = e.digitalFit === "fill" ? Math.max(w / A, h / B) : Math.min(w / A, h / B);
      return place(w, h, centered(w, h, s), s, {}, "digital", null);
    }
    const factor: Record<string, number> = { half: 0.5, original: 1, double: 2, triple: 3 };
    const s = e.digitalSize === "custom" ? Math.max(1, e.digitalWidth) / A : (factor[e.digitalSize] ?? 1);
    const w = Math.max(1, Math.round(A * s));
    const h = Math.max(1, Math.round(B * s));
    return place(w, h, { x: 0, y: 0, width: A * s, height: B * s }, s, {}, "digital", null);
  }

  const dpi = exportDpi(e);
  const toPx = (value: number, unit: "in" | "mm") => (unit === "in" ? value : value / MM_PER_IN) * dpi;
  const units = e.units === "mm" ? "mm" : "in";

  if (e.pageSize === "image") {
    const s = Math.max(1, toPx(e.imageWidth, units)) / A;
    const w = Math.max(1, Math.round(A * s));
    const h = Math.max(1, Math.round(B * s));
    return place(w, h, { x: 0, y: 0, width: A * s, height: B * s }, s, {}, "print", dpi);
  }

  let pw: number;
  let ph: number;
  if (e.pageSize === "custom") {
    pw = toPx(e.pageWidth, units);
    ph = toPx(e.pageHeight, units);
  } else {
    const [a, b] = PAGE_SIZES_MM[e.pageSize] ?? PAGE_SIZES_MM.letter!;
    pw = toPx(a, "mm");
    ph = toPx(b, "mm");
  }
  if ((e.orientation === "landscape") !== pw > ph) [pw, ph] = [ph, pw];
  const bleed = toPx(exportBleedMm(e), "mm");
  const width = Math.max(1, Math.round(pw + 2 * bleed));
  const height = Math.max(1, Math.round(ph + 2 * bleed));
  const trim: Rect = { x: bleed, y: bleed, width: pw, height: ph };
  const m = Math.min(toPx(exportMarginMm(e), "mm"), pw / 2 - 1, ph / 2 - 1);
  const printable: Rect = { x: trim.x + m, y: trim.y + m, width: pw - 2 * m, height: ph - 2 * m };

  let s: number;
  let art: Rect;
  if (e.placement === "fill") {
    s = Math.max(width / A, height / B);
    art = centered(width, height, s);
  } else if (e.placement === "custom") {
    s = Math.max(1, toPx(e.imageWidth, units)) / A;
    art = {
      x: printable.x + ((printable.width - A * s) * e.positionX) / 100,
      y: printable.y + ((printable.height - B * s) * e.positionY) / 100,
      width: A * s,
      height: B * s,
    };
  } else {
    s = Math.max(1e-3, Math.min(printable.width / A, printable.height / B));
    art = { x: printable.x + (printable.width - A * s) / 2, y: printable.y + (printable.height - B * s) / 2, width: A * s, height: B * s };
  }
  return place(width, height, art, s, { trim, printable, cut: e.placement === "fill" ? trim : art }, "print", dpi);
}

/** Output px per image px. */
export function outputScale(settings: ProjectSettings, imageWidth: number, imageHeight: number): number {
  return outputLayout(settings, imageWidth, imageHeight).scale;
}
