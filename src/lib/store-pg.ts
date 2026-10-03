import { Pool } from 'pg';
import type { CreateResult, Store } from './store';
import type {
  AuditEntry,
  DocumentRecord,
  NewAuditEntry,
  NewDocument,
  NewReferral,
  ReferralPatch,
  ReferralRecord,
  SavedView,
} from './types';

// start_of_care is read as text so node-postgres doesn't shift the date into local time.
const REFERRAL_COLUMNS =
  'id, ref_no, received_at, status, owner, start_of_care::text as start_of_care, data, flags, extraction, created_at, updated_at';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;

const iso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();

function toReferral(r: Row): ReferralRecord {
  return {
    id: String(r.id),
    refNo: String(r.ref_no),
    receivedAt: iso(r.received_at),
    status: String(r.status),
    owner: (r.owner as string | null) ?? null,
    startOfCare: (r.start_of_care as string | null) ?? null,
    data: (r.data as ReferralRecord['data']) ?? {},
    flags: (r.flags as ReferralRecord['flags']) ?? [],
    extraction: (r.extraction as ReferralRecord['extraction']) ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toView(r: Row): SavedView {
  return {
    slug: String(r.slug),
    title: String(r.title),
    config: r.config as SavedView['config'],
    yaml: String(r.yaml),
    prompt: (r.prompt as string | null) ?? null,
    createdBy: String(r.created_by),
    createdRole: String(r.created_role),
    createdAt: iso(r.created_at),
  };
}

export class PgStore implements Store {
  constructor(private readonly pool: Pool) {}

  static fromUrl(url: string): PgStore {
    return new PgStore(new Pool({ connectionString: url, max: 5 }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createReferralWithDocument(input: NewReferral, doc: NewDocument): Promise<CreateResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const existing = await client.query('select referral_id from documents where sha256 = $1', [doc.sha256]);
      if (existing.rows[0]) {
        await client.query('rollback');
        return { referral: null, duplicateOf: String(existing.rows[0].referral_id) };
      }
      const { rows } = await client.query(
        `insert into referrals (status, owner, received_at, start_of_care, data, flags, extraction)
         values ($1, $2, coalesce($3::timestamptz, now()), $4::date, $5::jsonb, $6::jsonb, $7::jsonb)
         returning ${REFERRAL_COLUMNS}`,
        [
          input.status,
          input.owner,
          input.receivedAt ?? null,
          input.startOfCare ?? null,
          JSON.stringify(input.data ?? {}),
          JSON.stringify(input.flags ?? []),
          input.extraction ? JSON.stringify(input.extraction) : null,
        ],
      );
      const referral = toReferral(rows[0]);
      await client.query(
        'insert into documents (referral_id, filename, mime, sha256, bytes) values ($1, $2, $3, $4, $5)',
        [referral.id, doc.filename, doc.mime, doc.sha256, doc.bytes],
      );
      await client.query('commit');
      return { referral, duplicateOf: null };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      // Two uploads of the same file at once: the unique index on sha256 lets one win.
      if ((err as { code?: string }).code === '23505') {
        const { rows } = await this.pool.query('select referral_id from documents where sha256 = $1', [doc.sha256]);
        if (rows[0]) return { referral: null, duplicateOf: String(rows[0].referral_id) };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getReferral(id: string) {
    if (!UUID_RE.test(id)) return null;
    const { rows } = await this.pool.query(`select ${REFERRAL_COLUMNS} from referrals where id = $1`, [id]);
    return rows[0] ? toReferral(rows[0]) : null;
  }

  async listReferrals() {
    const { rows } = await this.pool.query(`select ${REFERRAL_COLUMNS} from referrals order by received_at desc limit 500`);
    return rows.map(toReferral);
  }

  async updateReferral(id: string, patch: ReferralPatch) {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown, cast = '') => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.owner !== undefined) set('owner', patch.owner);
    if (patch.startOfCare !== undefined) set('start_of_care', patch.startOfCare, '::date');
    if (patch.data !== undefined) set('data', JSON.stringify(patch.data), '::jsonb');
    if (patch.flags !== undefined) set('flags', JSON.stringify(patch.flags), '::jsonb');
    if (patch.extraction !== undefined) set('extraction', patch.extraction ? JSON.stringify(patch.extraction) : null, '::jsonb');
    values.push(id);
    const { rows } = await this.pool.query(
      `update referrals set ${[...sets, 'updated_at = now()'].join(', ')} where id = $${values.length} returning ${REFERRAL_COLUMNS}`,
      values,
    );
    if (!rows[0]) throw new Error('Referral not found');
    return toReferral(rows[0]);
  }

  async getDocument(referralId: string): Promise<DocumentRecord | null> {
    if (!UUID_RE.test(referralId)) return null;
    const { rows } = await this.pool.query(
      'select referral_id, filename, mime, sha256, bytes from documents where referral_id = $1 order by created_at limit 1',
      [referralId],
    );
    const r = rows[0];
    return r
      ? { referralId: String(r.referral_id), filename: r.filename, mime: r.mime, sha256: r.sha256, bytes: r.bytes as Buffer }
      : null;
  }

  async saveView(view: SavedView) {
    await this.pool.query(
      `insert into saved_views (slug, title, config, yaml, prompt, created_by, created_role, created_at)
       values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
      [view.slug, view.title, JSON.stringify(view.config), view.yaml, view.prompt, view.createdBy, view.createdRole, view.createdAt],
    );
  }

  async getView(slug: string) {
    const { rows } = await this.pool.query('select * from saved_views where slug = $1', [slug]);
    return rows[0] ? toView(rows[0]) : null;
  }

  async listViews() {
    const { rows } = await this.pool.query('select * from saved_views order by created_at desc');
    return rows.map(toView);
  }

  async appendAudit(entry: NewAuditEntry) {
    await this.pool.query(
      `insert into audit_log (actor, role, action, outcome, referral_id, fields, detail)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [
        entry.actor,
        entry.role,
        entry.action,
        entry.outcome,
        entry.referralId && UUID_RE.test(entry.referralId) ? entry.referralId : null,
        JSON.stringify(entry.fields),
        JSON.stringify(entry.detail),
      ],
    );
  }

  async listAudit(opts: { referralId?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const { rows } = opts.referralId
      ? await this.pool.query('select * from audit_log where referral_id = $1 order by id desc limit $2', [
          UUID_RE.test(opts.referralId) ? opts.referralId : null,
          limit,
        ])
      : await this.pool.query('select * from audit_log order by id desc limit $1', [limit]);
    return rows.map((r) => ({
      id: Number(r.id),
      at: iso(r.at),
      actor: r.actor,
      role: r.role,
      action: r.action,
      outcome: r.outcome,
      referralId: r.referral_id,
      fields: r.fields ?? [],
      detail: r.detail ?? {},
    }));
  }
}
