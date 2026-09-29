// Cached overlap table: rebuilt only when the paper color, ink colors, ink
// opacity, ink count, or print order change. Everything else reuses the
// previous table.

import type { ProjectSettings } from "../../schema/sections";
import { buildOverlapTable, type InkSpec, type OverlapTable } from "./inkModel";

export interface InkSetup {
  paper: string;
  /** In print order. */
  inks: InkSpec[];
}

/** The part of the project settings the ink model depends on. */
export function inkSetupFrom(settings: ProjectSettings): InkSetup {
  const { paper, inkCount, inkColor, inkOpacity } = settings.palette;
  const inks: InkSpec[] = [];
  for (let i = 0; i < inkCount; i++) {
    inks.push({ hex: inkColor[i] ?? "#000000", opacity: (inkOpacity[i] ?? 0) / 100 });
  }
  return { paper, inks };
}

function keyOf(setup: InkSetup): string {
  return `${setup.paper}|${setup.inks.map((i) => `${i.hex}:${i.opacity}`).join("|")}`;
}

export class OverlapTableCache {
  private key = "";
  private table: OverlapTable | null = null;
  /** Number of times the table has been rebuilt (shown in the debug log). */
  rebuilds = 0;

  get(setup: InkSetup): OverlapTable {
    const key = keyOf(setup);
    if (!this.table || key !== this.key) {
      this.table = buildOverlapTable(setup.paper, setup.inks);
      this.key = key;
      this.rebuilds++;
    }
    return this.table;
  }
}
