/**
 * Runs only when TEST_DATABASE_URL is set. It drops and recreates the tables,
 * so point it at a throwaway database, never the one you demo from.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemoData } from '../src/lib/seed';
import { PgStore } from '../src/lib/store-pg';
import { ROOT, TODAY, loadConfig, pdfFor } from './helpers';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Postgres store', () => {
  let pool: Pool;
  let store: PgStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(
      'drop table if exists audit_log, saved_views, documents, referrals cascade; drop sequence if exists referral_no_seq; drop function if exists audit_log_append_only() cascade;',
    );
    await pool.query(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
    store = new PgStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('round-trips referrals with their JSONB data and flags', async () => {
    expect(await seedDemoData(store, loadConfig(), { root: ROOT, today: TODAY })).toBe(9);
    const all = await store.listReferrals();
    const benning = all.find((r) => r.data.patient_name?.value === 'Harold Benning');
    expect(benning?.flags.map((f) => f.key)).toEqual(['unsigned_order']);
    expect(benning?.refNo).toMatch(/^R-10\d\d$/);
  });

  it('skips files it already has when seeding again', async () => {
    expect(await seedDemoData(store, loadConfig(), { root: ROOT, today: TODAY })).toBe(0);
  });

  it('stores dates without shifting them a day', async () => {
    const scheduled = (await store.listReferrals()).find((r) => r.status === 'scheduled');
    expect(scheduled?.startOfCare).toBe('2026-10-05');
  });

  it('finds flagged referrals in plain SQL through the JSONB index', async () => {
    const { rows } = await pool.query(`select count(*)::int as n from referrals where flags @> '[{"key": "unsigned_order"}]'`);
    expect(rows[0].n).toBe(3);
  });

  it('refuses to change, delete or truncate audit entries', async () => {
    await store.appendAudit({ actor: 'priya', role: 'intake', action: 'view', outcome: 'allowed', referralId: null, fields: [], detail: {} });
    await expect(pool.query("update audit_log set action = 'edited'")).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from audit_log')).rejects.toThrow(/append-only/);
    await expect(pool.query('truncate audit_log')).rejects.toThrow(/append-only/);
  });

  it('keeps one referral when the same file is uploaded twice at the same moment', async () => {
    const bytes = pdfFor('10');
    const doc = { filename: 'referral-10.pdf', mime: 'application/pdf', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes };
    const results = await Promise.all([
      store.createReferralWithDocument({ status: 'new', owner: null }, doc),
      store.createReferralWithDocument({ status: 'new', owner: null }, doc),
    ]);
    expect(results.filter((r) => r.referral).length).toBe(1);
    const ids = results.map((r) => r.referral?.id ?? r.duplicateOf);
    expect(ids[0]).toBe(ids[1]);
  });
});
