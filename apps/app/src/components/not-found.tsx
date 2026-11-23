import { EmptyState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Link } from '@tanstack/react-router';
import { CompassIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** A page that does not exist. `action` replaces the default way out ("Back to Logbird"). */
export function NotFound({ title = 'Nothing here', description, action }: { title?: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState
        description={description ?? 'The page you followed does not exist, or it belongs to a workspace you are not part of.'}
        icon={CompassIcon}
        titleAs="h1"
        title={title}
      >
        {action ?? (
          <Button nativeButton={false} render={<Link to="/" />} size="sm" variant="outline">
            Back to Logbird
          </Button>
        )}
      </EmptyState>
    </div>
  );
}
