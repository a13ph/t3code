import type { EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { readLocalApi } from "../localApi";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import {
  pickSnoozePreset as pickShownSnoozePreset,
  resolveSnoozePresets,
  type SnoozePreset,
} from "./Sidebar.snooze";

/**
 * The `thread.snooze` shortcut's picker: the thread menu's snooze presets as
 * a menu of their own, so a snooze is the shortcut, then an arrow and Enter.
 * Resolves to null when the menu is dismissed.
 */
export async function pickSnoozePreset(
  position: { x: number; y: number },
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
): Promise<Pick<SnoozePreset, "snoozedUntil"> | null> {
  const api = readLocalApi();
  if (!api) return null;
  const presets = resolveSnoozePresets(new Date(), timestampFormat, environmentId);
  const picked = await api.contextMenu.show(
    [
      ...presets.map((preset) => ({
        id: preset.id,
        label: `Snooze: ${preset.label} (${preset.whenLabel})`,
      })),
      { id: "custom", label: "Snooze: Custom…", separatorBefore: true },
    ],
    position,
  );
  if (picked === null) return null;
  if (picked === "custom") return (await requestCustomSnooze()) ?? null;
  return pickShownSnoozePreset(presets, picked, timestampFormat, environmentId) ?? null;
}
