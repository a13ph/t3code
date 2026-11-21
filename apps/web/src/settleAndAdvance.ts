import type { ScopedThreadRef } from "@t3tools/contracts";

type SettleAndAdvance = (threadRef: ScopedThreadRef) => void;
type SnoozeAndAdvance = (threadRef: ScopedThreadRef, preset: { snoozedUntil: string }) => void;

let registeredSettleAndAdvance: SettleAndAdvance | null = null;
let registeredSnoozeAndAdvance: SnoozeAndAdvance | null = null;

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

export function registerSnoozeAndAdvance(handler: SnoozeAndAdvance): () => void {
  registeredSnoozeAndAdvance = handler;
  return () => {
    if (registeredSnoozeAndAdvance === handler) registeredSnoozeAndAdvance = null;
  };
}

/** False means no sidebar is mounted; snooze in place. */
export function snoozeAndAdvance(
  threadRef: ScopedThreadRef,
  preset: { snoozedUntil: string },
): boolean {
  if (!registeredSnoozeAndAdvance) return false;
  registeredSnoozeAndAdvance(threadRef, preset);
  return true;
}
