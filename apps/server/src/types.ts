import type { AuthSession } from '@logbird/auth';
import type { Project } from '@logbird/database';
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
