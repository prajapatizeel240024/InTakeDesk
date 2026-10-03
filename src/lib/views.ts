import Anthropic from '@anthropic-ai/sdk';
import YAML from 'yaml';
import { z } from 'zod';
import { accessLevel } from './access';
import { SYSTEM_COLUMNS, type Config, type FieldDef } from './config';
import { modelChain } from './extract';
import { localDate } from './format';
import { isEmpty, isIsoDate } from './rules';
import type { FilterOp, ReferralRecord, ViewConfig, ViewFilter } from './types';

type FilterKind = FieldDef['type'] | 'status' | 'owner' | 'received_at' | 'flags' | 'ref_no';

export const ALL_OPS: FilterOp[] = ['eq', 'neq', 'in', 'contains', 'before', 'after', 'has', 'lacks', 'is_empty', 'is_not_empty'];

const OPS: Record<FilterKind, FilterOp[]> = {
  string: ['eq', 'neq', 'contains', 'is_empty', 'is_not_empty'],
  text: ['contains', 'is_empty', 'is_not_empty'],
  phone: ['eq', 'contains', 'is_empty', 'is_not_empty'],
  date: ['eq', 'before', 'after', 'is_empty', 'is_not_empty'],
  enum: ['eq', 'neq', 'in', 'is_empty', 'is_not_empty'],
  multi_enum: ['has', 'lacks', 'is_empty', 'is_not_empty'],
  code_list: ['has', 'lacks', 'contains', 'is_empty', 'is_not_empty'],
  boolean: ['eq', 'is_empty', 'is_not_empty'],
  status: ['eq', 'neq', 'in'],
  owner: ['eq', 'neq', 'is_empty', 'is_not_empty'],
  received_at: ['eq', 'before', 'after'],
  flags: ['has', 'lacks', 'is_empty', 'is_not_empty'],
  ref_no: ['eq', 'contains'],
};

const SYSTEM_FILTERS: Record<string, string> = {
  status: 'Status',
  owner: 'Owner',
  received_at: 'Received date',
  flags: 'Flags',
  ref_no: 'Ref',
};

function kindOf(config: Config, key: string): FilterKind | null {
  if (key in SYSTEM_FILTERS) return key as FilterKind;
  return config.fieldsByKey[key]?.type ?? null;
}

/** Flag keys a role may filter on. Flags about fields the role can't see in full are left out. */
export function flagCatalog(config: Config, role: string): { key: string; label: string }[] {
  const out = [{ key: 'extraction_failed', label: 'Extraction failed' }];
  for (const [key, flag] of Object.entries(config.flags)) out.push({ key, label: flag.label });
  for (const field of config.fields) {
    if (accessLevel(field, role) !== 'full') continue;
    if (field.required || field.required_when) out.push({ key: `missing:${field.key}`, label: `Missing ${field.label}` });
    out.push({ key: `invalid:${field.key}`, label: `Problem with ${field.label}` });
    out.push({ key: `review:${field.key}`, label: `${field.label} needs a person to check it` });
  }
  out.push(
    { key: 'missing:*', label: 'Any missing field' },
    { key: 'invalid:*', label: 'Any field with a problem' },
    { key: 'review:*', label: 'Any field waiting for a check' },
  );
  return out;
}

function flagField(flagKey: string): string | null {
  const [kind, field] = flagKey.split(':');
  return kind && field && field !== '*' ? field : null;
}

export function columnCatalog(config: Config, role: string): string[] {
  return [...Object.keys(SYSTEM_COLUMNS), ...config.fields.filter((f) => accessLevel(f, role) !== 'hidden').map((f) => f.key)];
}

export type ViewCatalog = ReturnType<typeof viewCatalog>;

