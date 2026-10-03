import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { AccessLevel } from './types';

export const PERMISSIONS = [
  'view_queue',
  'view_referral',
  'view_document',
  'upload',
  'edit_fields',
  'change_status',
  'assign_owner',
  'create_view',
  'view_audit',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const FIELD_TYPES = ['string', 'text', 'date', 'phone', 'enum', 'multi_enum', 'code_list', 'boolean'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const RULE_CHECKS = ['past_date', 'npi', 'mbi', 'icd10', 'phone_us'] as const;

/** The workflow engine relies on these four statuses existing. */
export const REQUIRED_STATUSES = ['new', 'missing_info', 'ready', 'scheduled'] as const;

/** Columns that are not fields in the YAML but can appear in the queue and in views. */
export const SYSTEM_COLUMNS = {
  ref_no: 'Ref',
  status: 'Status',
  next_action: 'Next action',
  owner: 'Owner',
  received_at: 'Received',
  flags: 'Flags',
} as const;

const conditionSchema = z.strictObject({
  field: z.string(),
  equals: z.union([z.string(), z.boolean()]).optional(),
  in: z.array(z.string()).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

const ruleSchema = z
  .strictObject({
    check: z.enum(RULE_CHECKS).optional(),
    pattern: z.string().optional(),
    message: z.string().optional(),
    when: conditionSchema.optional(),
  })
  .refine((r) => Boolean(r.check) !== Boolean(r.pattern), {
    message: 'a rule needs exactly one of "check" or "pattern"',
  });
export type Rule = z.infer<typeof ruleSchema>;

const fieldSchema = z.strictObject({
  label: z.string(),
  type: z.enum(FIELD_TYPES),
  values: z.array(z.string()).optional(),
  value_labels: z.record(z.string(), z.string()).optional(),
  required: z.boolean().default(false),
  required_when: conditionSchema.optional(),
  phi: z.boolean().default(false),
  mask: z.enum(['name', 'last4', 'year', 'redact']).default('redact'),
  compare: z.enum(['exact', 'text', 'name', 'address', 'digits', 'id']).optional(),
  access: z.record(z.string(), z.enum(['full', 'masked', 'hidden'])).optional(),
  edit: z.array(z.string()).optional(),
  rules: z.array(ruleSchema).default([]),
  extract: z.string(),
});

const configSchema = z.strictObject({
  version: z.literal(1),
  app: z.strictObject({ name: z.string(), org: z.string(), note: z.string().optional() }),
  roles: z.record(z.string(), z.strictObject({ label: z.string(), can: z.array(z.enum(PERMISSIONS)) })),
  users: z.record(z.string(), z.strictObject({ name: z.string(), role: z.string() })),
  defaults: z.strictObject({ edit: z.array(z.string()).default([]) }).default({ edit: [] }),
  statuses: z.record(z.string(), z.strictObject({ label: z.string(), tone: z.string() })),
  workflow: z.strictObject({
    review_threshold: z.number().min(0).max(1),
    schedule: z.strictObject({ roles: z.array(z.string()), from: z.array(z.string()) }),
  }),
  concepts: z.record(
    z.string(),
    z.strictObject({ label: z.string(), fields: z.record(z.string(), fieldSchema) }),
  ),
  flags: z
    .record(
      z.string(),
      z.strictObject({ label: z.string(), blocking: z.boolean().default(true), when: conditionSchema }),
    )
    .default({}),
  next_actions: z.array(z.strictObject({ when: z.string(), text: z.string() })),
  queue: z.strictObject({ columns: z.array(z.string()).min(1) }),
  view_agent: z.strictObject({ hints: z.array(z.string()).default([]) }).default({ hints: [] }),
});

type RawConfig = z.infer<typeof configSchema>;
type RawField = z.infer<typeof fieldSchema>;

export interface FieldDef extends Omit<RawField, 'access' | 'edit'> {
  key: string;
  concept: string;
  conceptLabel: string;
  /** Resolved for every role. Missing entries default to hidden for PHI, full otherwise. */
  access: Record<string, AccessLevel>;
  edit: string[];
}

export interface Config extends RawConfig {
  fields: FieldDef[];
  fieldsByKey: Record<string, FieldDef>;
}

export function parseConfig(text: string, source = 'config/intake.yaml'): Config {
  const parsed = configSchema.safeParse(YAML.parse(text));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`${source} is not valid:\n${lines.join('\n')}`);
  }
  const raw = parsed.data;
  const problems: string[] = [];
  const roleIds = Object.keys(raw.roles);

  const fields: FieldDef[] = [];
  for (const [conceptKey, concept] of Object.entries(raw.concepts)) {
    for (const [key, f] of Object.entries(concept.fields)) {
      if (fields.some((x) => x.key === key)) problems.push(`field "${key}" is defined twice`);
      const access: Record<string, AccessLevel> = {};
      for (const role of roleIds) {
        const level = f.access?.[role];
        if (!level && f.phi) problems.push(`PHI field "${key}" must set access for role "${role}"`);
        access[role] = level ?? (f.phi ? 'hidden' : 'full');
      }
      for (const role of Object.keys(f.access ?? {})) {
        if (!roleIds.includes(role)) problems.push(`field "${key}" sets access for unknown role "${role}"`);
      }
      const edit = f.edit ?? raw.defaults.edit;
      for (const role of edit) {
        if (!roleIds.includes(role)) problems.push(`field "${key}" lets unknown role "${role}" edit it`);
      }
      if ((f.type === 'enum' || f.type === 'multi_enum') && !f.values?.length) {
        problems.push(`field "${key}" is ${f.type} but lists no values`);
      }
      for (const rule of f.rules) {
        if (rule.pattern) {
          try {
            new RegExp(rule.pattern);
          } catch {
            problems.push(`field "${key}" has a pattern that is not a valid regular expression`);
          }
        }
      }
      fields.push({ ...f, key, concept: conceptKey, conceptLabel: concept.label, access, edit });
    }
  }
  const fieldsByKey = Object.fromEntries(fields.map((f) => [f.key, f]));

  const checkCondition = (where: string, c?: Condition) => {
    if (c && !fieldsByKey[c.field]) problems.push(`${where} refers to unknown field "${c.field}"`);
  };
  for (const f of fields) {
    checkCondition(`field "${f.key}" required_when`, f.required_when);
    for (const r of f.rules) checkCondition(`a rule on field "${f.key}"`, r.when);
  }
  for (const [key, flag] of Object.entries(raw.flags)) checkCondition(`flag "${key}"`, flag.when);
  for (const [id, user] of Object.entries(raw.users)) {
    if (!roleIds.includes(user.role)) problems.push(`user "${id}" has unknown role "${user.role}"`);
  }
  for (const s of REQUIRED_STATUSES) {
    if (!raw.statuses[s]) problems.push(`status "${s}" is required by the workflow`);
  }
  for (const r of raw.workflow.schedule.roles) {
    if (!roleIds.includes(r)) problems.push(`workflow.schedule names unknown role "${r}"`);
  }
  for (const s of raw.workflow.schedule.from) {
    if (!raw.statuses[s]) problems.push(`workflow.schedule names unknown status "${s}"`);
  }
  for (const c of raw.queue.columns) {
    if (!fieldsByKey[c] && !(c in SYSTEM_COLUMNS)) problems.push(`queue column "${c}" is not a field or a system column`);
  }

  if (problems.length) {
    throw new Error(`${source} is not valid:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  return { ...raw, fields, fieldsByKey };
}

export function configPath(root = process.cwd()): string {
  return path.join(root, 'config', 'intake.yaml');
}

let cached: { config: Config; mtimeMs: number } | null = null;

/** Reads config/intake.yaml, and again whenever the file changes on disk. */
export function getConfig(): Config {
  const file = configPath();
  const { mtimeMs } = fs.statSync(file);
  if (!cached || cached.mtimeMs !== mtimeMs) {
    cached = { config: parseConfig(fs.readFileSync(file, 'utf8')), mtimeMs };
  }
  return cached.config;
}
