/**
 * Loads the seed referrals from data/answer-key.json into Postgres, as if they
 * had been extracted. Referrals already there (same file hash) are skipped, so
 * running it twice is harmless.
 *
 *   npm run db:seed
 */
import { getConfig } from '../src/lib/config';
import { loadAnswerKey, seedDemoData } from '../src/lib/seed';
import { PgStore } from '../src/lib/store-pg';
import { loadEnv, requireDatabaseUrl } from './env';

async function main() {
  loadEnv();
  const store = PgStore.fromUrl(requireDatabaseUrl());
  try {
    const added = await seedDemoData(store, getConfig());
    const keptBack = loadAnswerKey()
      .referrals.filter((r) => !r.seed)
      .map((r) => r.file);
    console.log(`Seeded ${added} new referral(s). Kept back for the live upload: ${keptBack.join(', ')}`);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
