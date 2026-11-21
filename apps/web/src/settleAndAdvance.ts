import type { ScopedThreadRef } from "@t3tools/contracts";

type SettleAndAdvance = (threadRef: ScopedThreadRef) => void;

let registeredSettleAndAdvance: SettleAndAdvance | null = null;

export function registerSettleAndAdvance(handler: SettleAndAdvance): () => void {
  registeredSettleAndAdvance = handler;
  return () => {
    if (registeredSettleAndAdvance === handler) registeredSettleAndAdvance = null;
  };
}

/** False means no sidebar is mounted; settle in place. */
export function settleAndAdvance(threadRef: ScopedThreadRef): boolean {
  if (!registeredSettleAndAdvance) return false;
  registeredSettleAndAdvance(threadRef);
  return true;
}

type SnoozeAndAdvance = (threadRef: ScopedThreadRef, snoozedUntil: string) => void;

let registeredSnoozeAndAdvance: SnoozeAndAdvance | null = null;

/** The sidebar's snooze path, registered like the settle path above. */
export function registerSnoozeAndAdvance(handler: SnoozeAndAdvance): () => void {
  registeredSnoozeAndAdvance = handler;
  return () => {
    if (registeredSnoozeAndAdvance === handler) registeredSnoozeAndAdvance = null;
  };
}

/**
 * Snoozes the open thread the way the sidebar does: snooze, then move to the
 * next thread. Used by the `thread.snooze` shortcut. Returns false when no
 * sidebar is mounted, so the caller snoozes in place.
 */
export function snoozeAndAdvance(threadRef: ScopedThreadRef, snoozedUntil: string): boolean {
  if (!registeredSnoozeAndAdvance) return false;
  registeredSnoozeAndAdvance(threadRef, snoozedUntil);
  return true;
}
