// Print mode page view, drawn on a 2D canvas over the preview: the sheet
// around the artwork (in the paper color), the page edge, the trim line when
// there is bleed, the non-printable margin as a dashed guide, and the
// printer's marks. Positions come from the export layout (output px), mapped
// through the image's place on the page to the current view.

import type { OutputLayout } from "../../app/layout";
import type { MarkShape } from "../../export/marks";
import type { ViewTransform } from "./viewRenderer";

export interface PageView {
  layout: OutputLayout;
  marks: MarkShape[];
  /** CSS color of the sheet. */
  paper: string;
}

/** The page's extent in image px (for fitting the view). */
export function pageBounds(p: PageView): { x0: number; y0: number; x1: number; y1: number } {
  const L = p.layout;
  return { x0: -L.imageX / L.scale, y0: -L.imageY / L.scale, x1: (L.width - L.imageX) / L.scale, y1: (L.height - L.imageY) / L.scale };
}

export function drawPage(ctx: CanvasRenderingContext2D, p: PageView, view: ViewTransform, dpr: number): void {
  const L = p.layout;
  const k = view.scale / L.scale; // device px per output px
  const sx = (x: number) => view.originX + (x - L.imageX) * k;
  const sy = (y: number) => view.originY + (y - L.imageY) * k;
  const rect = (r: { x: number; y: number; width: number; height: number }) => [sx(r.x), sy(r.y), r.width * k, r.height * k] as const;

  // The sheet around the artwork.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.18)";
  ctx.shadowBlur = 12 * dpr;
  ctx.shadowOffsetY = 2 * dpr;
  ctx.fillStyle = p.paper;
  const page = rect({ x: 0, y: 0, width: L.width, height: L.height });
  ctx.beginPath();
  ctx.rect(...page);
  const art = rect(L.art);
  ctx.rect(art[0] + art[2], art[1], -art[2], art[3]); // reversed: a hole where the artwork is
  ctx.fill("evenodd");
  ctx.restore();

  ctx.lineWidth = 1 * dpr;
  if (L.trim.x > 0.5) {
    ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
    ctx.setLineDash([2 * dpr, 3 * dpr]);
    ctx.strokeRect(...rect(L.trim));
  }
  if (L.printable) {
    ctx.strokeStyle = "rgba(210, 60, 50, 0.85)";
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.strokeRect(...rect(L.printable));
  }
  ctx.setLineDash([]);

  // Marks, in black.
  const stroke = Math.max(1, (0.2 / 25.4) * (L.dpi ?? 300) * k);
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#000";
  ctx.lineWidth = stroke;
  let labelShown = false;
  for (const m of p.marks) {
    if (m.kind === "line") {
      ctx.beginPath();
      ctx.moveTo(sx(m.x0), sy(m.y0));
      ctx.lineTo(sx(m.x1), sy(m.y1));
      ctx.stroke();
    } else if (m.kind === "target") {
      const r = m.r * k;
      const c = [sx(m.cx), sy(m.cy)] as const;
      ctx.beginPath();
      ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
      ctx.moveTo(c[0] - r * 1.5, c[1]);
      ctx.lineTo(c[0] + r * 1.5, c[1]);
      ctx.moveTo(c[0], c[1] - r * 1.5);
      ctx.lineTo(c[0], c[1] + r * 1.5);
      ctx.stroke();
    } else if (!labelShown) {
      // Every layer has its own label in the same place; show the first.
      labelShown = true;
      ctx.font = `${Math.max(1, m.size * k)}px system-ui, sans-serif`;
      ctx.fillText(m.text, sx(m.x), sy(m.y));
    }
  }
}
