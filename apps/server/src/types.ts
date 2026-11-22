import type { AuthSession } from '@logbird/auth';
import type { Project } from '@logbird/database';
import type { Reader } from './read-access';
export type AppEnv = {
  Variables: {
    requestId: string;
    user: AuthSession['user'];
    session: AuthSession['session'];
    activeOrganizationId: string | null;
    project: Project;
    member: { role: string };
    /** /v1 read routes: the authenticated read key or viewer token and its scope (#138). */
    reader: Reader;
  };
};
