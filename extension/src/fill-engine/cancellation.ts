// Cross-context cancellation for a running autofill. `runWithProfile` executes as one long
// injected script in the page's MAIN world, so the background "Stop" button can't interrupt it
// directly — instead the background re-injects a tiny setter that flips this window flag, and the
// engine's long loops poll it between items and bail.

interface CancellableWindow {
  __jobAutofillCancelled?: boolean;
}

export function resetCancellation(): void {
  try {
    (window as unknown as CancellableWindow).__jobAutofillCancelled = false;
  } catch {
    /* ignore */
  }
}

export function isCancelled(): boolean {
  try {
    return Boolean((window as unknown as CancellableWindow).__jobAutofillCancelled);
  } catch {
    return false;
  }
}
