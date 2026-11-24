import { Alert, AlertDescription, AlertTitle } from '@logbird/ui/components/ui/alert';
import { Button } from '@logbird/ui/components/ui/button';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '@/lib/api/errors';
import { authCall, authClient } from '@/lib/auth-client';

/**
 * A link (such as the "member joined" email's) that names a workspace other than the one open: say which workspace the
 * page shows, and switch only when asked. A workspace the person does not belong to is never named: nothing renders.
 */
export function WorkspaceLinkNotice({
  linked,
  active,
  organizations,
}: {
  linked: string | undefined;
  active: { id: string; name: string };
  organizations: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const target = organizations.find((o) => o.id === linked);
  if (!target || target.id === active.id) return null;
  const switchWorkspace = async () => {
    setSwitching(true);
    setFailed(null);
    try {
      await authCall(authClient.organization.setActive({ organizationId: target.id }));
    } catch (error) {
      setFailed(errorMessage(error));
      setSwitching(false);
      return;
    }
    // Everything cached belongs to the workspace just left; the same page then loads again in the new one.
    queryClient.clear();
    await router.invalidate();
    // Ready again if this notice is shown later for another linked workspace (the page can stay mounted).
    setSwitching(false);
  };
  return (
    <Alert data-testid="workspace-link-notice">
      <AlertTitle>This link is for {target.name}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>
          You are looking at {active.name}. Switch to see this page in {target.name}.
        </span>
        <Button disabled={switching} onClick={switchWorkspace} size="sm" variant="outline">
          {switching ? <Loader2Icon className="animate-spin" /> : null}
          Switch workspace
        </Button>
        {failed ? (
          <span className="text-destructive" role="alert">
            Could not switch to {target.name}: {failed}
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
