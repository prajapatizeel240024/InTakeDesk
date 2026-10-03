import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config';
import { todayIso } from './format';
import type { Store } from './store';
import type { FieldValue } from './types';
import { computeFlags, computeStatus } from './workflow';

export interface AnswerKeyEntry {
  id: string;
  file: string;
  layout: string;
  tests: string;
  /** Loaded into the demo queue. The rest are kept back for the live upload. */
  seed: boolean;
  seedOwner: string | null;
  seedHoursAgo: number;
  seedConfidence: Record<string, number>;
  seedStartOfCareInDays: number | null;
  fields: Record<string, unknown>;
  expectedFlags: string[];
}

export interface AnswerKey {
  note: string;
  referrals: AnswerKeyEntry[];
}

export function loadAnswerKey(root = process.cwd()): AnswerKey {
  return JSON.parse(fs.readFileSync(path.join(root, 'data', 'answer-key.json'), 'utf8')) as AnswerKey;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Fills a store with the seed referrals from data/answer-key.json, as if they had
 * been extracted, so the queue isn't empty before the demo. Returns how many were added.
 */
export async function seedDemoData(store: Store, config: Config, opts: { root?: string; today?: string } = {}): Promise<number> {
  const root = opts.root ?? process.cwd();
  const today = opts.today ?? todayIso();
  let added = 0;
  for (const entry of loadAnswerKey(root).referrals.filter((r) => r.seed)) {
    const data: Record<string, FieldValue> = {};
    for (const field of config.fields) {
      data[field.key] = {
        value: entry.fields[field.key] ?? null,
        confidence: entry.seedConfidence[field.key] ?? 0.97,
        evidence: null,
        source: 'seed',
        verified: false,
      };
    }
    const flags = computeFlags(config, data, { today });
    let status = computeStatus(flags, 'new');
    let startOfCare: string | null = null;
    if (entry.seedStartOfCareInDays !== null && status === 'ready') {
      status = 'scheduled';
      startOfCare = addDays(today, entry.seedStartOfCareInDays);
    }
    const bytes = fs.readFileSync(path.join(root, 'data', 'referrals', entry.file));
    const result = await store.createReferralWithDocument(
      {
        status,
        owner: entry.seedOwner,
        receivedAt: new Date(Date.now() - entry.seedHoursAgo * 3_600_000).toISOString(),
        startOfCare,
        data,
        flags,
        extraction: { model: 'seeded from the answer key', ms: 0, fallbackUsed: false },
      },
      { filename: entry.file, mime: 'application/pdf', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes },
    );
    if (result.referral) {
      added++;
      await store.appendAudit({
        actor: 'system',
        role: 'system',
        action: 'seed',
        outcome: 'allowed',
        referralId: result.referral.id,
        fields: [],
        detail: { ref: result.referral.refNo },
      });
    }
  }
  return added;
}
