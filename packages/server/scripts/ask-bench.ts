/**
 * Ask token benchmark: runs a fixed set of realistic questions through the `ask` tool (in-process: the same callTool
 * path as an MCP call, on the configured project and models, unaffected by dev-server restarts) and records tokens,
 * tool calls and the answers (for a quality read). Real model calls, so it costs money: it stops when the total
 * exceeds --max-total (default 1.5M tokens). Keys come from the env / ~/.mandate/secrets.env and are never printed.
 *
 *   npx tsx scripts/ask-bench.ts --model haiku [--only 1,3] [--out /tmp/bench.json] [--project default] [--max-total 1500000]
 */
import { writeFileSync } from 'node:fs';
import { loadSecrets } from '../src/secrets.js';
import { loadConfig } from '../src/config.js';
import { ProjectRegistry, projectOpener } from '../src/projects/registry.js';
import { TOOLS } from '../src/mcp/index.js';
import { callTool } from '../src/mcp/define.js';

export const BENCH_QUESTIONS = [
  { id: 'overview', q: 'Give me an overview of this repository: which specs and standards exist and what state are they in?' },
  { id: 'blocked', q: 'Which specs are blocked or waiting on something, and why?' },
  { id: 'impact', q: 'What would be impacted if we changed the security-baseline standard? Which specs follow it and how?' },
  { id: 'cypher', q: 'Which specs have the most sections? Give me the top 5 with their section counts.' },
  { id: 'section', q: 'Explain how refresh tokens work in the user-sessions spec, citing the relevant sections.' },
  { id: 'work-orders', q: 'What is the status of the work orders? Which ones failed or are in progress, and for which specs?' },
  { id: 'verify', q: 'What are the acceptance criteria of login-sso and which of them have been verified?' },
  { id: 'recent', q: 'What changed recently in the rate-limiting spec?' },
] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadSecrets();
  const config = loadConfig();
  const project = arg('project') ?? config.defaultProject;
  const model = arg('model');
  const only = arg('only')?.split(',').map(Number);
  const maxTotal = Number(arg('max-total') ?? 1_500_000);
  const out = arg('out');
  const registry = new ProjectRegistry(config.projects, projectOpener(config, { startIndex: false, activityPollMs: 3_600_000 }), config.defaultProject);
  const rt = await registry.open(project);
  const ask = TOOLS.find((t) => t.name === 'ask')!;
  const rows: Record<string, unknown>[] = [];
  let total = 0;
  for (const [i, b] of BENCH_QUESTIONS.entries()) {
    if (only && !only.includes(i + 1)) continue;
    if (total > maxTotal) {
      console.log(`stopping: ${total} tokens spent (> ${maxTotal})`);
      break;
    }
    const t0 = Date.now();
    const r = await callTool(ask, { question: b.q, ...(model ? { model } : {}) }, rt.ctx);
    const s = r.structuredContent as Record<string, any>;
    if (r.isError) {
      console.log(`${b.id}: ERROR ${s.error?.code}: ${String(s.error?.message).slice(0, 200)}`);
      rows.push({ id: b.id, error: s.error?.code });
      continue;
    }
    const tokens = s.usage.inputTokens + s.usage.outputTokens;
    total += tokens;
    const calls = s.toolCalls as { name: string; ok: boolean; args: Record<string, unknown> }[];
    const row = {
      id: b.id,
      model: s.modelId,
      inputTokens: s.usage.inputTokens,
      cachedInputTokens: s.usage.cachedInputTokens ?? 0,
      outputTokens: s.usage.outputTokens,
      tools: calls.length,
      toolNames: calls.map((c) => c.name).join(' '),
      continuations: calls.filter((c) => c.args && ('cursor' in c.args || 'offset' in c.args)).length,
      stopReason: s.stopReason,
      answerChars: s.answer.length,
      refs: `${s.references.filter((x: { resolved: boolean }) => x.resolved).length}/${s.references.length}`,
      secs: Math.round((Date.now() - t0) / 1000),
      answer: s.answer,
    };
    rows.push(row);
    const { answer: _a, ...line } = row;
    console.log(JSON.stringify(line));
  }
  console.log(`total tokens: ${total}`);
  if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
  await rt.close();
  process.exit(0);
}

await main();
