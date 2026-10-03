/**
 * Creates the Intake Desk tables. Safe to run more than once.
 *
 *   npm run db:setup
 *   npm run db:reset    drops the tables first, then seeds. Local databases only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { loadEnv, redactUrl, requireDatabaseUrl } from './env';

async function main() {
  loadEnv();
  const url = requireDatabaseUrl();
  const reset = process.argv.includes('--reset');
  const host = new URL(url).hostname;
  if (reset && !['localhost', '127.0.0.1', '::1'].includes(host) && !process.argv.includes('--yes-this-is-not-shared')) {
    console.error(`Refusing to drop tables on ${host}. Reset only runs against a local database.`);
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (reset) {
      await client.query('drop table if exists audit_log, saved_views, documents, referrals cascade');
      await client.query('drop sequence if exists referral_no_seq');
      await client.query('drop function if exists audit_log_append_only() cascade');
      console.log('Dropped the Intake Desk tables.');
    }
    await client.query(fs.readFileSync(path.join(process.cwd(), 'db', 'schema.sql'), 'utf8'));
    console.log(`Schema is ready on ${redactUrl(url)}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
