// Channel Split custom block: per-channel routing (ink, intensity, opacity)
// and the advanced mixer matrix. Channel names follow the chosen color space.

import type { SettingsStore } from "../../app/store";
import { MAX_INKS } from "../../pipeline/coverage";
import { channelNames, MAX_CHANNELS } from "../../plugins/splitting/channelSplit";
import { findSetting } from "../../schema/registry";
import { createControl, type Control } from "../controls/controls";

export function createChannelSplitBlock(store: SettingsStore): HTMLElement {
  const element = document.createElement("div");
  element.className = "channel-block";
  const advancedControl = createControl(findSetting("splitChannel", "advanced")!, false, (v) => setAdvanced(Boolean(v)));
  const body = document.createElement("div");
  body.className = "channel-body";
  element.append(body, advancedControl.element);

  const get = (key: string) => store.getValue("splitChannel", key);
  const set = (key: string, value: unknown, commit = true) => store.setValue("splitChannel", key, value, { commit });

  let signature = "";
  let controls: { key: string; control: Control }[] = [];

  function inkLabel(i: number): string {
    return `Ink ${i + 1} · ${(store.get().palette.inkColor[i] ?? "").toUpperCase()}`;
  }

  /** Turning the matrix on starts it from the current routing, so the image doesn't jump. */
  function setAdvanced(on: boolean): void {
    if (on) {
      for (let i = 0; i < MAX_INKS; i++) {
        for (let c = 0; c < MAX_CHANNELS; c++) {
          const routed = String(get(`ch${c}Ink`)) === String(i);
          const weight = routed ? (Number(get(`ch${c}Intensity`)) / 100) * (Number(get(`ch${c}Opacity`)) / 100) : 0;
          set(`m${i}_${c}`, Math.round(weight * 100) / 100);
        }
        set(`m${i}_offset`, 0);
      }
    }
    set("advanced", on);
  }

  function build(): void {
    const { splitChannel, palette } = store.get() as unknown as { splitChannel: Record<string, unknown>; palette: { inkCount: number } };
    body.innerHTML = "";
    controls = [];
    const names = channelNames(String(splitChannel.space), Boolean(splitChannel.splitSigned));
    const add = (parent: HTMLElement, key: string, label: string) => {
      const def = findSetting("splitChannel", key)!;
      const control = createControl({ ...def, help: undefined } as never, get(key), (v, commit) => set(key, v, commit), label);
      parent.append(control.element);
      controls.push({ key, control });
    };

    if (!splitChannel.advanced) {
      names.forEach((name, c) => {
        const card = document.createElement("div");
        card.className = "channel-card";
        const title = document.createElement("h4");
        title.textContent = name;
        card.append(title);
        // Ink choice, labelled with the current ink colors.
        const inkKey = `ch${c}Ink`;
        const row = document.createElement("label");
        row.className = "control";
        row.innerHTML = `<span class="control-label">Goes to</span>`;
        const select = document.createElement("select");
        select.innerHTML =
          `<option value="none">Dropped</option>` +
          Array.from({ length: palette.inkCount }, (_, i) => `<option value="${i}">${inkLabel(i)}</option>`).join("");
        // A channel sent to an ink the palette doesn't have (e.g. Black with 3 inks) prints nowhere: show it as Dropped.
        const show = (v: unknown) => {
          select.value = String(v);
          if (select.value !== String(v)) select.value = "none";
        };
        show(get(inkKey));
        select.addEventListener("change", () => set(inkKey, select.value));
        row.append(select);
        card.append(row);
        controls.push({ key: inkKey, control: { element: row, update: show } });
        add(card, `ch${c}Intensity`, "Intensity");
        add(card, `ch${c}Opacity`, "Opacity");
        body.append(card);
      });
      return;
    }

    const help = document.createElement("p");
    help.className = "control-help";
    help.textContent = "Each ink = the sum of every channel times its weight, plus an offset.";
    body.append(help);
    for (let i = 0; i < palette.inkCount; i++) {
      const card = document.createElement("div");
      card.className = "channel-card";
      const title = document.createElement("h4");
      title.textContent = inkLabel(i);
      card.append(title);
      names.forEach((name, c) => add(card, `m${i}_${c}`, name));
      add(card, `m${i}_offset`, "Offset");
      body.append(card);
    }
  }

  function refresh(): void {
    const s = store.get() as unknown as { splitChannel: Record<string, unknown>; palette: { inkCount: number; inkColor: string[] } };
    advancedControl.update(Boolean(s.splitChannel.advanced));
    const next = [s.splitChannel.space, s.splitChannel.splitSigned, s.splitChannel.advanced, s.palette.inkCount, s.palette.inkColor.join()].join("|");
    if (next !== signature) {
      signature = next;
      build();
      return;
    }
    for (const { key, control } of controls) control.update(get(key));
  }

  refresh();
  store.subscribe((_, change) => {
    if (change.section === "splitChannel" || change.section === "palette" || change.section === "*") refresh();
  });
  return element;
}
