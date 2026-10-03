export type AccessLevel = 'full' | 'masked' | 'hidden';

/** Where a field value came from: the model, a person, or the demo seed. */
export type FieldSource = 'model' | 'human' | 'seed';

export interface FieldValue {
  value: unknown;
  confidence: number | null;
  evidence: string | null;
  source: FieldSource;
  verified: boolean;
}

export type FlagKind = 'missing' | 'invalid' | 'review' | 'custom' | 'system';

export interface FlagHit {
  key: string;
  label: string;
  kind: FlagKind;
  blocking: boolean;
  field?: string;
  message?: string;
}

export interface ExtractionMeta {
  model: string;
  ms: number;
  fallbackUsed: boolean;
  error?: string;
}

export interface ReferralRecord {
  id: string;
  refNo: string;
  receivedAt: string;
  status: string;
  owner: string | null;
  startOfCare: string | null;
  data: Record<string, FieldValue>;
  flags: FlagHit[];
  extraction: ExtractionMeta | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewReferral {
  status: string;
  owner: string | null;
  receivedAt?: string;
  startOfCare?: string | null;
  data?: Record<string, FieldValue>;
  flags?: FlagHit[];
  extraction?: ExtractionMeta | null;
}

export type ReferralPatch = Partial<
  Pick<ReferralRecord, 'status' | 'owner' | 'startOfCare' | 'data' | 'flags' | 'extraction'>
>;

export interface DocumentRecord {
  referralId: string;
  filename: string;
  mime: string;
  sha256: string;
  bytes: Buffer;
}

export type NewDocument = Omit<DocumentRecord, 'referralId'>;

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'in'
  | 'contains'
  | 'before'
  | 'after'
  | 'has'
  | 'lacks'
  | 'is_empty'
  | 'is_not_empty';

export interface ViewFilter {
  field: string;
  op: FilterOp;
  values: string[];
}

export interface ViewConfig {
  title: string;
  description: string;
  filters: ViewFilter[];
  columns: string[];
  sort: { field: string; dir: 'asc' | 'desc' };
}

export interface SavedView {
  slug: string;
  title: string;
  config: ViewConfig;
  yaml: string;
  prompt: string | null;
  createdBy: string;
  createdRole: string;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  role: string;
  action: string;
  outcome: 'allowed' | 'denied';
  referralId: string | null;
  /** Field names only. Never field values. */
  fields: string[];
  detail: Record<string, unknown>;
}

export type NewAuditEntry = Omit<AuditEntry, 'id' | 'at'>;

export interface Actor {
  userId: string;
  name: string;
  role: string;
}