/** Everything the view agent may use for this person: only fields their role can fully see can be filtered on. */
export function viewCatalog(config: Config, actor: { userId: string; role: string }, today: string) {
  return {
    today,
    you: actor.userId,
    fields: config.fields
      .filter((f) => accessLevel(f, actor.role) === 'full')
      .map((f) => ({ key: f.key, label: f.label, type: f.type, ops: OPS[f.type], ...(f.values ? { values: f.values } : {}) })),
    system: [
      { key: 'status', label: 'Status', ops: OPS.status, values: Object.keys(config.statuses) },
      { key: 'owner', label: 'Owner', ops: OPS.owner, values: Object.keys(config.users) },
      { key: 'received_at', label: 'Received date', ops: OPS.received_at },
      { key: 'flags', label: 'Flags', ops: OPS.flags },
      { key: 'ref_no', label: 'Ref', ops: OPS.ref_no },
    ],
    flags: flagCatalog(config, actor.role),
    columns: columnCatalog(config, actor.role),
  };
}

const rawViewSchema = z.object({
  title: z.string().trim().min(3).max(80),
  description: z.string().trim().max(240).default(''),
  filters: z
    .array(z.object({ field: z.string(), op: z.enum(ALL_OPS as [FilterOp, ...FilterOp[]]), values: z.array(z.string()).default([]) }))
    .max(8),
  columns: z.array(z.string()).min(1).max(10),
  sort_field: z.string().default('received_at'),
  sort_dir: z.enum(['asc', 'desc']).default('desc'),
});

export type ViewCheck = { ok: true; view: ViewConfig } | { ok: false; errors: string[] };

function resolveValues(
  config: Config,
  role: string,
  kind: FilterKind,
  field: FieldDef | undefined,
  op: FilterOp,
  values: string[],
): { values: string[] } | { error: string } {
  if (op === 'is_empty' || op === 'is_not_empty') return { values: [] };
  if (!values.length) return { error: 'needs a value' };
  if (op !== 'in' && values.length > 1) return { error: `"${op}" takes one value` };
  const pick = (allowed: string[]) => {
    const out: string[] = [];
    for (const v of values) {
      const match = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
      if (!match) return { error: `"${v}" isn't a value it can have. Use one of: ${allowed.join(', ')}` };
      out.push(match);
    }
    return { values: out };
  };
  switch (kind) {
    case 'enum':
    case 'multi_enum':
      return pick(field?.values ?? []);
    case 'status':
      return pick(Object.keys(config.statuses));
    case 'owner':
      return pick(Object.keys(config.users));
    case 'boolean':
      return pick(['true', 'false']);
    case 'flags': {
      const known = flagCatalog(config, role).map((f) => f.key);
      const bad = values.find((v) => !known.includes(v));
      return bad ? { error: `"${bad}" isn't a flag your role can filter on` } : { values };
    }
    case 'date':
    case 'received_at':
      return values.every(isIsoDate) ? { values } : { error: 'dates must be YYYY-MM-DD' };
    default:
      return { values };
  }
}

/** Checks an agent-written view against config/intake.yaml and the role that asked for it. */
export function validateView(config: Config, raw: unknown, role: string): ViewCheck {
  const parsed = rawViewSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'view'}: ${i.message}`) };
  }
  const v = parsed.data;
  const errors: string[] = [];
  const filters: ViewFilter[] = [];

  v.filters.forEach((f, i) => {
    const where = `filter ${i + 1} (${f.field})`;
    const kind = kindOf(config, f.field);
    if (!kind) return errors.push(`${where}: no such field`);
    const field = config.fieldsByKey[f.field];
    if (field && accessLevel(field, role) !== 'full') {
      return errors.push(`${where}: your role can only filter on fields it can fully see, and ${field.label} is ${accessLevel(field, role)} for you`);
    }
    if (!OPS[kind].includes(f.op)) return errors.push(`${where}: "${f.op}" doesn't work here. Use one of: ${OPS[kind].join(', ')}`);
    const resolved = resolveValues(config, role, kind, field, f.op, f.values.map((x) => x.trim()).filter(Boolean));
    if ('error' in resolved) return errors.push(`${where}: ${resolved.error}`);
    filters.push({ field: f.field, op: f.op, values: resolved.values });
  });

  const allowedColumns = new Set(columnCatalog(config, role));
  const columns = [...new Set(v.columns)];
  for (const c of columns) if (!allowedColumns.has(c)) errors.push(`column ${c}: no such column, or your role can't see it`);

  const sortField = config.fieldsByKey[v.sort_field];
  const sortable = v.sort_field in SYSTEM_FILTERS ? v.sort_field !== 'flags' : Boolean(sortField) && accessLevel(sortField, role) === 'full';
  if (!sortable) errors.push(`sort: can't sort by ${v.sort_field}`);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    view: { title: v.title, description: v.description, filters, columns, sort: { field: v.sort_field, dir: v.sort_dir } },
  };
}

