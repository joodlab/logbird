import { Button } from '@logbird/ui/components/ui/button';
import { TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';

/** Close reasons that are one stray key press or click away (Escape, a tap on the backdrop, the corner ×). */
const STRAY_CLOSE_REASONS = new Set(['escape-key', 'outside-press', 'close-press', 'focus-out']);

/**
 * Whether closing a dialog that shows a once-only secret must ask first: only while the secret is on screen, has not
 * been copied, and the close came from a stray gesture rather than the explicit "I have stored the key" button.
 */
export function mustConfirmSecretClose(state: { showingSecret: boolean; copied: boolean }, reason: string | undefined): boolean {
  return state.showingSecret && !state.copied && STRAY_CLOSE_REASONS.has(reason ?? '');
}

/**
 * Guards a dialog step that shows a secret exactly once (OWNER-10). Wrap the dialog's `onOpenChange` with `guard`:
 * an uncopied secret is never lost to Escape or a backdrop tap — the dialog stays open and asks "Close without
 * copying?". Copying the secret (`markCopied`) lifts the guard.
 */
export function useSecretCloseGuard(showingSecret: boolean) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return {
    copied,
    confirming,
    markCopied: () => {
      setCopied(true);
      setConfirming(false);
    },
    cancelConfirm: () => setConfirming(false),
    reset: () => {
      setCopied(false);
      setConfirming(false);
    },
    /** Returns true when the close may proceed; otherwise shows the confirmation instead. */
    guard: (next: boolean, details?: { reason?: string }) => {
      if (next || !mustConfirmSecretClose({ showingSecret, copied }, details?.reason)) return true;
      setConfirming(true);
      return false;
    },
  };
}

/** Inline "Close without copying?" step shown in place of the footer when a stray close was caught. */
export function CloseWithoutCopying({ onKeep, onClose }: { onKeep: () => void; onClose: () => void }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-outcome-denied/30 bg-outcome-denied/[0.07] p-3"
      data-testid="secret-close-confirm"
      role="alertdialog"
      aria-labelledby="secret-close-title"
    >
      <p className="flex items-start gap-2 text-sm" id="secret-close-title">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-outcome-denied" />
        <span>
          <span className="font-medium">Close without copying?</span> You won’t see this key again — you would have to roll or revoke it and create
          another.
        </span>
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onClose} size="sm" variant="ghost">
          Close anyway
        </Button>
        {/* The safe choice takes focus, so a second Escape or Enter keeps the secret. */}
        <Button autoFocus onClick={onKeep} size="sm">
          Keep it open
        </Button>
      </div>
    </div>
  );
}
