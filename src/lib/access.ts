import { SYSTEM_COLUMNS, type Config, type FieldDef, type Permission } from './config';
import { formatDate, humanize } from './format';
import { isEmpty, isIsoDate } from './rules';
import type { AccessLevel, FieldSource, FlagKind, ReferralRecord } from './types';
import { nextAction } from './workflow';

export function can(config: Config, role: string, permission: Permission): boolean {
  return config.roles[role]?.can.includes(permission) ?? false;
}

export function accessLevel(field: FieldDef, role: string): AccessLevel {
  return field.access[role] ?? 'hidden';
}

/** A person can only edit a field they can fully see. No editing blind. */
export function canEditField(config: Config, field: FieldDef, role: string): boolean {
  return can(config, role, 'edit_fields') && field.edit.includes(role) && accessLevel(field, role) === 'full';
}

export function valueLabel(field: FieldDef, value: string): string {
  return field.value_labels?.[value] ?? humanize(value);
}

export function displayValue(field: FieldDef, value: unknown): string {
  if (isEmpty(value)) return '—';
  switch (field.type) {
    case 'date':
      return formatDate(String(value));
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    case 'enum':
      return valueLabel(field, String(value));
    case 'multi_enum':
      return (value as unknown[]).map((v) => valueLabel(field, String(v))).join(', ');
    case 'code_list':
      return (value as unknown[]).map(String).join(', ');
    default:
      return String(value);
  }
}

/** Masks a value the way the field's YAML says. The real value never leaves the server. */
export function maskValue(field: FieldDef, value: unknown): string {
  if (isEmpty(value)) return '—';
  const s = Array.isArray(value) ? value.join(', ') : String(value);
  switch (field.mask) {
    case 'name':
      return s
        .split(/\s+/)
        .map((w) => (w ? w[0] + '•'.repeat(Math.max(2, w.length - 1)) : w))
        .join(' ');
    case 'last4': {
      const total = (s.match(/[A-Za-z0-9]/g) ?? []).length;
      let seen = 0;
      return s.replace(/[A-Za-z0-9]/g, (ch) => (++seen > total - 4 ? ch : '•'));
    }
    case 'year':
      return isIsoDate(s) ? `••/••/${s.slice(0, 4)}` : '••••';
    default:
      return '••••••••';
  }
}

/** Identifiers and codes are set in mono so 0 and O, 1 and I can be told apart. */
export function isIdentifier(field: FieldDef): boolean {
  return field.compare === 'id' || field.type === 'code_list' || field.type === 'phone';
}

export interface FieldView {
  key: string;
  label: string;
  type: FieldDef['type'];
  access: 'full' | 'masked';
  value: unknown;
  display: string;
  mono: boolean;
  confidence: number | null;
  evidence: string | null;
  source: FieldSource | null;
  verified: boolean;
  editable: boolean;
  options?: { value: string; label: string }[];
  flag?: { key: string; label: string; kind: FlagKind; message?: string };
}

export interface ReferralView {
  id: string;
  refNo: string;
  receivedAt: string;
  status: string;
  statusLabel: string;
  statusTone: string;
  owner: string | null;
  ownerName: string | null;
  startOfCare: string | null;
  nextAction: string;
  flags: { key: string; label: string; kind: FlagKind; blocking: boolean; message?: string }[];
  sections: { key: string; label: string; fields: FieldView[] }[];
  hidden: { key: string; label: string }[];
  extraction: ReferralRecord['extraction'];
  permissions: { viewDocument: boolean; schedule: boolean; assign: boolean };
}

/**
 * The only way referral data leaves the server. Hidden fields are dropped,
 * masked fields lose their value, and evidence snippets (which are slices of
 * the original fax) only go to roles that may open the fax itself.
 */
