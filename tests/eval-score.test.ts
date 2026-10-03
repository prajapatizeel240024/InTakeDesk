import { describe, expect, it } from 'vitest';
import { scoreRun, valuesMatch, type CaseResult } from '../src/lib/eval-score';
import { loadAnswerKey } from '../src/lib/seed';
import type { FieldValue } from '../src/lib/types';
import { ROOT, loadConfig } from './helpers';

const config = loadConfig();
const field = (key: string) => config.fieldsByKey[key];

function perfectRun(): CaseResult[] {
  return loadAnswerKey(ROOT).referrals.map((r) => ({
    id: r.id,
    expected: r.fields,
    expectedFlags: r.expectedFlags,
    predicted: Object.fromEntries(
      Object.entries(r.fields).map(([k, v]) => [k, { value: v, confidence: 0.99, evidence: null, source: 'model', verified: false } as FieldValue]),
    ),
    predictedFlags: r.expectedFlags,
    ms: 1000 + Number(r.id) * 100,
    model: 'test',
    fallbackUsed: false,
  }));
}

describe('eval scoring', () => {
  it('scores the answer key against itself at 100%', () => {
    const report = scoreRun(config, perfectRun());
    expect(report.fieldsCorrect).toBe(report.fieldsTotal);
    expect(report.fieldsTotal).toBe(12 * 19);
    expect(report.flags.every((f) => f.fp === 0 && f.fn === 0)).toBe(true);
    expect(report.flags.find((f) => f.family === 'unsigned_order')?.tp).toBe(4);
  });

  it('forgives formatting but not content', () => {
    expect(valuesMatch(field('referring_physician'), 'Dr. Paul Wexler', 'Paul Wexler, DO')).toBe(true);
    expect(valuesMatch(field('referring_physician'), 'Paula Wexler', 'Paul Wexler, DO')).toBe(false);
    expect(valuesMatch(field('address'), '41 Linden Avenue, Apartment 3B, Yonkers, NY 10701', '41 Linden Ave, Apt 3B, Yonkers, NY 10701')).toBe(true);
    expect(valuesMatch(field('phone'), '914.555.0142', '(914) 555-0142')).toBe(true);
    expect(valuesMatch(field('member_id'), '4tq7hm2rk58', '4TQ7-HM2-RK58')).toBe(true);
    expect(valuesMatch(field('order_signed'), false, false)).toBe(true);
    expect(valuesMatch(field('member_id'), null, null)).toBe(true);
    // Quietly "fixing" the faxed typo is a miss: the team needs to see what the referral says.
    expect(valuesMatch(field('icd10_codes'), ['N18.4', 'I12.9'], ['I12.9', 'NI8.4'])).toBe(false);
  });

  it('counts right flags, false alarms and misses', () => {
    const run = perfectRun();
    run[0].predictedFlags = ['unsigned_order'];
    run[1].predictedFlags = [];
    const unsigned = scoreRun(config, run).flags.find((f) => f.family === 'unsigned_order');
    expect(unsigned).toMatchObject({ tp: 3, fp: 1, fn: 1 });
  });

  it('shows whether the confidence threshold separates right answers from wrong ones', () => {
    const run = perfectRun();
    const predicted = run[0].predicted as Record<string, FieldValue>;
    predicted.patient_name = { ...predicted.patient_name, value: 'Delores Whitfeld', confidence: 0.5 };
    const { routing } = scoreRun(config, run);
    expect(routing.reviewed).toBe(1);
    expect(routing.reviewedCorrect).toBe(0);
    expect(routing.accepted).toBe(routing.acceptedCorrect);
  });

  it('leaves failed extractions out of accuracy and counts them', () => {
    const run = perfectRun();
    run[2] = { ...run[2], predicted: null, predictedFlags: [], error: 'boom' };
    const report = scoreRun(config, run);
    expect(report.failures).toBe(1);
    expect(report.fieldsTotal).toBe(11 * 19);
  });
});
