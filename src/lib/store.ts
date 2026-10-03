import crypto from 'node:crypto';
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

export type CreateResult =
  | { referral: ReferralRecord; duplicateOf: null }
  | { referral: null; duplicateOf: string };

/**
 * Storage for referrals, their source documents, saved views and the audit log.
 * Note what is missing: there is no way to change or delete an audit entry.
 */
export interface Store {
  /** Creates a referral and its document together. If the same file was uploaded before, returns that referral's id instead. */
  createReferralWithDocument(input: NewReferral, doc: NewDocument): Promise<CreateResult>;
  getReferral(id: string): Promise<ReferralRecord | null>;
  listReferrals(): Promise<ReferralRecord[]>;
  updateReferral(id: string, patch: ReferralPatch): Promise<ReferralRecord>;
  getDocument(referralId: string): Promise<DocumentRecord | null>;
  saveView(view: SavedView): Promise<void>;
  getView(slug: string): Promise<SavedView | null>;
  listViews(): Promise<SavedView[]>;
  appendAudit(entry: NewAuditEntry): Promise<void>;
  listAudit(opts?: { referralId?: string; limit?: number }): Promise<AuditEntry[]>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
  private referrals: ReferralRecord[] = [];
  private documents: DocumentRecord[] = [];
  private views: SavedView[] = [];
  private audit: AuditEntry[] = [];
  private nextRef = 1001;
  private nextAuditId = 1;

  async createReferralWithDocument(input: NewReferral, doc: NewDocument): Promise<CreateResult> {
    const existing = this.documents.find((d) => d.sha256 === doc.sha256);
    if (existing) return { referral: null, duplicateOf: existing.referralId };
    const now = new Date().toISOString();
    const rec: ReferralRecord = {
      id: crypto.randomUUID(),
      refNo: `R-${this.nextRef++}`,
      receivedAt: input.receivedAt ?? now,
      status: input.status,
      owner: input.owner,
      startOfCare: input.startOfCare ?? null,
      data: clone(input.data ?? {}),
      flags: clone(input.flags ?? []),
      extraction: clone(input.extraction ?? null),
      createdAt: now,
      updatedAt: now,
    };
    this.referrals.push(rec);
    this.documents.push({ ...doc, referralId: rec.id, bytes: Buffer.from(doc.bytes) });
    return { referral: clone(rec), duplicateOf: null };
  }

  async getReferral(id: string) {
    const rec = this.referrals.find((r) => r.id === id);
    return rec ? clone(rec) : null;
  }

  async listReferrals() {
    return [...this.referrals].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).map(clone);
  }

  async updateReferral(id: string, patch: ReferralPatch) {
    const rec = this.referrals.find((r) => r.id === id);
    if (!rec) throw new Error('Referral not found');
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (rec as unknown as Record<string, unknown>)[key] = clone(value);
    }
    rec.updatedAt = new Date().toISOString();
    return clone(rec);
  }

  async getDocument(referralId: string) {
    const doc = this.documents.find((d) => d.referralId === referralId);
    return doc ? { ...doc, bytes: Buffer.from(doc.bytes) } : null;
  }

  async saveView(view: SavedView) {
    if (this.views.some((v) => v.slug === view.slug)) throw new Error(`A view called ${view.slug} already exists`);
    this.views.push(clone(view));
  }

  async getView(slug: string) {
    const view = this.views.find((v) => v.slug === slug);
    return view ? clone(view) : null;
  }

  async listViews() {
    return [...this.views].reverse().map(clone);
  }

  async appendAudit(entry: NewAuditEntry) {
    this.audit.push({ ...clone(entry), id: this.nextAuditId++, at: new Date().toISOString() });
  }

  async listAudit(opts: { referralId?: string; limit?: number } = {}) {
    const rows = opts.referralId ? this.audit.filter((a) => a.referralId === opts.referralId) : this.audit;
    return rows.slice(-(opts.limit ?? 200)).reverse().map(clone);
  }
}
