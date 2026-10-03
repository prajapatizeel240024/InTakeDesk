import { describe, expect, it } from 'vitest';
import { icd10Valid, mbiValid, npiValid } from '../src/lib/rules';
import { loadAnswerKey } from '../src/lib/seed';
import { getReferral, scheduleReferral, updateFields, uploadReferral } from '../src/lib/service';
import type { FieldValue } from '../src/lib/types';
import { computeFlags } from '../src/lib/workflow';
import { ACTORS, ROOT, TODAY, answerKeyExtractor, failingExtractor, loadConfig, makeCtx, pdfFor, referralFor } from './helpers';

function dataFrom(id: string, overrides: Record<string, unknown> = {}): Record<string, FieldValue> {
  const entry = loadAnswerKey(ROOT).referrals.find((r) => r.id === id);
  const fields = { ...entry?.fields, ...overrides };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v, confidence: 1, evidence: null, source: 'human', verified: true }]));
}
const flagKeys = (data: Record<string, FieldValue>) => computeFlags(loadConfig(), data, { today: TODAY }).map((f) => f.key);

describe('validation rules', () => {
  it('checks the NPI check digit', () => {
    expect(npiValid('1234567893')).toBe(true);
    expect(npiValid('1234567890')).toBe(false);
    expect(npiValid('123456789')).toBe(false);
  });

  it('checks the Medicare Beneficiary Identifier format', () => {
    expect(mbiValid('1EG4-TE5-MK73')).toBe(true);
    expect(mbiValid('1eg4te5mk73')).toBe(true);
    expect(mbiValid('1EG4-TE5-MKO3')).toBe(false);
    expect(mbiValid('0EG4-TE5-MK73')).toBe(false);
  });

  it('checks ICD-10 code shape, which catches a letter where a digit belongs', () => {
    for (const code of ['I50.32', 'G20.A1', 'Z96.651', 'I10', 'S72.001D']) expect(icd10Valid(code), code).toBe(true);
    for (const code of ['NI8.4', 'EI1.65', '250.00', 'E11.']) expect(icd10Valid(code), code).toBe(false);
  });

  it('asks for homebound status and the face-to-face date only on traditional Medicare', () => {
    expect(flagKeys(dataFrom('09'))).toEqual(['unsigned_order']);
    expect(flagKeys(dataFrom('09', { payer_type: 'medicare' }))).toEqual(
      expect.arrayContaining(['missing:homebound', 'missing:face_to_face_date', 'invalid:member_id']),
    );
  });

  it('checks the member ID as an MBI only for traditional Medicare', () => {
    expect(flagKeys(dataFrom('07'))).not.toContain('invalid:member_id');
    expect(flagKeys(dataFrom('07', { payer_type: 'medicare' }))).toContain('invalid:member_id');
  });
});

describe('the seeded queue', () => {
  it('puts each referral in the status its fixture was built to test', async () => {
    const ctx = await makeCtx();
    const expected: Record<string, string> = {
      '01': 'ready',
      '02': 'missing_info',
      '03': 'new',
      '04': 'missing_info',
      '05': 'scheduled',
      '06': 'missing_info',
      '07': 'missing_info',
      '08': 'missing_info',
      '09': 'missing_info',
    };
    for (const [id, status] of Object.entries(expected)) expect((await referralFor(ctx, id)).status, `referral ${id}`).toBe(status);
  });

  it('words the next action from the YAML', async () => {
    const ctx = await makeCtx();
    const next = async (id: string) => (await getReferral(ctx, ACTORS.intake, (await referralFor(ctx, id)).id)).nextAction;
    expect(await next('01')).toBe('Schedule start-of-care visit');
    expect(await next('02')).toBe('Request signed order from Paul Wexler, DO');
    expect(await next('03')).toBe('Check what the AI read: Home address');
    expect(await next('04')).toBe('Get missing info: Member ID');
    expect(await next('06')).toBe('Request signed order from Victor Salinas, MD');
    expect(await next('07')).toBe('Fix NPI');
    expect(await next('08')).toBe('Fix ICD-10 codes');
  });
});

