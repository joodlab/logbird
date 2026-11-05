import { createStart } from '@tanstack/react-start';
import { integration } from './audit.server';
export const startInstance = createStart(() => ({ requestMiddleware: [integration.requestMiddleware] }));
