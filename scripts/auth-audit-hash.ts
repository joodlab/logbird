import { authEmailHash } from '../packages/database/src/auth-email-hash';

const email = process.argv[2];
if (!email || !process.env.BETTER_AUTH_SECRET) throw new Error('Provide an email argument and load the deployment environment.');
console.log(`v1:${authEmailHash(email, process.env.BETTER_AUTH_SECRET)}`);
