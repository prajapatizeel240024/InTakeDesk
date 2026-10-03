import Anthropic from '@anthropic-ai/sdk';
import type { Config, FieldDef } from './config';
import { todayIso } from './format';
import { isIsoDate } from './rules';
import type { ExtractionMeta, FieldValue } from './types';

export interface ExtractionResult {
  data: Record<string, FieldValue>;
  meta: ExtractionMeta;
}

export interface Extractor {
  extract(input: { pdf: Buffer; ref: string; config: Config }): Promise<ExtractionResult>;
}

export const NOT_STATED = 'not_stated';

export function modelChain(): string[] {
  const chain = [
    process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    process.env.ANTHROPIC_FALLBACK_MODEL || 'claude-haiku-4-5-20251001',
  ];
  return chain.filter((m, i) => chain.indexOf(m) === i);
}

/**
 * JSON schema for one field's value. Kept free of nullable unions and optional
 * properties so it stays inside the structured outputs limits: an empty string,
 * an empty list or "not_stated" means the referral doesn't say.
 */
function valueSchema(field: FieldDef): Record<string, unknown> {
  switch (field.type) {
    case 'boolean':
      return { type: 'string', enum: ['yes', 'no', NOT_STATED] };
    case 'enum':
      return { type: 'string', enum: [...(field.values ?? []), NOT_STATED] };
    case 'multi_enum':
      return { type: 'array', items: { type: 'string', enum: field.values ?? [] } };
    case 'code_list':
      return { type: 'array', items: { type: 'string' } };
    case 'date':
      return { type: 'string', description: 'YYYY-MM-DD, or "" if the referral does not say' };
    default:
      return { type: 'string', description: 'Exactly as written, or "" if the referral does not say' };
  }
}

/** Built from config/intake.yaml on every call, so adding a field there adds it to extraction. Contains no patient data. */
export function extractionSchema(config: Config): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of config.fields) {
    properties[field.key] = {
      type: 'object',
      description: `${field.label}. ${field.extract}`,
      properties: {
        value: valueSchema(field),
        confidence: { type: 'number', description: '0 to 1: how sure you are the value is right and complete' },
        evidence: { type: 'string', description: 'A short quote from the document that supports the value, or ""' },
      },
      required: ['value', 'confidence', 'evidence'],
      additionalProperties: false,
    };
  }
  return { type: 'object', properties, required: config.fields.map((f) => f.key), additionalProperties: false };
}

export function extractionPrompt(config: Config, today: string): string {
  return [
    `You read home health referrals for the intake team at ${config.app.org} and fill in a structured record.`,
    `Today is ${today}.`,
    '',
    'Rules:',
    '- Copy names, IDs and codes exactly as written. Never fix a typo, even when you can tell what was meant. The team needs to see what the referral actually says.',
    '- If the referral does not say, use "" (or "not_stated", or an empty list). Never guess.',
    '- Write dates as YYYY-MM-DD. A two-digit birth year means 19xx.',
    '- confidence is your honest estimate that the value is right and complete. Use 0.95 or more only when it is printed clearly. Go below 0.85 when the text is unclear, when you had to infer it or pick between conflicting values, or when it may belong to someone other than the patient.',
    '- evidence is a short quote, under 20 words, showing where the value came from.',
    '- An order is signed only if there is a handwritten mark on the signature line or an electronic signature statement. A blank line, or a typed name alone, means it is not signed.',
  ].join('\n');
}

function toIsoDate(s: string): string | null {
  if (isIsoDate(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

/** Turns a raw value (from the model or a person) into the field's canonical shape. Empty means null. */
export function normalizeValue(field: FieldDef, v: unknown): unknown {
  switch (field.type) {
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v ?? '').trim().toLowerCase();
      if (s === 'yes' || s === 'true') return true;
      if (s === 'no' || s === 'false') return false;
      return null;
    }
    case 'enum': {
      const s = String(v ?? '').trim();
      if (!s || s.toLowerCase() === NOT_STATED) return null;
      // Structured outputs don't promise enum casing, so match without it.
      return field.values?.find((x) => x.toLowerCase() === s.toLowerCase()) ?? s;
    }
    case 'multi_enum': {
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
      return unique(
        list
          .map((x) => String(x).trim())
          .filter(Boolean)
          .map((s) => field.values?.find((x) => x.toLowerCase() === s.toLowerCase()) ?? s),
      );
    }
    case 'code_list': {
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\s]+/) : [];
      return unique(list.map((x) => String(x).trim().toUpperCase()).filter(Boolean));
    }
    case 'date': {
      const s = String(v ?? '').trim();
      if (!s) return null;
      return toIsoDate(s) ?? s;
    }
    default: {
      const s = String(v ?? '').trim();
      return s || null;
    }
  }
}

export function normalizeExtraction(config: Config, raw: unknown): Record<string, FieldValue> {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const data: Record<string, FieldValue> = {};
  for (const field of config.fields) {
    const item = (obj[field.key] ?? {}) as { value?: unknown; confidence?: unknown; evidence?: unknown };
    const confidence = Number(item.confidence);
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim().slice(0, 300) : '';
    data[field.key] = {
      value: normalizeValue(field, item.value),
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
      evidence: evidence || null,
      source: 'model',
      verified: false,
    };
  }
  return data;
}

export class ExtractionError extends Error {}

function errorText(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.status ?? 'network'} ${err.name}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sends the PDF to Claude with the YAML-built schema as a structured output.
 * The SDK retries transient errors with backoff; if the main model still fails,
 * the fallback model gets a turn. Logs carry the referral number, never patient data.
 */
export function createClaudeExtractor(): Extractor {
  let client: Anthropic | null = null;
  return {
    async extract({ pdf, ref, config }) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new ExtractionError('ANTHROPIC_API_KEY is not set, so the referral was saved without extraction.');
      }
      client ??= new Anthropic({ maxRetries: 3, timeout: 120_000 });
      const started = Date.now();
      const models = modelChain();
      let lastError = '';
      for (const [i, model] of models.entries()) {
        try {
          const res = await client.messages.create({
            model,
            max_tokens: 4096,
            system: extractionPrompt(config, todayIso()),
            output_config: { format: { type: 'json_schema', schema: extractionSchema(config) } },
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
                  { type: 'text', text: 'Fill in the record for this referral.' },
                ],
              },
            ],
          });
          const stop = String(res.stop_reason);
          if (stop === 'max_tokens' || stop === 'refusal') throw new Error(`stopped early (${stop})`);
          const text = res.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
          return {
            data: normalizeExtraction(config, JSON.parse(text)),
            meta: { model, ms: Date.now() - started, fallbackUsed: i > 0 },
          };
        } catch (err) {
          lastError = errorText(err);
          console.error(JSON.stringify({ event: 'extraction_error', ref, model, error: lastError }));
        }
      }
      throw new ExtractionError(`Extraction failed: ${lastError}`);
    },
  };
}
