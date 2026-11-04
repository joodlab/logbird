import type { AuthSession } from '@trailmark/auth';
import type { Project } from '@trailmark/database';
export type AppEnv = {
  Variables: {
    requestId: string;
    user: AuthSession['user'];
    session: AuthSession['session'];
    activeOrganizationId: string | null;
    project: Project;
    member: { role: string };
  };
};
