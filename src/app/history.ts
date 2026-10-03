// Undo and redo for settings.
//
// Every finished change (a slider released, an option picked: commit = true)
// is one step. Changes that follow from it straight away, such as a color
// scheme regenerating every ink, a unit switch converting several lengths, or
// a new ink joining linked sliders, are grouped into the same step. Dragging
// (commit = false) is never a step by itself: the step runs from where the
// drag started to where it ended.
//
// A step stores the whole settings object from before it. Settings are
// updated immutably (new objects only along the changed path), so snapshots
// share almost everything and cost little.
//
// The image is not part of history. Changes that come with uploading one
// (the project name following the file, an Auto palette picking colors) are
// folded into the starting point instead of becoming a step (silently()).

import type { ProjectSettings } from "../schema/sections";
import type { SettingsStore } from "./store";

/** Steps kept; the oldest are dropped. */
const LIMIT = 200;

export type HistoryListener = () => void;

export class History {
  private undoStack: ProjectSettings[] = [];
  private redoStack: ProjectSettings[] = [];
  /** The settings after the last step (what the next step starts from). */
  private baseline: ProjectSettings;
  /** An open step: the settings from before it, until it closes. */
  private pending: { before: ProjectSettings; timer: ReturnType<typeof setTimeout> } | null = null;
  private quiet = 0;
  private restoring = false;
  private listeners = new Set<HistoryListener>();

  constructor(private store: SettingsStore) {
    this.baseline = store.get();
    store.subscribe((_, change) => {
      if (this.restoring || !change.commit) return;
      if (this.quiet > 0) {
        this.baseline = store.get();
        return;
      }
      // The step stays open until the follow-up changes (same task, and microtasks
      // queued by listeners) are done.
      if (!this.pending) this.pending = { before: this.baseline, timer: setTimeout(() => this.close(), 0) };
    });
  }

  /** Records the open step, if it changed anything. */
  private close(): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    const after = this.store.get();
    this.baseline = after;
    if (same(p.before, after)) return;
    this.undoStack.push(p.before);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.notify();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.pending !== null;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    this.close();
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.store.get());
    this.restore(previous);
  }

  redo(): void {
    this.close();
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.store.get());
    this.restore(next);
  }

  /** Runs fn without recording a step: its changes become part of the starting point. */
  silently(fn: () => void): void {
    this.quiet++;
    try {
      fn();
    } finally {
      this.quiet--;
      this.baseline = this.store.get();
    }
  }

  subscribe(listener: HistoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private restore(settings: ProjectSettings): void {
    this.restoring = true;
    try {
      this.store.replace(settings);
    } finally {
      this.restoring = false;
    }
    this.baseline = settings;
    this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

function same(a: ProjectSettings, b: ProjectSettings): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
