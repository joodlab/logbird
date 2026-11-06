import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClickHouseClient } from '../src/client';
import { provisionQueryUser } from '../src/provision-query-user';

const ch = createClickHouseClient();
try {
  // Inspect privileges without emitting SHOW ACCESS authentication material.
  const grants = await (await ch.query({ query: 'SHOW GRANTS', format: 'TabSeparatedRaw' })).text();
  await (await ch.query({ query: 'SHOW ACCESS', format: 'TabSeparatedRaw' })).text();
  if (!/CREATE USER|ALL ON/.test(grants) || !/CREATE SETTINGS PROFILE|ALL ON/.test(grants))
    throw new Error('Requires CREATE USER and CREATE SETTINGS PROFILE (and SELECT grant option on Logbird tables)');
  const fromEnvironment = Boolean(process.env.CLICKHOUSE_QUERY_PASSWORD);
  const files = [resolve('../../.env'), ...(process.env.LOGBIRD_PRIMARY_ENV ? [resolve(process.env.LOGBIRD_PRIMARY_ENV)] : [])];
  const contents = await Promise.all(
    files.map((file) =>
      readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
        // Containers need no env file; still compare any existing source-install files.
        if (fromEnvironment && error.code === 'ENOENT') return '';
        throw error;
      }),
    ),
  );
  const passwords = [process.env.CLICKHOUSE_QUERY_PASSWORD, ...contents.map((c) => c.match(/^CLICKHOUSE_QUERY_PASSWORD=(.*)$/m)?.[1])].filter(
    Boolean,
  );
  if (new Set(passwords).size > 1) throw new Error('Existing query credentials differ; refusing to replace them');
  const existing = await (await ch.query({ query: "SELECT name FROM system.users WHERE name='logbird_query'", format: 'JSONEachRow' })).json();
  if (existing.length && !passwords.length) throw new Error('logbird_query already exists without configured credentials; refusing to rotate');
  const password = passwords[0] ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Existing password is not in the generated credential format; refusing to modify it');
  if (
    (process.env.CLICKHOUSE_QUERY_USER && process.env.CLICKHOUSE_QUERY_USER !== 'logbird_query') ||
    contents.some((c) => /^CLICKHOUSE_QUERY_USER=(?!logbird_query$).+$/m.test(c))
  )
    throw new Error('Existing query username differs; refusing to replace it');
  if (existing.length) {
    const existingUser = createClickHouseClient({ ...process.env, CLICKHOUSE_USER: 'logbird_query', CLICKHOUSE_PASSWORD: password });
    try {
      await (await existingUser.query({ query: 'SELECT 1' })).text();
    } catch {
      throw new Error('Existing query credentials do not authenticate; refusing to rotate');
    } finally {
      await existingUser.close();
    }
  }
  await provisionQueryUser(ch, password);
  for (let i = 0; !fromEnvironment && i < files.length; i++) {
    let addition = '';
    if (!/^CLICKHOUSE_QUERY_USER=/m.test(contents[i]!)) addition += '\nCLICKHOUSE_QUERY_USER=logbird_query';
    if (!/^CLICKHOUSE_QUERY_PASSWORD=/m.test(contents[i]!)) addition += `\nCLICKHOUSE_QUERY_PASSWORD=${password}`;
    if (addition) await appendFile(files[i]!, `${addition}\n`);
  }
  console.log('Restricted Logbird query user ready; configured credentials preserved.');
} finally {
  await ch.close();
}
