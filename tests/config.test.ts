import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configPath, parseConfig } from '../src/lib/config';
import { extractionSchema } from '../src/lib/extract';
import { loadAnswerKey } from '../src/lib/seed';
import { ROOT, loadConfig } from './helpers';

const yaml = fs.readFileSync(configPath(ROOT), 'utf8');

function swap(from: string, to: string): string {
  expect(yaml).toContain(from);
  return yaml.replace(from, to);
}

describe('config/intake.yaml', () => {
  it('loads, and every field has an access level for every role', () => {
    const config = loadConfig();
    expect(config.fields.length).toBe(19);
    for (const f of config.fields) expect(Object.keys(f.access).sort()).toEqual(Object.keys(config.roles).sort());
  });

  it('refuses a PHI field that forgets to say what one role can see', () => {
    const broken = swap('access: { intake: full, billing: hidden, clinician: full }', 'access: { intake: full, clinician: full }');
    expect(() => parseConfig(broken)).toThrow(/PHI field "address" must set access for role "billing"/);
  });

  it('refuses a user whose role does not exist', () => {
    expect(() => parseConfig(swap('marcus: { name: Marcus Hale, role: billing }', 'marcus: { name: Marcus Hale, role: biling }'))).toThrow(
      /user "marcus" has unknown role "biling"/,
    );
  });

  it('refuses a rule that points at a field that does not exist', () => {
    expect(() => parseConfig(swap('when: { field: payer_type, equals: medicare }', 'when: { field: payor_type, equals: medicare }'))).toThrow(
      /unknown field "payor_type"/,
    );
  });
});

describe('the extraction schema built from the YAML', () => {
  const config = loadConfig();
  const schema = extractionSchema(config) as { required: string[] };

  it('asks for every field', () => {
    expect(schema.required).toEqual(config.fields.map((f) => f.key));
  });

  it('stays inside the structured outputs limits: no optional properties, no union types, closed objects', () => {
    let optional = 0;
    let unions = 0;
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false);
        const props = Object.keys((n.properties as object) ?? {});
        optional += props.filter((p) => !((n.required as string[]) ?? []).includes(p)).length;
      }
      if (Array.isArray(n.type) || n.anyOf) unions++;
      Object.values(n).forEach(walk);
    };
    walk(schema);
    expect(optional).toBe(0);
    expect(unions).toBe(0);
  });

  it('contains no patient data, which structured outputs require for HIPAA', () => {
    const text = JSON.stringify(schema);
    const values = loadAnswerKey(ROOT)
      .referrals.flatMap((r) => config.fields.filter((f) => f.phi).map((f) => r.fields[f.key]))
      .flat()
      .filter((v): v is string => typeof v === 'string' && v.length > 4);
    for (const v of values) expect(text).not.toContain(v);
  });
});
