import { logbird } from '@logbird/tanstack-start';
import { options } from '../audit.server';
export const integration = logbird(options);
