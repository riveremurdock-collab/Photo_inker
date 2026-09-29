// Popover opened from a color swatch: a grid of named presets plus a custom
// color picker and hex field. Only one popover is open at a time.

import type { NamedColor } from "../../app/inkLibrary";

export interface SwatchPopoverOptions {
  anchor: HTMLElement;
  title: string;
  presets: readonly NamedColor[];
  current: string;
  /** commit=false while dragging the custom picker. */
  onPick: (hex: string, commit: boolean) => void;
}

let openPopover: { element: HTMLElement; close: () => void } | null = null;

export function closeSwatchPopover(): void {
  openPopover?.close();
}

export function openSwatchPopover(options: SwatchPopoverOptions): void {
  const reopening =
    openPopover !== null &&
    options.anchor.dataset.popoverId !== undefined &&
    openPopover.element.dataset.anchorId === options.anchor.dataset.popoverId;
  closeSwatchPopover();
  if (reopening) return; // clicking the same swatch again just closes it

  const pop = document.createElement("div");
  pop.className = "swatch-popover";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", options.title);
  options.anchor.dataset.popoverId ||= String(Math.random());
  pop.dataset.anchorId = options.anchor.dataset.popoverId;

  const heading = document.createElement("p");
  heading.className = "swatch-popover-title";
  heading.textContent = options.title;
  pop.append(heading);

  const grid = document.createElement("div");
  grid.className = "swatch-grid";
  for (const preset of options.presets) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch-choice";
    b.style.setProperty("--swatch", preset.hex);
    b.title = `${preset.name} ${preset.hex}`;
    b.setAttribute("aria-label", preset.name);
    if (preset.hex === options.current) b.classList.add("current");
    b.addEventListener("click", () => {
      options.onPick(preset.hex, true);
      close();
    });
    grid.append(b);
  }
  pop.append(grid);

  const custom = document.createElement("div");
  custom.className = "swatch-custom";
  const label = document.createElement("span");
  label.textContent = "Custom";
  const picker = document.createElement("input");
  picker.type = "color";
  picker.value = options.current;
  picker.setAttribute("aria-label", "Custom color");
  const hex = document.createElement("input");
  hex.type = "text";
  hex.className = "control-hex";
  hex.maxLength = 7;
  hex.spellcheck = false;
  hex.value = options.current;
  hex.setAttribute("aria-label", "Hex code");
  picker.addEventListener("input", () => {
    hex.value = picker.value;
    options.onPick(picker.value, false);
  });
  picker.addEventListener("change", () => options.onPick(picker.value, true));
  hex.addEventListener("change", () => {
    const v = normalizeHex(hex.value);
    if (v) {
      picker.value = v;
      options.onPick(v, true);
    } else hex.value = picker.value;
  });
  custom.append(label, picker, hex);
  pop.append(custom);

  document.body.append(pop);
  position(pop, options.anchor);

  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!pop.contains(t) && !options.anchor.contains(t)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      options.anchor.focus();
    }
  };
  const onScroll = () => position(pop, options.anchor);
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onScroll);
  document.addEventListener("scroll", onScroll, true);

  function close(): void {
    pop.remove();
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onScroll);
    document.removeEventListener("scroll", onScroll, true);
    if (openPopover?.element === pop) openPopover = null;
  }
  openPopover = { element: pop, close };
  (grid.querySelector("button.current") as HTMLElement | null ?? grid.querySelector("button"))?.focus();
}

function position(pop: HTMLElement, anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = Math.min(a.left, window.innerWidth - w - 8);
  let top = a.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
  left = Math.max(8, left);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

export function normalizeHex(value: string): string | null {
  const v = value.trim().replace(/^#?/, "#").toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}