describe('working a referral', () => {
  it('moves from New to Ready once a person checks the shaky field', async () => {
    const ctx = await makeCtx();
    const rec = await referralFor(ctx, '03');
    const view = await updateFields(ctx, ACTORS.intake, rec.id, { verify: ['address'] });
    expect(view.status).toBe('ready');
    expect(view.flags).toEqual([]);
  });

  it('becomes Ready once the missing member ID is entered, then can be scheduled', async () => {
    const ctx = await makeCtx();
    const rec = await referralFor(ctx, '04');
    expect((await updateFields(ctx, ACTORS.intake, rec.id, { set: { member_id: 'W123456789' } })).status).toBe('ready');
    const scheduled = await scheduleReferral(ctx, ACTORS.intake, rec.id, '2026-10-06');
    expect(scheduled).toMatchObject({ status: 'scheduled', startOfCare: '2026-10-06', nextAction: 'Start of care Oct 6, 2026' });
  });

  it('flags a fixed code again if someone types the typo back in', async () => {
    const ctx = await makeCtx();
    const rec = await referralFor(ctx, '08');
    expect((await updateFields(ctx, ACTORS.intake, rec.id, { set: { icd10_codes: 'I12.9, N18.4' } })).status).toBe('ready');
    expect((await updateFields(ctx, ACTORS.intake, rec.id, { set: { icd10_codes: ['I12.9', 'NI8.4'] } })).status).toBe('missing_info');
  });
});

describe('uploading a referral', () => {
  it('extracts the live-demo fax and flags the unsigned order', async () => {
    const ctx = await makeCtx();
    const { referral, duplicate } = await uploadReferral(ctx, ACTORS.intake, { filename: 'referral-11.pdf', bytes: pdfFor('11') });
    expect(duplicate).toBe(false);
    expect(referral.status).toBe('missing_info');
    expect(referral.flags.map((f) => f.key)).toEqual(['unsigned_order']);
    expect(referral.nextAction).toBe('Request signed order from Leah Morrow, NP');
    expect(referral.ownerName).toBe('Priya Nair');
  });

  it('sends low-confidence fields to a person instead of marking the referral Ready', async () => {
    const ctx = await makeCtx({ extractor: answerKeyExtractor({ phone: 0.55 }) });
    const { referral } = await uploadReferral(ctx, ACTORS.intake, { filename: 'referral-12.pdf', bytes: pdfFor('12') });
    expect(referral.status).toBe('new');
    expect(referral.nextAction).toBe('Check what the AI read: Phone');
  });

  it('treats the same fax uploaded twice as one referral', async () => {
    const ctx = await makeCtx();
    const first = await uploadReferral(ctx, ACTORS.intake, { filename: 'a.pdf', bytes: pdfFor('10') });
    const count = (await ctx.store.listReferrals()).length;
    const second = await uploadReferral(ctx, ACTORS.intake, { filename: 'b.pdf', bytes: pdfFor('10') });
    expect(second.duplicate).toBe(true);
    expect(second.referral.id).toBe(first.referral.id);
    expect((await ctx.store.listReferrals()).length).toBe(count);
  });

  it('keeps the referral when extraction fails, and says what to do', async () => {
    const ctx = await makeCtx({ extractor: failingExtractor });
    const { referral } = await uploadReferral(ctx, ACTORS.intake, { filename: 'referral-10.pdf', bytes: pdfFor('10') });
    expect(referral.status).toBe('missing_info');
    expect(referral.flags.map((f) => f.key)).toEqual(['extraction_failed']);
    expect(referral.nextAction).toBe('Extraction failed. Enter the fields by hand.');
  });

  it('refuses files that are not PDFs', async () => {
    const ctx = await makeCtx();
    await expect(uploadReferral(ctx, ACTORS.intake, { filename: 'x.pdf', bytes: Buffer.from('not a pdf') })).rejects.toMatchObject({
      status: 400,
    });
  });
});
