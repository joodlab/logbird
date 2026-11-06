import { OTP_RESEND_COOLDOWN_SECONDS } from '@logbird/ui/hooks/use-otp-resend-countdown';

const KEY = 'logbird.otpSentAt';

export function markOtpSent(email: string): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ email, at: Date.now() }));
  } catch {
    // Session storage unavailable: the cooldown simply starts fresh on the verify page.
  }
}

/** Seconds left before another code may be requested for this email. */
export function otpCooldownLeft(email: string): number {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return 0;
    const { email: sentTo, at } = JSON.parse(raw) as { email: string; at: number };
    if (sentTo !== email) return 0;
    return Math.max(0, OTP_RESEND_COOLDOWN_SECONDS - Math.floor((Date.now() - at) / 1000));
  } catch {
    return 0;
  }
}
