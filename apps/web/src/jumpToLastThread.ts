type JumpToLastThread = (leavingThreadKey: string | null) => boolean;

// Only the mounted thread sidebar knows the card order, so it registers the
// jump here for the composer's send-and-jump shortcut.
let registeredJumpToLastThread: JumpToLastThread | null = null;

/**
 * Called by the thread sidebar while it is mounted. Returns the unregister
 * function, which leaves a newer registration in place.
 */
export function registerJumpToLastThread(handler: JumpToLastThread): () => void {
  registeredJumpToLastThread = handler;
  return () => {
    if (registeredJumpToLastThread === handler) registeredJumpToLastThread = null;
  };
}

/**
 * Opens the bottom card of the sidebar queue, skipping the thread being left.
 * Returns false when no sidebar is mounted or the queue has no other thread.
 */
export function jumpToLastThread(leavingThreadKey: string | null): boolean {
  return registeredJumpToLastThread?.(leavingThreadKey) ?? false;
}
