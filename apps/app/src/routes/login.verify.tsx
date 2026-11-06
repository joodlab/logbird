import { signInCodeLifetimeLabel } from '@logbird/contracts';
import { Button } from '@logbird/ui/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@logbird/ui/components/ui/input-otp';
import { useOtpResendCountdown } from '@logbird/ui/hooks/use-otp-resend-countdown';
import { cn } from '@logbird/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, CheckCircle2Icon, Loader2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { meQuery } from '@/lib/api/queries';
import { sendSignInCode, verifySignInCode } from '@/lib/auth-client';
import { markOtpSent, otpCooldownLeft } from '@/lib/otp';
import { safeRedirect } from '@/lib/session';

export const Route = createFileRoute('/login/verify')({
  validateSearch: z.object({ email: z.string().optional(), redirect: z.string().optional() }),
  beforeLoad: ({ search }) => {
    if (!search.email) throw redirect({ to: '/login' });
  },
  component: VerifyStep,
});

const OTP_LENGTH = 6;
const OTP_SLOTS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];

function friendlyOtpError(error: unknown): string {
  const code = (error as { code?: string }).code ?? '';
  const message = error instanceof Error ? error.message : '';
  if (/INVALID_OTP|invalid/i.test(code + message)) return 'That code is not right. Check the latest email and try again.';
  if (/EXPIRED|expired/i.test(code + message)) return 'That code has expired. Send a new one below.';
  if (/TOO_MANY|attempts/i.test(code + message)) return 'Too many attempts. Request a new code.';
  return message || 'Could not verify the code.';
}

function VerifyStep() {
  const { email = '', redirect: target } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [resending, setResending] = useState(false);
  const { resendIn, startCountdown } = useOtpResendCountdown();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (otpCooldownLeft(email) > 0) startCountdown();
  }, [email, startCountdown]);

  const verify = async (otp: string) => {
    if (verifying || otp.length !== OTP_LENGTH) return;
    setVerifying(true);
    setError(null);
    try {
      await verifySignInCode(email, otp);
      setVerified(true);
      await queryClient.invalidateQueries({ queryKey: meQuery().queryKey });
      await navigate({ to: safeRedirect(target), replace: true });
    } catch (err) {
      setError(friendlyOtpError(err));
      setCode('');
      setVerifying(false);
    }
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    try {
      await sendSignInCode(email);
      markOtpSent(email);
      startCountdown();
      toast.success('New code sent', { description: `Check ${email}.` });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a new code.');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-2xl tracking-tight">Check your email</h1>
        <p className="text-muted-foreground text-sm">
          Enter the 6-digit code we sent to <span className="font-medium text-foreground">{email}</span>. It expires in {signInCodeLifetimeLabel()}.
        </p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          verify(code);
        }}
      >
        <div className="flex flex-col gap-2">
          <InputOTP
            aria-describedby={error ? 'otp-error' : 'otp-help'}
            aria-invalid={Boolean(error) || undefined}
            aria-label="One-time code"
            autoFocus
            containerClassName={cn('justify-between', error && '[&_[data-slot=input-otp-slot]]:border-destructive/60')}
            disabled={verifying}
            maxLength={OTP_LENGTH}
            onChange={(value) => {
              setCode(value);
              if (error) setError(null);
            }}
            onComplete={verify}
            value={code}
          >
            <InputOTPGroup className="w-full justify-between">
              {OTP_SLOTS.map((slot, i) => (
                <InputOTPSlot className="size-12 text-lg" index={i} key={slot} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          {error ? (
            <p className="text-destructive text-sm" id="otp-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs" id="otp-help">
              Tip: paste the whole code — it fills every box.
            </p>
          )}
        </div>
        <Button size="lg" disabled={code.length !== OTP_LENGTH || verifying} type="submit">
          {verified ? <CheckCircle2Icon /> : verifying ? <Loader2Icon className="animate-spin" /> : null}
          {verified ? 'Signed in' : verifying ? 'Verifying…' : 'Verify and sign in'}
        </Button>
      </form>
      <div className="flex items-center justify-between text-sm">
        <Link className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" search={{ redirect: target }} to="/login">
          <ArrowLeftIcon className="size-3.5" />
          Use another email
        </Link>
        <Button className="tabular-nums" disabled={resendIn > 0 || resending} onClick={resend} size="sm" variant="ghost">
          {resending ? <Loader2Icon className="animate-spin" /> : null}
          {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
        </Button>
      </div>
    </div>
  );
}