/**
 * A saved view can only be run by a role that can fully see every field it
 * filters on. Otherwise the result list itself would leak what's in those
 * fields: "everyone whose clinical notes mention a fall".
 */
export function canRunView(config: Config, view: ViewConfig, role: string): { ok: true } | { ok: false; reason: string } {
  for (const f of view.filters) {
    const keys = f.field === 'flags' ? f.values.map(flagField).filter((k): k is string => Boolean(k)) : [f.field];
    for (const key of keys) {
      if (key in SYSTEM_FILTERS) continue;
      const field = config.fieldsByKey[key];
      if (!field) return { ok: false, reason: `This view uses ${key}, which is no longer in the config.` };
      if (accessLevel(field, role) !== 'full') {
        return { ok: false, reason: `This view filters on ${field.label}, which your role can't fully see, so you can't run it.` };
      }
    }
  }
  return { ok: true };
}

function filterValue(rec: ReferralRecord, key: string): unknown {
  switch (key) {
    case 'status':
      return rec.status;
    case 'owner':
      return rec.owner;
    case 'received_at':
      return localDate(rec.receivedAt);
    case 'flags':
      return rec.flags.map((f) => f.key);
    case 'ref_no':
      return rec.refNo;
    default:
      return rec.data[key]?.value;
  }
}

const lc = (x: unknown) => String(x).trim().toLowerCase();
const keyMatches = (value: unknown, pattern: string) =>
  pattern.endsWith('*') ? lc(value).startsWith(lc(pattern.slice(0, -1))) : lc(value) === lc(pattern);

function matchFilter(config: Config, f: ViewFilter, rec: ReferralRecord): boolean {
  const value = filterValue(rec, f.field);
  const target = f.values[0] ?? '';
  switch (f.op) {
    case 'is_empty':
      return isEmpty(value);
    case 'is_not_empty':
      return !isEmpty(value);
    case 'eq':
      if (kindOf(config, f.field) === 'boolean') return value === (target === 'true');
      return !isEmpty(value) && lc(value) === lc(target);
    case 'neq':
      return isEmpty(value) || lc(value) !== lc(target);
    case 'in':
      return !isEmpty(value) && f.values.map(lc).includes(lc(value));
    case 'contains':
      return Array.isArray(value) ? value.some((x) => lc(x).includes(lc(target))) : !isEmpty(value) && lc(value).includes(lc(target));
    case 'before':
      return typeof value === 'string' && value < target;
    case 'after':
      return typeof value === 'string' && value > target;
    case 'has':
      return Array.isArray(value) && value.some((x) => keyMatches(x, target));
    case 'lacks':
      return !Array.isArray(value) || !value.some((x) => keyMatches(x, target));
    default:
      return false;
  }
}

export function matchesView(config: Config, view: ViewConfig, rec: ReferralRecord): boolean {
  return view.filters.every((f) => matchFilter(config, f, rec));
}

export function sortRecords(view: ViewConfig, records: ReferralRecord[]): ReferralRecord[] {
  const { field, dir } = view.sort;
  const valueOf = (r: ReferralRecord) => {
    const v = field === 'received_at' ? r.receivedAt : filterValue(r, field);
    if (isEmpty(v)) return null;
    return Array.isArray(v) ? v.join(',').toLowerCase() : String(v).toLowerCase();
  };
  const sign = dir === 'asc' ? 1 : -1;
  return [...records].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -sign : sign;
  });
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'view'
  );
}

