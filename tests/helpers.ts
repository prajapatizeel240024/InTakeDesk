import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configPath, parseConfig, type Config } from '../src/lib/config';
import type { Extractor } from '../src/lib/extract';
import { loadAnswerKey, seedDemoData } from '../src/lib/seed';
import type { Ctx } from '../src/lib/service';
import { MemoryStore } from '../src/lib/store';
import type { Actor, FieldValue, ReferralRecord } from '../src/lib/types';
import type { ViewAgent } from '../src/lib/views';

export const ROOT = process.cwd();
export const TODAY = '2026-10-03';

export function loadConfig(): Config {
  return parseConfig(fs.readFileSync(configPath(ROOT), 'utf8'));
}

export const ACTORS = {
  intake: { userId: 'priya', name: 'Priya Nair', role: 'intake' },
  billing: { userId: 'marcus', name: 'Marcus Hale', role: 'billing' },
  clinician: { userId: 'dana', name: 'Dana Reyes', role: 'clinician' },
} satisfies Record<string, Actor>;

export function pdfFor(id: string): Buffer {
  return fs.readFileSync(path.join(ROOT, 'data', 'referrals', `referral-${id}.pdf`));
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Stands in for Claude: finds the PDF in the answer key by hash and returns the true values. */
export function answerKeyExtractor(confidence: Record<string, number> = {}): Extractor {
  const entries = new Map(loadAnswerKey(ROOT).referrals.map((r) => [sha(pdfFor(r.id)), r]));
  return {
    async extract({ pdf, config }) {
      const entry = entries.get(sha(pdf));
      if (!entry) throw new Error('Extraction failed: unknown document');
      const data: Record<string, FieldValue> = {};
      for (const f of config.fields) {
        data[f.key] = {
          value: entry.fields[f.key] ?? null,
          confidence: confidence[f.key] ?? 0.96,
          evidence: `quote for ${f.key}`,
          source: 'model',
          verified: false,
        };
      }
      return { data, meta: { model: 'answer-key-stub', ms: 5, fallbackUsed: false } };
    },
  };
}

export const failingExtractor: Extractor = {
  async extract() {
    throw new Error('Extraction failed: 529 overloaded_error');
  },
};

/** Returns the given responses in order, repeating the last one. */
export function scriptedViewAgent(...responses: unknown[]): ViewAgent & { calls: number } {
  const agent = {
    calls: 0,
    async propose() {
      const response = responses[Math.min(agent.calls, responses.length - 1)];
      agent.calls++;
      return response;
    },
  };
  return agent;
}

export async function makeCtx(
  opts: { seed?: boolean; extractor?: Extractor; viewAgent?: ViewAgent } = {},
): Promise<Ctx & { store: MemoryStore }> {
  const config = loadConfig();
  const store = new MemoryStore();
  if (opts.seed !== false) await seedDemoData(store, config, { root: ROOT, today: TODAY });
  return {
    config,
    store,
    extractor: opts.extractor ?? answerKeyExtractor(),
    viewAgent: opts.viewAgent ?? scriptedViewAgent({}),
    today: () => TODAY,
  };
}

/** The stored referral built from a given fixture, found by patient name. */
export async function referralFor(ctx: Ctx, id: string): Promise<ReferralRecord> {
  const entry = loadAnswerKey(ROOT).referrals.find((r) => r.id === id);
  const rec = (await ctx.store.listReferrals()).find((r) => r.data.patient_name?.value === entry?.fields.patient_name);
  if (!rec) throw new Error(`referral ${id} is not in the store`);
  return rec;
}
