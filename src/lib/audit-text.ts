import type { Config } from './config';
import type { AuditEntry } from './types';

const ACTIONS: Record<string, [allowed: string, denied: string]> = {
  list: ['viewed the queue', 'tried to view the queue'],
  view: ['opened the referral', 'tried to open the referral'],
  view_document: ['opened the original fax', 'tried to open the original fax'],
  upload: ['uploaded a fax', 'tried to upload a fax'],
  extract: ['ran extraction', 'ran extraction'],
  update: ['changed', 'tried to change'],
  status: ['changed the status', 'tried to change the status'],
  assign: ['changed the owner', 'tried to change the owner'],
  create_view: ['created a view', 'had a view rejected'],
  run_view: ['ran a view', 'tried to run a view'],
  view_audit: ['read the audit log', 'tried to read the audit log'],
  seed: ['seeded the demo data', 'seeded the demo data'],
  sign_in: ['switched to this user', 'tried to switch user'],
};

export function actorName(config: Config, actor: string): string {
  return config.users[actor]?.name ?? (actor === 'system' ? 'System' : actor);
}

/** "Marcus Hale tried to change Primary diagnosis" style text for the audit screens. */
export function describeAudit(config: Config, e: AuditEntry): string {
  const [allowed, denied] = ACTIONS[e.action] ?? [e.action, `tried to ${e.action}`];
  const verb = e.outcome === 'denied' ? denied : allowed;
  if (e.action === 'update' && e.fields.length) {
    return `${verb} ${e.fields.map((k) => config.fieldsByKey[k]?.label ?? k).join(', ')}`;
  }
  return verb;
}

/** A short, value-free summary of the detail column. */
export function auditDetail(e: AuditEntry): string {
  const d = e.detail;
  const parts: string[] = [];
  if (typeof d.count === 'number') parts.push(`${d.count} rows`);
  if (typeof d.view === 'string') parts.push(`view ${d.view}`);
  if (typeof d.slug === 'string') parts.push(`view ${d.slug}`);
  if (Array.isArray(d.masked) && d.masked.length) parts.push(`masked: ${d.masked.join(', ')}`);
  if (typeof d.model === 'string') parts.push(`${d.model}${typeof d.ms === 'number' && d.ms ? ` in ${(d.ms / 1000).toFixed(1)} s` : ''}`);
  if (d.failed === true) parts.push('extraction failed');
  if (d.duplicate === true) parts.push('same file as an existing referral');
  if (typeof d.from === 'string' || typeof d.to === 'string') parts.push(`${d.from ?? 'none'} to ${d.to ?? 'none'}`);
  if (typeof d.status === 'string' && d.status.includes('->')) parts.push(`status ${d.status.replace('->', 'to')}`);
  if (typeof d.reason === 'string') parts.push(d.reason);
  return parts.join('; ');
}