export function viewToYaml(slug: string, view: ViewConfig, meta: { prompt: string | null; createdBy: string; createdRole: string }): string {
  const doc = {
    view: slug,
    title: view.title,
    description: view.description,
    filters: view.filters.map((f) => ({
      field: f.field,
      op: f.op,
      ...(f.values.length ? { value: f.values.length === 1 ? f.values[0] : f.values } : {}),
    })),
    columns: view.columns,
    sort: view.sort,
    created_by: `${meta.createdBy} (${meta.createdRole})`,
    ...(meta.prompt ? { asked_for: meta.prompt } : {}),
  };
  return `# Written by the view agent, then checked against config/intake.yaml\n${YAML.stringify(doc, { lineWidth: 100 })}`;
}

export interface ViewAgent {
  propose(input: {
    prompt: string;
    catalog: ViewCatalog;
    hints: string[];
    feedback?: { previous: unknown; errors: string[] };
  }): Promise<unknown>;
}

/** The structured output schema. Enums come from the catalog, so the model can't name a field the role can't use. */
export function viewSchema(catalog: ViewCatalog): Record<string, unknown> {
  const filterFields = [...catalog.fields.map((f) => f.key), ...catalog.system.map((s) => s.key)];
  const sortFields = [...catalog.fields.map((f) => f.key), 'status', 'owner', 'received_at', 'ref_no'];
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title in sentence case' },
      description: { type: 'string', description: 'One sentence on what the list shows' },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: filterFields },
            op: { type: 'string', enum: ALL_OPS },
            values: { type: 'array', items: { type: 'string' } },
          },
          required: ['field', 'op', 'values'],
          additionalProperties: false,
        },
      },
      columns: { type: 'array', items: { type: 'string', enum: catalog.columns } },
      sort_field: { type: 'string', enum: sortFields },
      sort_dir: { type: 'string', enum: ['asc', 'desc'] },
    },
    required: ['title', 'description', 'filters', 'columns', 'sort_field', 'sort_dir'],
    additionalProperties: false,
  };
}

const VIEW_PROMPT = [
  "You turn a home health intake operator's plain-English request into a saved view of their referral queue.",
  '- Use only the fields, operators and values in the catalog. Values are strings. Use ["true"] or ["false"] for yes/no fields.',
  '- Every filter must match (they are ANDed). Filter as narrowly as the request says, and no narrower.',
  '- Pick 4 to 7 columns that help the operator act on the list. Always include ref_no, status and next_action.',
  '- Sort by received_at desc unless the request implies another order, like "oldest first".',
].join('\n');

export function createClaudeViewAgent(): ViewAgent {
  let client: Anthropic | null = null;
  return {
    async propose({ prompt, catalog, hints, feedback }) {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set, so the view agent is off.');
      client ??= new Anthropic({ maxRetries: 2, timeout: 60_000 });
      const lines = [
        'Catalog of what this operator can filter on and show:',
        JSON.stringify(catalog),
        '',
        'Vocabulary:',
        ...hints.map((h) => `- ${h}`),
        '',
        `Request: ${prompt}`,
      ];
      if (feedback) {
        lines.push('', 'Your last attempt was rejected by the checks:', JSON.stringify(feedback.previous), 'Problems:');
        lines.push(...feedback.errors.map((e) => `- ${e}`), 'Fix these and try again.');
      }
      const res = await client.messages.create({
        model: modelChain()[0],
        max_tokens: 1500,
        system: VIEW_PROMPT,
        output_config: { format: { type: 'json_schema', schema: viewSchema(catalog) } },
        messages: [{ role: 'user', content: lines.join('\n') }],
      });
      const text = res.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      return JSON.parse(text);
    },
  };
}
