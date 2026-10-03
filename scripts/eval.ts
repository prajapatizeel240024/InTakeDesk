/**
 * Runs extraction on the synthetic referrals and scores it against
 * data/answer-key.json: field by field, flag by flag, and how well the
 * confidence threshold separates right answers from shaky ones.
 *
 *   npm run eval
 *   npm run eval -- --only 10,11,12
 *   npm run eval -- --model claude-haiku-4-5-20251001
 *   npm run eval -- --out evals/results/sonnet.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/lib/config';
import { scoreRun, type CaseResult, type EvalReport } from '../src/lib/eval-score';
import { createClaudeExtractor, modelChain } from '../src/lib/extract';
import { todayIso } from '../src/lib/format';
import { loadAnswerKey } from '../src/lib/seed';
import { computeFlags } from '../src/lib/workflow';
import { loadEnv } from './env';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function printReport(r: EvalReport) {
  console.log('');
  console.log(
    `Field accuracy: ${r.fieldsCorrect}/${r.fieldsTotal} (${pct(r.fieldsCorrect, r.fieldsTotal)})` +
      (r.failures ? `. ${r.failures} referral(s) failed to extract and are left out.` : ''),
  );
  console.log('');
  for (const f of r.perField) {
    console.log(`  ${f.label.padEnd(20)} ${`${f.correct}/${f.total}`.padStart(6)}  ${pct(f.correct, f.total).padStart(6)}`);
  }

  const misses = r.perField.flatMap((f) => f.misses.map((m) => ({ ...m, label: f.label })));
  if (misses.length) {
    console.log('\nMisses');
    for (const m of misses) {
      const conf = m.confidence === null ? '' : ` (confidence ${m.confidence.toFixed(2)})`;
      console.log(`  #${m.id} ${m.label}: got "${m.predicted}", expected "${m.expected}"${conf}`);
    }
  }

  console.log('\nFlags: did each referral get flagged when it should have?');
  for (const f of r.flags) {
    console.log(
      `  ${f.family.padEnd(15)} precision ${pct(f.tp, f.tp + f.fp).padStart(6)}   recall ${pct(f.tp, f.tp + f.fn).padStart(6)}   ` +
        `(${f.tp} right, ${f.fp} false alarm${f.fp === 1 ? '' : 's'}, ${f.fn} missed)`,
    );
  }

  const rt = r.routing;
  console.log(`\nConfidence routing at ${rt.threshold}`);
  console.log(`  Accepted automatically: ${rt.accepted} fields, ${pct(rt.acceptedCorrect, rt.accepted)} correct`);
  console.log(
    `  Sent to a person:       ${rt.reviewed} fields (${pct(rt.reviewed, rt.accepted + rt.reviewed)} of all), ` +
      `${pct(rt.reviewedCorrect, rt.reviewed)} correct`,
  );
  console.log(`\nLatency p50 ${secs(r.latencyMs.p50)}, p95 ${secs(r.latencyMs.p95)}. Fallback model used ${r.fallbacks} time(s).`);
}

async function main() {
  loadEnv();
  const model = arg('model');
  if (model) process.env.ANTHROPIC_MODEL = model;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY first (in .env.local).');
    process.exit(1);
  }

  const config = getConfig();
  const only = arg('only')
    ?.split(',')
    .map((s) => s.trim().padStart(2, '0'));
  const cases = loadAnswerKey().referrals.filter((r) => !only || only.includes(r.id));
  const extractor = createClaudeExtractor();
  const results: CaseResult[] = [];

  console.log(`Extracting ${cases.length} synthetic referral(s) with ${modelChain()[0]}`);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const entry = cases[next++];
      const pdf = fs.readFileSync(path.join('data', 'referrals', entry.file));
      const started = Date.now();
      try {
        const { data, meta } = await extractor.extract({ pdf, ref: `eval-${entry.id}`, config });
        results.push({
          id: entry.id,
          expected: entry.fields,
          expectedFlags: entry.expectedFlags,
          predicted: data,
          predictedFlags: computeFlags(config, data, { today: todayIso() }).map((f) => f.key),
          ms: meta.ms,
          model: meta.model,
          fallbackUsed: meta.fallbackUsed,
        });
        console.log(`  #${entry.id} done in ${secs(meta.ms)}${meta.fallbackUsed ? ' (fallback model)' : ''}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.push({
          id: entry.id,
          expected: entry.fields,
          expectedFlags: entry.expectedFlags,
          predicted: null,
          predictedFlags: [],
          ms: Date.now() - started,
          model: 'none',
          fallbackUsed: false,
          error,
        });
        console.log(`  #${entry.id} failed: ${error}`);
      }
    }
  };
  const concurrency = Math.max(1, Number(arg('concurrency') ?? 3));
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  results.sort((a, b) => a.id.localeCompare(b.id));

  const report = scoreRun(config, results);
  printReport(report);

  const out = arg('out');
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), model: modelChain()[0], report, results }, null, 2)}\n`);
    console.log(`\nSaved the full run to ${out}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
