import { describe, expect, it } from 'vitest';
import { loadAnswerKey } from '../src/lib/seed';
import {
  createView,
  getDocument,
  getReferral,
  listAudit,
  listQueue,
  scheduleReferral,
  updateFields,
  uploadReferral,
} from '../src/lib/service';
import type { ViewConfig } from '../src/lib/types';
import { ACTORS, ROOT, makeCtx, pdfFor, referralFor, scriptedViewAgent } from './helpers';

const fieldsOf = (view: Awaited<ReturnType<typeof getReferral>>) => view.sections.flatMap((s) => s.fields);

describe('field-by-field masking', () => {
  it('never sends billing the home address or the clinical summary, and masks the phone', async () => {
    const ctx = await makeCtx();
    const rec = await referralFor(ctx, '01');
    const view = await getReferral(ctx, ACTORS.billing, rec.id);
    const keys = fieldsOf(view).map((f) => f.key);

    expect(keys).not.toContain('address');
    expect(keys).not.toContain('clinical_notes');
    expect(view.hidden.map((h) => h.key)).toEqual(expect.arrayContaining(['address', 'clinical_notes']));
    expect(fieldsOf(view).find((f) => f.key === 'phone')).toMatchObject({ access: 'masked', value: null, display: '(•••) •••-0142' });

    const body = JSON.stringify(view);
    expect(body).not.toContain('41 Linden Ave');
    expect(body).not.toContain('555-0142');
    expect(body).not.toContain('furosemide');
  });

  it('masks the member ID for clinicians down to the last four characters', async () => {
    const ctx = await makeCtx();
    const view = await getReferral(ctx, ACTORS.clinician, (await referralFor(ctx, '01')).id);
    expect(fieldsOf(view).find((f) => f.key === 'member_id')).toMatchObject({ access: 'masked', value: null, display: '••••-•••-RK58' });
    expect(JSON.stringify(view)).not.toContain('4TQ7');
  });

  it('shows intake every field in full', async () => {
    const ctx = await makeCtx();
    const view = await getReferral(ctx, ACTORS.intake, (await referralFor(ctx, '01')).id);
    expect(view.hidden).toEqual([]);
    expect(fieldsOf(view).every((f) => f.access === 'full')).toBe(true);
  });

  it('masks queue rows the same way, and drops columns a role cannot see at all', async () => {
    const ctx = await makeCtx();
    const view: ViewConfig = {
      title: 'Contact list',
      description: '',
      filters: [],
      columns: ['ref_no', 'patient_name', 'phone', 'address'],
      sort: { field: 'received_at', dir: 'desc' },
    };
    const queue = await listQueue(ctx, ACTORS.billing, { view });
    expect(queue.columns.map((c) => c.key)).toEqual(['ref_no', 'patient_name', 'phone']);
    expect(queue.rows.every((r) => r.cells.phone.masked)).toBe(true);
    expect(JSON.stringify(queue)).not.toContain('Linden');
  });

  it('only gives evidence quotes to roles that may open the original fax', async () => {
    const ctx = await makeCtx();
    const { referral } = await uploadReferral(ctx, ACTORS.intake, { filename: 'referral-10.pdf', bytes: pdfFor('10') });
    const billing = fieldsOf(await getReferral(ctx, ACTORS.billing, referral.id));
    const clinician = fieldsOf(await getReferral(ctx, ACTORS.clinician, referral.id));

    expect(billing.every((f) => f.evidence === null)).toBe(true);
    expect(clinician.find((f) => f.key === 'patient_name')?.evidence).toBe('quote for patient_name');
    expect(clinician.find((f) => f.key === 'member_id')?.evidence).toBeNull();
  });
});

