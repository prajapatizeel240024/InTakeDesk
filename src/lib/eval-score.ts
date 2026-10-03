import type { Config, FieldDef } from './config';
import { isEmpty } from './rules';
import type { FieldValue } from './types';

const CREDENTIALS = new Set(['dr', 'md', 'do', 'np', 'rn', 'pa', 'aprn', 'fnp', 'mr', 'mrs', 'ms']);
const STREET_WORDS: Record<string, string> = {
  avenue: 'ave',
  street: 'st',
  road: 'rd',
  drive: 'dr',
  court: 'ct',
  lane: 'ln',
  parkway: 'pkwy',
  terrace: 'ter',
  boulevard: 'blvd',
  place: 'pl',
  apartment: 'apt',
  suite: 'ste',
};

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

function tokenF1(a: string, b: string): number {
  const predicted = tokens(a);
  const expected = tokens(b);
  if (!predicted.length || !expected.length) return 0;
  const pool = new Map<string, number>();
  for (const t of expected) pool.set(t, (pool.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of predicted) {
    const n = pool.get(t) ?? 0;
    if (n > 0) {
      overlap++;
      pool.set(t, n - 1);
    }
  }
  const precision = overlap / predicted.length;
  const recall = overlap / expected.length;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

export type CompareMode = NonNullable<FieldDef['compare']>;

export function compareMode(field: FieldDef): CompareMode {
  return field.compare ?? (field.type === 'text' ? 'text' : field.type === 'phone' ? 'digits' : 'exact');
}

/** True when a predicted value counts as right, using the field's compare mode from the YAML. */
export function valuesMatch(field: FieldDef, predicted: unknown, expected: unknown): boolean {
  if (isEmpty(expected) || isEmpty(predicted)) return isEmpty(expected) && isEmpty(predicted);
  if (Array.isArray(expected)) {
    const norm = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => String(x).trim().toUpperCase()).sort().join('|') : '');
    return norm(predicted) === norm(expected);
  }
  if (typeof expected === 'boolean') return predicted === expected;
  const p = String(predicted);
  const e = String(expected);
  switch (compareMode(field)) {
    case 'name': {
      const norm = (s: string) => tokens(s).filter((t) => !CREDENTIALS.has(t)).sort().join(' ');
      return norm(p) === norm(e);
    }
    case 'address': {
      const norm = (s: string) => tokens(s).map((t) => STREET_WORDS[t] ?? t).join(' ');
      return norm(p) === norm(e);
    }
    case 'digits':
      return p.replace(/\D/g, '') === e.replace(/\D/g, '');
    case 'id':
      return p.replace(/[^a-z0-9]/gi, '').toUpperCase() === e.replace(/[^a-z0-9]/gi, '').toUpperCase();
    case 'text':
      return tokenF1(p, e) >= 0.6;
    default:
      return p.trim().toLowerCase() === e.trim().toLowerCase();
  }
}

export interface CaseResult {
  id: string;
  expected: Record<string, unknown>;
  expectedFlags: string[];
  predicted: Record<string, FieldValue> | null;
  predictedFlags: string[];
  ms: number;
  model: string;
  fallbackUsed: boolean;
  error?: string;
}

export interface FieldScore {
  key: string;
  label: string;
  correct: number;
  total: number;
  misses: { id: string; predicted: string; expected: string; confidence: number | null }[];
}

export interface FlagScore {
  family: string;
  tp: number;
  fp: number;
  fn: number;
}

export interface EvalReport {
  cases: number;
  failures: number;
  fieldsCorrect: number;
  fieldsTotal: number;
  perField: FieldScore[];
  flags: FlagScore[];
  routing: { threshold: number; accepted: number; acceptedCorrect: number; reviewed: number; reviewedCorrect: number };
  latencyMs: { p50: number; p95: number };
  fallbacks: number;
}

/** Groups flag keys into the families we report on: unsigned_order, missing:*, invalid:*. Review flags aren't scored as flags. */
function flagFamily(key: string): string | null {
  if (key.startsWith('review:')) return null;
  const i = key.indexOf(':');
  return i === -1 ? key : `${key.slice(0, i)}:*`;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const show = (v: unknown) => (isEmpty(v) ? '(empty)' : Array.isArray(v) ? v.join(', ') : String(v));

export function scoreRun(config: Config, results: CaseResult[]): EvalReport {
  const perField: FieldScore[] = config.fields.map((f) => ({ key: f.key, label: f.label, correct: 0, total: 0, misses: [] }));
  const flagTotals = new Map<string, FlagScore>();
  const routing = { threshold: config.workflow.review_threshold, accepted: 0, acceptedCorrect: 0, reviewed: 0, reviewedCorrect: 0 };
  const ok = results.filter((r) => r.predicted && !r.error);

  for (const r of ok) {
    const predicted = r.predicted as Record<string, FieldValue>;
    config.fields.forEach((field, i) => {
      const got = predicted[field.key];
      const right = valuesMatch(field, got?.value, r.expected[field.key]);
      const score = perField[i];
      score.total++;
      if (right) score.correct++;
      else score.misses.push({ id: r.id, predicted: show(got?.value), expected: show(r.expected[field.key]), confidence: got?.confidence ?? null });
      if ((got?.confidence ?? 0) >= routing.threshold) {
        routing.accepted++;
        if (right) routing.acceptedCorrect++;
      } else {
        routing.reviewed++;
        if (right) routing.reviewedCorrect++;
      }
    });

    const expected = new Set(r.expectedFlags.filter((k) => flagFamily(k)));
    const got = new Set(r.predictedFlags.filter((k) => flagFamily(k)));
    const bump = (key: string, kind: 'tp' | 'fp' | 'fn') => {
      const family = flagFamily(key) as string;
      const t = flagTotals.get(family) ?? { family, tp: 0, fp: 0, fn: 0 };
      t[kind]++;
      flagTotals.set(family, t);
    };
    for (const k of got) bump(k, expected.has(k) ? 'tp' : 'fp');
    for (const k of expected) if (!got.has(k)) bump(k, 'fn');
  }

  const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
  return {
    cases: results.length,
    failures: results.length - ok.length,
    fieldsCorrect: perField.reduce((n, f) => n + f.correct, 0),
    fieldsTotal: perField.reduce((n, f) => n + f.total, 0),
    perField,
    flags: [...flagTotals.values()].sort((a, b) => a.family.localeCompare(b.family)),
    routing,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    fallbacks: ok.filter((r) => r.fallbackUsed).length,
  };
}