export function projectReferral(
  config: Config,
  rec: ReferralRecord,
  role: string,
): { view: ReferralView; shown: string[]; masked: string[] } {
  const showEvidence = can(config, role, 'view_document');
  const flagByField = new Map(rec.flags.filter((f) => f.field).map((f) => [f.field as string, f]));
  const sections: ReferralView['sections'] = [];
  const hidden: ReferralView['hidden'] = [];
  const shown: string[] = [];
  const masked: string[] = [];
  const canSee = (key: string) => {
    const f = config.fieldsByKey[key];
    return Boolean(f) && accessLevel(f, role) === 'full';
  };

  for (const field of config.fields) {
    const level = accessLevel(field, role);
    if (level === 'hidden') {
      hidden.push({ key: field.key, label: field.label });
      continue;
    }
    const full = level === 'full';
    (full ? shown : masked).push(field.key);
    let section = sections.find((s) => s.key === field.concept);
    if (!section) {
      section = { key: field.concept, label: field.conceptLabel, fields: [] };
      sections.push(section);
    }
    const fv = rec.data[field.key];
    const flag = flagByField.get(field.key);
    section.fields.push({
      key: field.key,
      label: field.label,
      type: field.type,
      access: full ? 'full' : 'masked',
      value: full ? (fv?.value ?? null) : null,
      display: full ? displayValue(field, fv?.value) : maskValue(field, fv?.value),
      mono: isIdentifier(field) || !full,
      confidence: fv?.confidence ?? null,
      evidence: full && showEvidence ? (fv?.evidence ?? null) : null,
      source: fv?.source ?? null,
      verified: fv?.verified ?? false,
      editable: canEditField(config, field, role),
      options: field.values?.map((v) => ({ value: v, label: valueLabel(field, v) })),
      flag: flag ? { key: flag.key, label: flag.label, kind: flag.kind, message: full ? flag.message : undefined } : undefined,
    });
  }

  const status = config.statuses[rec.status];
  return {
    view: {
      id: rec.id,
      refNo: rec.refNo,
      receivedAt: rec.receivedAt,
      status: rec.status,
      statusLabel: status?.label ?? rec.status,
      statusTone: status?.tone ?? 'slate',
      owner: rec.owner,
      ownerName: rec.owner ? (config.users[rec.owner]?.name ?? rec.owner) : null,
      startOfCare: rec.startOfCare,
      nextAction: nextAction(config, rec, canSee),
      flags: rec.flags.map((f) => ({
        key: f.key,
        label: f.label,
        kind: f.kind,
        blocking: f.blocking,
        message: !f.field || canSee(f.field) ? f.message : undefined,
      })),
      sections,
      hidden,
      extraction: rec.extraction,
      permissions: {
        viewDocument: can(config, role, 'view_document'),
        schedule: can(config, role, 'change_status') && config.workflow.schedule.roles.includes(role),
        assign: can(config, role, 'assign_owner'),
      },
    },
    shown,
    masked,
  };
}

export interface ColumnView {
  key: string;
  label: string;
}

export interface CellView {
  text: string;
  masked?: boolean;
  mono?: boolean;
  tone?: string;
}

export interface RowView {
  id: string;
  status: string;
  cells: Record<string, CellView>;
}

/** Drops columns the role can't see at all. Masked columns stay, masked. */
export function visibleColumns(config: Config, role: string, columns: string[]): ColumnView[] {
  const out: ColumnView[] = [];
  for (const key of new Set(columns)) {
    if (key in SYSTEM_COLUMNS) out.push({ key, label: SYSTEM_COLUMNS[key as keyof typeof SYSTEM_COLUMNS] });
    else {
      const field = config.fieldsByKey[key];
      if (field && accessLevel(field, role) !== 'hidden') out.push({ key, label: field.label });
    }
  }
  return out;
}

export function projectRow(
  config: Config,
  rec: ReferralRecord,
  role: string,
  columns: ColumnView[],
  formatTime: (iso: string) => string,
): RowView {
  const canSee = (key: string) => {
    const f = config.fieldsByKey[key];
    return Boolean(f) && accessLevel(f, role) === 'full';
  };
  const cells: Record<string, CellView> = {};
  for (const { key } of columns) {
    switch (key) {
      case 'ref_no':
        cells[key] = { text: rec.refNo, mono: true };
        break;
      case 'status':
        cells[key] = { text: config.statuses[rec.status]?.label ?? rec.status, tone: config.statuses[rec.status]?.tone };
        break;
      case 'next_action':
        cells[key] = { text: nextAction(config, rec, canSee) };
        break;
      case 'owner':
        cells[key] = { text: rec.owner ? (config.users[rec.owner]?.name ?? rec.owner) : 'Unassigned' };
        break;
      case 'received_at':
        cells[key] = { text: formatTime(rec.receivedAt) };
        break;
      case 'flags':
        cells[key] = {
          text:
            rec.flags
              .filter((f) => {
                const field = f.field ? config.fieldsByKey[f.field] : undefined;
                return !field || accessLevel(field, role) !== 'hidden';
              })
              .map((f) => f.label)
              .join(', ') || '—',
        };
        break;
      default: {
        const field = config.fieldsByKey[key];
        const value = rec.data[key]?.value;
        cells[key] = canSee(key)
          ? { text: displayValue(field, value), mono: isIdentifier(field) }
          : { text: maskValue(field, value), masked: !isEmpty(value), mono: true };
      }
    }
  }
  return { id: rec.id, status: rec.status, cells };
}
