// Point curve editor. Click empty space to add a point, drag points to move
// them, double-click a point (or drag it off the top/bottom) to remove it.
// The end points stay at x = 0 and x = 1 but can move up and down.
// Dragging previews (commit=false); releasing commits.

import { sampleCurve, type CurvePoint } from "../../util/curve";

const HIT_RADIUS = 10; // CSS px
const REMOVE_DISTANCE = 28; // CSS px outside the box removes a middle point

export interface CurveEditor {
  element: HTMLElement;
  update(points: readonly CurvePoint[]): void;
}

export function createCurveEditor(
  label: string,
  initial: readonly CurvePoint[],
  onChange: (points: [number, number][], commit: boolean) => void,
): CurveEditor {
  const element = document.createElement("div");
  element.className = "curve-editor";
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `${label} editor`);
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset";
  reset.className = "curve-reset";
  element.append(canvas, reset);

  let points: [number, number][] = initial.map(([x, y]) => [x, y]);
  let dragging: number | null = null;
  let removing = false;

  const size = () => {
    const w = Math.max(120, element.clientWidth || 240);
    return { w, h: Math.round(w * 0.62) };
  };

  function draw(): void {
    const { w, h } = size();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#fafbf8";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#dfe6d6";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo((w * i) / 4 + 0.5, 0);
      ctx.lineTo((w * i) / 4 + 0.5, h);
      ctx.moveTo(0, (h * i) / 4 + 0.5);
      ctx.lineTo(w, (h * i) / 4 + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = "#c5ccb8";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    const samples = sampleCurve(points, Math.max(64, Math.round(w)));
    ctx.strokeStyle = "#1c1c1c";
    ctx.lineWidth = 2;
    ctx.beginPath();
    samples.forEach((y, i) => {
      const px = (i / (samples.length - 1)) * w;
      const py = (1 - y) * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    points.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x * w, (1 - y) * h, 5, 0, Math.PI * 2);
      ctx.fillStyle = i === dragging ? (removing ? "#a3261b" : "#f78f28") : "#fff";
      ctx.fill();
      ctx.strokeStyle = "#1c1c1c";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    element.classList.toggle("is-default", isIdentity(points));
  }

  const toCurve = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height, px: e.clientX - r.left, py: e.clientY - r.top, r };
  };

  const nearest = (px: number, py: number, r: DOMRect) => {
    let best = -1;
    let bestD = HIT_RADIUS;
    points.forEach(([x, y], i) => {
      const d = Math.hypot(x * r.width - px, (1 - y) * r.height - py);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const emit = (commit: boolean) => onChange(points.map(([x, y]) => [x, y]), commit);

  canvas.addEventListener("pointerdown", (e) => {
    const p = toCurve(e);
    let i = nearest(p.px, p.py, p.r);
    if (i < 0) {
      const x = Math.min(0.99, Math.max(0.01, p.x));
      points.push([x, Math.min(1, Math.max(0, p.y))]);
      points.sort((a, b) => a[0] - b[0]);
      i = points.findIndex((q) => q[0] === x);
      emit(false);
    }
    dragging = i;
    canvas.setPointerCapture(e.pointerId);
    draw();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (dragging === null) {
      const p = toCurve(e);
      canvas.style.cursor = nearest(p.px, p.py, p.r) >= 0 ? "grab" : "crosshair";
      return;
    }
    const p = toCurve(e);
    const i = dragging;
    const isEnd = i === 0 || i === points.length - 1;
    const outside = p.py < -REMOVE_DISTANCE || p.py > p.r.height + REMOVE_DISTANCE;
    removing = !isEnd && outside;
    const prev = points[i - 1];
    const next = points[i + 1];
    const x = isEnd ? points[i]![0] : Math.min((next?.[0] ?? 1) - 0.01, Math.max((prev?.[0] ?? 0) + 0.01, p.x));
    points[i] = [x, Math.min(1, Math.max(0, p.y))];
    emit(false);
    draw();
  });

  const end = () => {
    if (dragging === null) return;
    if (removing) points.splice(dragging, 1);
    dragging = null;
    removing = false;
    emit(true);
    draw();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  canvas.addEventListener("dblclick", (e) => {
    const p = toCurve(e as unknown as PointerEvent);
    const i = nearest(p.px, p.py, p.r);
    if (i > 0 && i < points.length - 1) {
      points.splice(i, 1);
      emit(true);
      draw();
    }
  });

  reset.addEventListener("click", () => {
    points = [
      [0, 0],
      [1, 1],
    ];
    emit(true);
    draw();
  });

  new ResizeObserver(() => draw()).observe(element);
  draw();

  return {
    element,
    update(next) {
      if (dragging !== null) return;
      points = next.map(([x, y]) => [x, y]);
      draw();
    },
  };
}

function isIdentity(points: readonly CurvePoint[]): boolean {
  return points.length === 2 && points[0]![0] === 0 && points[0]![1] === 0 && points[1]![0] === 1 && points[1]![1] === 1;
}
