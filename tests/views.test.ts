import { describe, expect, it } from 'vitest';
import { createView, listViews, runView } from '../src/lib/service';
import { validateView, viewSchema, viewCatalog } from '../src/lib/views';
import { ACTORS, TODAY, loadConfig, makeCtx, scriptedViewAgent } from './helpers';

const medicareUnsigned = {
  title: 'Medicare referrals missing a signed order',
  description: 'Traditional Medicare referrals whose order has no signature yet.',
  filters: [
    { field: 'payer_type', op: 'eq', values: ['medicare'] },
    { field: 'flags', op: 'has', values: ['unsigned_order'] },
  ],
  columns: ['ref_no', 'patient_name', 'referring_physician', 'status', 'next_action', 'owner'],
  sort_field: 'received_at',
  sort_dir: 'desc',
};

const fallsInNotes = {
  title: 'Referrals that mention a fall',
  description: '',
  filters: [{ field: 'clinical_notes', op: 'contains', values: ['fall'] }],
  columns: ['ref_no', 'patient_name', 'status', 'next_action'],
  sort_field: 'received_at',
  sort_dir: 'desc',
};

describe('views written by the agent', () => {
  it('finds exactly the Medicare referrals with unsigned orders', async () => {
    const ctx = await makeCtx({ viewAgent: scriptedViewAgent(medicareUnsigned) });
    const saved = await createView(ctx, ACTORS.intake, 'show me Medicare referrals missing a signed order');
    expect(saved.slug).toBe('medicare-referrals-missing-a-signed-order');
    expect(saved.yaml).toContain('value: unsigned_order');

    const { queue } = await runView(ctx, ACTORS.intake, saved.slug);
    // #09 is unsigned too, but it's commercial, so it stays out.
    expect(queue.rows.map((r) => r.cells.patient_name.text).sort()).toEqual(['Harold Benning', 'Leonard Kowalczyk']);
  });

  it("gives the agent one retry with the checker's complaints", async () => {
    const agent = scriptedViewAgent({ ...medicareUnsigned, filters: [{ field: 'payer', op: 'eq', values: ['Medicare'] }] }, medicareUnsigned);
    const ctx = await makeCtx({ viewAgent: agent });
    await createView(ctx, ACTORS.intake, 'Medicare unsigned');
    expect(agent.calls).toBe(2);
  });

  it('rejects a view that still fails after the retry, and logs it', async () => {
    const bad = { ...medicareUnsigned, filters: [{ field: 'payer_type', op: 'eq', values: ['medicaire'] }] };
    const ctx = await makeCtx({ viewAgent: scriptedViewAgent(bad) });
    await expect(createView(ctx, ACTORS.intake, 'Medicare unsigned')).rejects.toMatchObject({ status: 422 });
    const [last] = await ctx.store.listAudit({ limit: 1 });
    expect(last).toMatchObject({ action: 'create_view', outcome: 'denied' });
  });

  it('checks fields, operators and values against the YAML', () => {
    const config = loadConfig();
    const check = (filters: unknown[]) => validateView(config, { ...medicareUnsigned, filters }, 'intake');
    expect(check([{ field: 'payer', op: 'eq', values: ['x'] }])).toMatchObject({ ok: false });
    expect(check([{ field: 'payer_type', op: 'before', values: ['medicare'] }])).toMatchObject({ ok: false });
    const wrongValue = check([{ field: 'payer_type', op: 'eq', values: ['medicaire'] }]);
    expect(wrongValue.ok ? '' : wrongValue.errors[0]).toMatch(/Use one of: medicare, medicare_advantage/);
    expect(check([{ field: 'payer_type', op: 'eq', values: ['MEDICARE'] }])).toMatchObject({
      ok: true,
      view: { filters: [{ field: 'payer_type', op: 'eq', values: ['medicare'] }] },
    });
  });

  it("won't let a role filter on a field it can't fully see", () => {
    const config = loadConfig();
    const masked = validateView(config, { ...medicareUnsigned, filters: [{ field: 'phone', op: 'contains', values: ['555'] }] }, 'billing');
    const hidden = validateView(config, fallsInNotes, 'billing');
    const hiddenFlag = validateView(config, { ...medicareUnsigned, filters: [{ field: 'flags', op: 'has', values: ['review:address'] }] }, 'billing');
    expect(masked.ok ? '' : masked.errors[0]).toMatch(/Phone is masked for you/);
    expect(hidden.ok ? '' : hidden.errors[0]).toMatch(/Clinical summary is hidden for you/);
    expect(hiddenFlag.ok).toBe(false);
  });

  it("hides a view from roles that can't run it, so its results can't leak a hidden field", async () => {
    const ctx = await makeCtx({ viewAgent: scriptedViewAgent(fallsInNotes) });
    const saved = await createView(ctx, ACTORS.intake, 'referrals that mention a fall');
    expect((await listViews(ctx, ACTORS.billing)).map((v) => v.slug)).not.toContain(saved.slug);
    await expect(runView(ctx, ACTORS.billing, saved.slug)).rejects.toMatchObject({ status: 403 });
    const { queue } = await runView(ctx, ACTORS.clinician, saved.slug);
    expect(queue.rows.map((r) => r.cells.patient_name.text).sort()).toEqual(['Iris Fennimore', 'Walter Okafor']);
  });

  it('drops columns the viewer cannot see', async () => {
    const ctx = await makeCtx({
      viewAgent: scriptedViewAgent({ ...medicareUnsigned, filters: [], columns: ['ref_no', 'patient_name', 'address', 'status'] }),
    });
    const saved = await createView(ctx, ACTORS.intake, 'everyone with their address');
    const { queue } = await runView(ctx, ACTORS.billing, saved.slug);
    expect(queue.columns.map((c) => c.key)).toEqual(['ref_no', 'patient_name', 'status']);
  });

  it('only offers the agent fields the role can filter on', () => {
    const config = loadConfig();
    const schema = viewSchema(viewCatalog(config, ACTORS.billing, TODAY)) as {
      properties: { filters: { items: { properties: { field: { enum: string[] } } } } };
    };
    const fields = schema.properties.filters.items.properties.field.enum;
    expect(fields).toContain('member_id');
    expect(fields).not.toContain('phone');
    expect(fields).not.toContain('clinical_notes');
  });
});
