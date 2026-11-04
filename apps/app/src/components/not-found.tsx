import { Link } from '@tanstack/react-router';
import { EmptyState } from '@trailmark/ui/components/states';
import { Button } from '@trailmark/ui/components/ui/button';
import { CompassIcon } from 'lucide-react';

export function NotFound({ title = 'Nothing here', description }: { title?: string; description?: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState
        description={description ?? 'The page you followed does not exist, or it belongs to a workspace you are not part of.'}
        icon={CompassIcon}
        title={title}
      >
        <Button render={<Link to="/" />} size="sm" variant="outline">
          Back to Trailmark
        </Button>
      </EmptyState>
    </div>
  );
}
