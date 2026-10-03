import type { Config } from './config';
import { formatDate, soften } from './format';
import { conditionMet, isEmpty, ruleProblem, typeProblem } from './rules';
import type { FieldValue, FlagHit, ReferralRecord } from './types';

/**
 * Works out what is wrong with a referral, using only config/intake.yaml:
 * missing required fields, values that break a rule, low-confidence model
 * output that a person still needs to check, and custom flags.
 */
export function computeFlags(
  config: Config,
  data: Record<string, FieldValue>,
  opts: { today: string; extractionError?: string | null },
): FlagHit[] {
  const flags: FlagHit[] = [];
  const nothingExtracted = config.fields.every((f) => isEmpty(data[f.key]?.value));
  if (opts.extractionError && nothingExtracted) {
    flags.push({ key: 'extraction_failed', label: 'Extraction failed', kind: 'system', blocking: true, message: opts.extractionError });
    return flags;
  }

  for (const field of config.fields) {
    const fv = data[field.key];
    const value = fv?.value;
    const required = field.required || (field.required_when ? conditionMet(field.required_when, data) : false);

    if (isEmpty(value)) {
      if (required) {
        flags.push({ key: `missing:${field.key}`, label: `Missing ${soften(field.label)}`, kind: 'missing', blocking: true, field: field.key });
      }
      continue;
    }

    const problems = [
      typeProblem(field, value),
      ...field.rules.filter((r) => !r.when || conditionMet(r.when, data)).map((r) => ruleProblem(r, value, opts.today)),
    ].filter((p): p is string => Boolean(p));
    if (problems.length) {
      flags.push({
        key: `invalid:${field.key}`,
        label: `Check ${soften(field.label)}`,
        kind: 'invalid',
        blocking: true,
        field: field.key,
        message: problems[0],
      });
      continue;
    }

    if (fv && fv.source !== 'human' && !fv.verified && (fv.confidence ?? 0) < config.workflow.review_threshold) {
      flags.push({ key: `review:${field.key}`, label: `Verify ${soften(field.label)}`, kind: 'review', blocking: false, field: field.key });
    }
  }

  for (const [key, flag] of Object.entries(config.flags)) {
    if (conditionMet(flag.when, data)) flags.push({ key, label: flag.label, kind: 'custom', blocking: flag.blocking });
  }
  return flags;
}

/** Ready can't be forced: it is what's left once every blocking flag is cleared and a person has checked the shaky fields. */
export function computeStatus(flags: FlagHit[], current: string): string {
  if (current === 'scheduled') return 'scheduled';
  if (flags.some((f) => f.blocking)) return 'missing_info';
  if (flags.some((f) => f.kind === 'review')) return 'new';
  return 'ready';
}

/**
 * The first next_actions rule in the YAML that matches wins. Templates can use
 * {labels}, {start_of_care} and any field key. A field the viewer can't fully
 * see is never filled in.
 */
export function nextAction(
  config: Config,
  rec: Pick<ReferralRecord, 'flags' | 'status' | 'startOfCare' | 'data'>,
  canSee: (fieldKey: string) => boolean,
): string {
  for (const rule of config.next_actions) {
    let matched: FlagHit[] = [];
    if (rule.when.startsWith('status:')) {
      if (rec.status !== rule.when.slice('status:'.length)) continue;
    } else if (rule.when.endsWith('*')) {
      const prefix = rule.when.slice(0, -1);
      matched = rec.flags.filter((f) => f.key.startsWith(prefix));
      if (!matched.length) continue;
    } else {
      matched = rec.flags.filter((f) => f.key === rule.when);
      if (!matched.length) continue;
    }
    return rule.text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      if (name === 'labels') {
        return matched.map((f) => (f.field ? (config.fieldsByKey[f.field]?.label ?? f.label) : f.label)).join(', ');
      }
      if (name === 'start_of_care') return rec.startOfCare ? formatDate(rec.startOfCare) : 'not set';
      const field = config.fieldsByKey[name];
      if (!field) return whole;
      const value = rec.data[name]?.value;
      return canSee(name) && !isEmpty(value) ? String(value) : `the ${soften(field.label)}`;
    });
  }
  return '';
}
