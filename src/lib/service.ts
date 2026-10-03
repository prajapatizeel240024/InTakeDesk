import crypto from 'node:crypto';
import {
  accessLevel,
  can,
  canEditField,
  projectReferral,
  projectRow,
  visibleColumns,
  type ColumnView,
  type ReferralView,
  type RowView,
} from './access';
import type { Config, Permission } from './config';
import { normalizeValue, type Extractor } from './extract';
import { formatDateTime, todayIso } from './format';
import { isEmpty, isIsoDate } from './rules';
import type { Store } from './store';
import type { Actor, AuditEntry, ExtractionMeta, FieldValue, ReferralRecord, SavedView, ViewConfig } from './types';
import {
  canRunView,
  matchesView,
  slugify,
  sortRecords,
  validateView,
  viewCatalog,
  viewToYaml,
  type ViewAgent,
  type ViewCheck,
} from './views';
import { computeFlags, computeStatus } from './workflow';

export interface Ctx {
  config: Config;
  store: Store;
  extractor: Extractor;
  viewAgent: ViewAgent;
  /** Injected in tests so date rules don't depend on the clock. */
  today?: () => string;
}

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: string[],
  ) {
    super(message);
  }
}

const PERMISSION_TEXT: Record<Permission, string> = {
  view_queue: 'see the referral queue',
  view_referral: 'open referrals',
  view_document: 'open the original fax',
  upload: 'upload referrals',
  edit_fields: 'edit referral fields',
  change_status: 'change a referral’s status',
  assign_owner: 'assign owners',
  create_view: 'create views',
  view_audit: 'read the audit log',
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asReferralId = (id: string | undefined | null) => (id && UUID_RE.test(id) ? id : null);

const roleLabel = (ctx: Ctx, actor: Actor) => ctx.config.roles[actor.role]?.label ?? actor.role;
const today = (ctx: Ctx) => ctx.today?.() ?? todayIso();

async function audit(
  ctx: Ctx,
  actor: Actor,
  action: string,
  outcome: AuditEntry['outcome'],
  referralId: string | null,
  fields: string[] = [],
  detail: Record<string, unknown> = {},
) {
  await ctx.store.appendAudit({ actor: actor.userId, role: actor.role, action, outcome, referralId, fields, detail });
}

/** Throws 403 and writes a denied entry to the audit log when the role lacks the permission. */
export async function assertCan(ctx: Ctx, actor: Actor, permission: Permission, action: string, referralId: string | null = null) {
  if (can(ctx.config, actor.role, permission)) return;
  await audit(ctx, actor, action, 'denied', asReferralId(referralId), [], { reason: `${actor.role} lacks ${permission}` });
  throw new ServiceError(`${roleLabel(ctx, actor)} can't ${PERMISSION_TEXT[permission]}.`, 403);
}

async function mustGet(ctx: Ctx, id: string): Promise<ReferralRecord> {
  const rec = await ctx.store.getReferral(id);
  if (!rec) throw new ServiceError('Referral not found.', 404);
  return rec;
}

function recompute(ctx: Ctx, rec: Pick<ReferralRecord, 'data' | 'status' | 'extraction'>) {
  const flags = computeFlags(ctx.config, rec.data, { today: today(ctx), extractionError: rec.extraction?.error ?? null });
  return { flags, status: computeStatus(flags, rec.status) };
}

export interface QueueResult {
  columns: ColumnView[];
  rows: RowView[];
  counts: Record<string, number>;
  total: number;
}

export async function listQueue(
  ctx: Ctx,
  actor: Actor,
  opts: { view?: ViewConfig; viewSlug?: string; status?: string } = {},
): Promise<QueueResult> {
  await assertCan(ctx, actor, 'view_queue', 'list');
  const all = await ctx.store.listReferrals();
  const counts: Record<string, number> = Object.fromEntries(Object.keys(ctx.config.statuses).map((s) => [s, 0]));
  for (const r of all) counts[r.status] = (counts[r.status] ?? 0) + 1;

  let records = all;
  if (opts.view) records = sortRecords(opts.view, records.filter((r) => matchesView(ctx.config, opts.view as ViewConfig, r)));
  if (opts.status && ctx.config.statuses[opts.status]) records = records.filter((r) => r.status === opts.status);

  const columns = visibleColumns(ctx.config, actor.role, opts.view?.columns ?? ctx.config.queue.columns);
  const rows = records.map((r) => projectRow(ctx.config, r, actor.role, columns, (iso) => formatDateTime(iso)));
  const fieldColumns = columns.map((c) => c.key).filter((k) => ctx.config.fieldsByKey[k]);
  await audit(ctx, actor, 'list', 'allowed', null, fieldColumns, {
    count: rows.length,
    refs: records.map((r) => r.refNo),
    masked: fieldColumns.filter((k) => accessLevel(ctx.config.fieldsByKey[k], actor.role) === 'masked'),
    ...(opts.viewSlug ? { view: opts.viewSlug } : {}),
  });
  return { columns, rows, counts, total: all.length };
}

export async function getReferral(ctx: Ctx, actor: Actor, id: string): Promise<ReferralView> {
  await assertCan(ctx, actor, 'view_referral', 'view', id);
  const rec = await mustGet(ctx, id);
  const { view, shown, masked } = projectReferral(ctx.config, rec, actor.role);
  await audit(ctx, actor, 'view', 'allowed', rec.id, [...shown, ...masked], { ref: rec.refNo, masked });
  return view;
}

export async function uploadReferral(
  ctx: Ctx,
  actor: Actor,
  file: { filename: string; bytes: Buffer },
): Promise<{ referral: ReferralView; duplicate: boolean }> {
  await assertCan(ctx, actor, 'upload', 'upload');
  if (file.bytes.length === 0) throw new ServiceError('That file is empty.', 400);
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw new ServiceError('Referral PDFs must be 10 MB or smaller.', 400);
  if (file.bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ServiceError('Only PDF referrals can be uploaded.', 400);

  const sha256 = crypto.createHash('sha256').update(file.bytes).digest('hex');
  const created = await ctx.store.createReferralWithDocument(
    { status: 'new', owner: actor.userId, data: {}, flags: [], extraction: null },
    { filename: file.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'referral.pdf', mime: 'application/pdf', sha256, bytes: file.bytes },
  );

  // Idempotent: the same fax uploaded twice opens the referral we already have.
  if (!created.referral) {
    const existing = await mustGet(ctx, created.duplicateOf);
    await audit(ctx, actor, 'upload', 'allowed', existing.id, [], { ref: existing.refNo, duplicate: true });
    return { referral: projectReferral(ctx.config, existing, actor.role).view, duplicate: true };
  }

  const rec = created.referral;
  await audit(ctx, actor, 'upload', 'allowed', rec.id, [], { ref: rec.refNo, bytes: file.bytes.length });

  let data: Record<string, FieldValue> = {};
  let extraction: ExtractionMeta;
  try {
    const result = await ctx.extractor.extract({ pdf: file.bytes, ref: rec.refNo, config: ctx.config });
    data = result.data;
    extraction = result.meta;
  } catch (err) {
    extraction = { model: 'none', ms: 0, fallbackUsed: false, error: err instanceof Error ? err.message : 'Extraction failed.' };
  }

  const { flags, status } = recompute(ctx, { data, status: rec.status, extraction });
  const updated = await ctx.store.updateReferral(rec.id, { data, flags, status, extraction });
  await audit(ctx, actor, 'extract', 'allowed', rec.id, Object.keys(data).filter((k) => !isEmpty(data[k]?.value)), {
    ref: rec.refNo,
    model: extraction.model,
    ms: extraction.ms,
    fallbackUsed: extraction.fallbackUsed,
    failed: Boolean(extraction.error),
    flags: flags.map((f) => f.key),
  });
  return { referral: projectReferral(ctx.config, updated, actor.role).view, duplicate: false };
}

export async function updateFields(
  ctx: Ctx,
  actor: Actor,
  id: string,
  input: { set?: Record<string, unknown>; verify?: string[] },
): Promise<ReferralView> {
  await assertCan(ctx, actor, 'edit_fields', 'update', id);
  const rec = await mustGet(ctx, id);
  const set = input.set ?? {};
  const verify = (input.verify ?? []).filter((k) => !(k in set));
  const keys = [...new Set([...Object.keys(set), ...verify])];
  if (!keys.length) throw new ServiceError('Nothing to change.', 400);

  // Check every field before changing any, so a denied edit changes nothing.
  for (const key of keys) {
    const field = ctx.config.fieldsByKey[key];
    if (!field) throw new ServiceError(`There is no field called "${key}".`, 400);
    if (!canEditField(ctx.config, field, actor.role)) {
      await audit(ctx, actor, 'update', 'denied', rec.id, [key], { ref: rec.refNo, reason: `${actor.role} can't edit ${key}` });
      throw new ServiceError(`${roleLabel(ctx, actor)} can't edit ${field.label}.`, 403);
    }
  }

  const data = { ...rec.data };
  for (const [key, raw] of Object.entries(set)) {
    const field = ctx.config.fieldsByKey[key];
    data[key] = { value: normalizeValue(field, raw), confidence: 1, evidence: null, source: 'human', verified: true };
  }
  for (const key of verify) {
    const prev = data[key];
    if (prev) data[key] = { ...prev, verified: true };
  }

  const { flags, status } = recompute(ctx, { data, status: rec.status, extraction: rec.extraction });
  const updated = await ctx.store.updateReferral(rec.id, { data, flags, status });
  // Field names only. The new values stay out of the audit log.
  await audit(ctx, actor, 'update', 'allowed', rec.id, keys, {
    ref: rec.refNo,
    changed: Object.keys(set),
    verified: verify,
    status: rec.status === status ? status : `${rec.status} -> ${status}`,
  });
  return projectReferral(ctx.config, updated, actor.role).view;
}

export async function scheduleReferral(ctx: Ctx, actor: Actor, id: string, startOfCare: string): Promise<ReferralView> {
  await assertCan(ctx, actor, 'change_status', 'status', id);
  const rec = await mustGet(ctx, id);
  const { schedule } = ctx.config.workflow;
  if (!schedule.roles.includes(actor.role)) {
    await audit(ctx, actor, 'status', 'denied', rec.id, [], { ref: rec.refNo, reason: `${actor.role} can't schedule` });
    throw new ServiceError(`${roleLabel(ctx, actor)} can't schedule referrals.`, 403);
  }
  if (!schedule.from.includes(rec.status)) {
    await audit(ctx, actor, 'status', 'denied', rec.id, [], { ref: rec.refNo, reason: `status is ${rec.status}` });
    const allowed = schedule.from.map((s) => ctx.config.statuses[s]?.label ?? s).join(' or ');
    throw new ServiceError(`Only ${allowed} referrals can be scheduled. Clear the open items first.`, 409);
  }
  if (!isIsoDate(startOfCare)) throw new ServiceError('Pick a start-of-care date.', 400);
  const updated = await ctx.store.updateReferral(rec.id, { status: 'scheduled', startOfCare });
  await audit(ctx, actor, 'status', 'allowed', rec.id, [], { ref: rec.refNo, from: rec.status, to: 'scheduled' });
  return projectReferral(ctx.config, updated, actor.role).view;
}

export async function assignOwner(ctx: Ctx, actor: Actor, id: string, owner: string | null): Promise<ReferralView> {
  await assertCan(ctx, actor, 'assign_owner', 'assign', id);
  const rec = await mustGet(ctx, id);
  if (owner !== null && !ctx.config.users[owner]) throw new ServiceError('That person is not on the team.', 400);
  const updated = await ctx.store.updateReferral(rec.id, { owner });
  await audit(ctx, actor, 'assign', 'allowed', rec.id, [], { ref: rec.refNo, from: rec.owner, to: owner });
  return projectReferral(ctx.config, updated, actor.role).view;
}

export async function getDocument(ctx: Ctx, actor: Actor, id: string): Promise<{ filename: string; bytes: Buffer }> {
  await assertCan(ctx, actor, 'view_document', 'view_document', id);
  const rec = await mustGet(ctx, id);
  const doc = await ctx.store.getDocument(rec.id);
  if (!doc) throw new ServiceError('No document is stored for this referral.', 404);
  await audit(ctx, actor, 'view_document', 'allowed', rec.id, [], { ref: rec.refNo });
  // Named by referral number, not the original file name, which may carry a patient's name.
  return { filename: `${rec.refNo}.pdf`, bytes: doc.bytes };
}

export async function listAudit(
  ctx: Ctx,
  actor: Actor,
  opts: { referralId?: string; limit?: number } = {},
): Promise<(AuditEntry & { refNo: string | null })[]> {
  await assertCan(ctx, actor, 'view_audit', 'view_audit', opts.referralId);
  const [entries, referrals] = await Promise.all([
    ctx.store.listAudit({ referralId: opts.referralId, limit: opts.limit ?? 200 }),
    ctx.store.listReferrals(),
  ]);
  const refNos = new Map(referrals.map((r) => [r.id, r.refNo]));
  await audit(ctx, actor, 'view_audit', 'allowed', asReferralId(opts.referralId), [], { count: entries.length });
  return entries.map((e) => ({ ...e, refNo: e.referralId ? (refNos.get(e.referralId) ?? null) : null }));
}

export async function createView(ctx: Ctx, actor: Actor, prompt: string): Promise<SavedView> {
  await assertCan(ctx, actor, 'create_view', 'create_view');
  const text = prompt.trim();
  if (text.length < 3 || text.length > 300) throw new ServiceError('Describe the view in 3 to 300 characters.', 400);

  const catalog = viewCatalog(ctx.config, actor, today(ctx));
  let check: ViewCheck | null = null;
  let feedback: { previous: unknown; errors: string[] } | undefined;
  let attempts = 0;
  // One retry: the checker's complaints go back to the agent so it can fix its own config.
  while (attempts < 2) {
    attempts++;
    let raw: unknown;
    try {
      raw = await ctx.viewAgent.propose({ prompt: text, catalog, hints: ctx.config.view_agent.hints, feedback });
    } catch (err) {
      throw new ServiceError(err instanceof Error ? err.message : 'The view agent failed.', 502);
    }
    check = validateView(ctx.config, raw, actor.role);
    if (check.ok) break;
    feedback = { previous: raw, errors: check.errors };
  }
  if (!check || !check.ok) {
    const errors = check && !check.ok ? check.errors : [];
    await audit(ctx, actor, 'create_view', 'denied', null, [], { reason: 'view failed the checks', errors, attempts });
    throw new ServiceError("The agent's view didn't pass the checks.", 422, errors);
  }

  const base = slugify(check.view.title);
  let slug = base;
  for (let n = 2; await ctx.store.getView(slug); n++) slug = `${base}-${n}`;
  const saved: SavedView = {
    slug,
    title: check.view.title,
    config: check.view,
    yaml: viewToYaml(slug, check.view, { prompt: text, createdBy: actor.userId, createdRole: actor.role }),
    prompt: text,
    createdBy: actor.userId,
    createdRole: actor.role,
    createdAt: new Date().toISOString(),
  };
  await ctx.store.saveView(saved);
  await audit(ctx, actor, 'create_view', 'allowed', null, check.view.filters.map((f) => f.field).filter((k) => ctx.config.fieldsByKey[k]), {
    slug,
    attempts,
  });
  return saved;
}

/** Only the views this role is allowed to run. */
export async function listViews(ctx: Ctx, actor: Actor): Promise<SavedView[]> {
  if (!can(ctx.config, actor.role, 'view_queue')) return [];
  const views = await ctx.store.listViews();
  return views.filter((v) => canRunView(ctx.config, v.config, actor.role).ok);
}

export async function runView(ctx: Ctx, actor: Actor, slug: string): Promise<{ view: SavedView; queue: QueueResult }> {
  await assertCan(ctx, actor, 'view_queue', 'run_view');
  const view = await ctx.store.getView(slug);
  if (!view) throw new ServiceError('View not found.', 404);
  const check = canRunView(ctx.config, view.config, actor.role);
  if (!check.ok) {
    await audit(ctx, actor, 'run_view', 'denied', null, [], { slug, reason: check.reason });
    throw new ServiceError(check.reason, 403);
  }
  const queue = await listQueue(ctx, actor, { view: view.config, viewSlug: slug });
  return { view, queue };
}