describe('out-of-scope actions fail, change nothing, and are logged', () => {
  it('billing cannot edit a clinical field', async () => {
    const ctx = await makeCtx();
    const rec = await referralFor(ctx, '01');
    await expect(updateFields(ctx, ACTORS.billing, rec.id, { set: { primary_diagnosis: 'Something else' } })).rejects.toMatchObject({
      status: 403,
    });
    expect((await ctx.store.getReferral(rec.id))?.data.primary_diagnosis.value).toBe(rec.data.primary_diagnosis.value);
    const [last] = await ctx.store.listAudit({ referralId: rec.id, limit: 1 });
    expect(last).toMatchObject({ actor: 'marcus', action: 'update', outcome: 'denied', fields: ['primary_diagnosis'] });
  });

  it('one forbidden field sinks the whole edit', async () => {
    const ctx = await makeCtx();
    const rec = await referralFor(ctx, '04');
    await expect(
      updateFields(ctx, ACTORS.billing, rec.id, { set: { member_id: 'W998877', primary_diagnosis: 'Something else' } }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await ctx.store.getReferral(rec.id))?.data.member_id.value).toBeNull();
  });

  it('billing can fix insurance fields', async () => {
    const ctx = await makeCtx();
    const rec = await referralFor(ctx, '04');
    const view = await updateFields(ctx, ACTORS.billing, rec.id, { set: { member_id: 'W998877' } });
    expect(view.status).toBe('ready');
  });

  it('clinicians cannot edit anything', async () => {
    const ctx = await makeCtx();
    const rec = await referralFor(ctx, '01');
    await expect(updateFields(ctx, ACTORS.clinician, rec.id, { set: { clinical_notes: 'Edited' } })).rejects.toMatchObject({ status: 403 });
  });

  it('nobody can edit a field they can only see masked', async () => {
    const ctx = await makeCtx();
    ctx.config.fieldsByKey.phone.edit.push('billing');
    const rec = await referralFor(ctx, '01');
    await expect(updateFields(ctx, ACTORS.billing, rec.id, { set: { phone: '(212) 555-0100' } })).rejects.toMatchObject({ status: 403 });
  });

  it('billing cannot open the original fax', async () => {
    const ctx = await makeCtx();
    const rec = await referralFor(ctx, '01');
    await expect(getDocument(ctx, ACTORS.billing, rec.id)).rejects.toMatchObject({ status: 403 });
    const doc = await getDocument(ctx, ACTORS.clinician, rec.id);
    expect(doc.filename).toBe(`${rec.refNo}.pdf`);
    expect(doc.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('only intake can read the audit log', async () => {
    const ctx = await makeCtx();
    await expect(listAudit(ctx, ACTORS.billing)).rejects.toMatchObject({ status: 403 });
    await expect(listAudit(ctx, ACTORS.clinician)).rejects.toMatchObject({ status: 403 });
    expect((await listAudit(ctx, ACTORS.intake)).length).toBeGreaterThan(0);
  });

  it('only intake uploads', async () => {
    const ctx = await makeCtx();
    await expect(uploadReferral(ctx, ACTORS.billing, { filename: 'x.pdf', bytes: pdfFor('10') })).rejects.toMatchObject({ status: 403 });
  });

  it('only intake schedules, and never a referral with open items', async () => {
    const ctx = await makeCtx();
    const ready = await referralFor(ctx, '01');
    const unsigned = await referralFor(ctx, '02');
    await expect(scheduleReferral(ctx, ACTORS.clinician, ready.id, '2026-10-06')).rejects.toMatchObject({ status: 403 });
    await expect(scheduleReferral(ctx, ACTORS.intake, unsigned.id, '2026-10-06')).rejects.toMatchObject({ status: 409 });
    expect((await scheduleReferral(ctx, ACTORS.intake, ready.id, '2026-10-06')).status).toBe('scheduled');
  });

  it('writes every denied attempt to the audit log', async () => {
    const ctx = await makeCtx();
    const rec = await referralFor(ctx, '01');
    await getDocument(ctx, ACTORS.billing, rec.id).catch(() => undefined);
    await listAudit(ctx, ACTORS.clinician).catch(() => undefined);
    const denied = (await ctx.store.listAudit({ limit: 50 })).filter((e) => e.outcome === 'denied');
    expect(denied.map((e) => `${e.actor}:${e.action}`)).toEqual(expect.arrayContaining(['marcus:view_document', 'dana:view_audit']));
  });
});

describe('the audit log', () => {
  it('records field names but never patient data', async () => {
    const ctx = await makeCtx({
      viewAgent: scriptedViewAgent({
        title: 'Medicare referrals',
        description: '',
        filters: [{ field: 'payer_type', op: 'eq', values: ['medicare'] }],
        columns: ['ref_no', 'patient_name', 'status', 'next_action'],
        sort_field: 'received_at',
        sort_dir: 'desc',
      }),
    });
    const rec = await referralFor(ctx, '04');
    for (const actor of Object.values(ACTORS)) {
      await listQueue(ctx, actor);
      await getReferral(ctx, actor, rec.id);
      await getDocument(ctx, actor, rec.id).catch(() => undefined);
      await updateFields(ctx, actor, rec.id, { set: { member_id: 'W55501234' } }).catch(() => undefined);
    }
    await uploadReferral(ctx, ACTORS.intake, { filename: 'Lusk referral.pdf', bytes: pdfFor('12') });
    await createView(ctx, ACTORS.intake, 'Medicare referrals');

    const log = JSON.stringify(await ctx.store.listAudit({ limit: 1000 }));
    const phi = loadAnswerKey(ROOT)
      .referrals.flatMap((r) => ctx.config.fields.filter((f) => f.phi).map((f) => r.fields[f.key]))
      .flat()
      .filter((v): v is string => typeof v === 'string' && v.length > 3);
    for (const value of [...phi, 'W55501234', 'Lusk']) expect(log).not.toContain(value);
  });
});
