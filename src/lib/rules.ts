import type { Condition, FieldDef, Rule } from './config';
import type { FieldValue } from './types';

export function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** NPIs are 10 digits whose check digit is a Luhn check over "80840" + the NPI. */
export function npiValid(v: string): boolean {
  return /^\d{10}$/.test(v) && luhnValid(`80840${v}`);
}

// Medicare Beneficiary Identifier: 11 characters, letters exclude S, L, O, I, B and Z.
const MBI_LETTER = '[AC-HJKMNP-RT-Y]';
const MBI_RE = new RegExp(
  `^[1-9]${MBI_LETTER}[AC-HJKMNP-RT-Y0-9][0-9]${MBI_LETTER}[AC-HJKMNP-RT-Y0-9][0-9]${MBI_LETTER}{2}[0-9]{2}$`,
);
export function mbiValid(v: string): boolean {
  return MBI_RE.test(v.replace(/[\s-]/g, '').toUpperCase());
}

// ICD-10-CM shape: letter, digit, digit or letter, then an optional dot and 1 to 4 more.
// Catches the classic fax errors, like the letter I or O where a digit should be.
const ICD10_RE = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;
export function icd10Valid(code: string): boolean {
  return ICD10_RE.test(code.trim().toUpperCase());
}

export function phoneValid(v: string): boolean {
  const digits = v.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

const norm = (x: unknown) => (typeof x === 'string' ? x.trim().toLowerCase() : x);

/** True when the condition holds for this record's data. */
export function conditionMet(cond: Condition, data: Record<string, FieldValue>): boolean {
  const v = data[cond.field]?.value;
  if (cond.equals !== undefined) return norm(v) === norm(cond.equals);
  if (cond.in) return cond.in.map(norm).includes(norm(v));
  return !isEmpty(v);
}

/** Checks that a value has the shape its field type promises. Returns a message or null. */
export function typeProblem(field: FieldDef, v: unknown): string | null {
  switch (field.type) {
    case 'date':
      return isIsoDate(v) ? null : 'Not a valid date';
    case 'boolean':
      return typeof v === 'boolean' ? null : 'Should be yes or no';
    case 'enum':
      return typeof v === 'string' && (field.values ?? []).includes(v) ? null : 'Not one of the allowed values';
    case 'multi_enum':
      return Array.isArray(v) && v.every((x) => typeof x === 'string' && (field.values ?? []).includes(x))
        ? null
        : 'Has values that are not allowed';
    case 'code_list':
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'Should be a list of codes';
    default:
      return typeof v === 'string' ? null : 'Should be text';
  }
}

/** Applies one YAML rule to a value. Returns a message or null. */
export function ruleProblem(rule: Rule, v: unknown, today: string): string | null {
  const values = Array.isArray(v) ? v.map(String) : [String(v)];
  if (rule.pattern) {
    const re = new RegExp(rule.pattern);
    return values.every((x) => re.test(x)) ? null : (rule.message ?? "Doesn't match the expected format");
  }
  switch (rule.check) {
    case 'past_date':
      return values.every((x) => isIsoDate(x) && x <= today) ? null : (rule.message ?? 'Date is in the future');
    case 'npi':
      return values.every(npiValid) ? null : (rule.message ?? 'Fails the NPI check digit');
    case 'mbi':
      return values.every(mbiValid) ? null : (rule.message ?? 'Not a valid Medicare Beneficiary Identifier');
    case 'icd10': {
      const bad = values.filter((x) => !icd10Valid(x));
      return bad.length ? (rule.message ?? `Not a valid ICD-10 code: ${bad.join(', ')}`) : null;
    }
    case 'phone_us':
      return values.every(phoneValid) ? null : (rule.message ?? 'Not a 10-digit US phone number');
    default:
      return null;
  }
}
