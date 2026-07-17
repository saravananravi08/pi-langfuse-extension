#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

const DEFAULT_SESSION_ID = '2026-07-17T05-14-22-976Z_019f6e7f-477f-711f-abfc-69e15e5624f7';
const SCORE_NAME = 'memory_trace_observation';
const VERSION = 'v1';
let OBSERVER_API = 'anthropic';
let OBSERVER_ENABLED = true;
let OBSERVER_MODEL = '';
let OBSERVER_BASE_URL = '';
let OBSERVER_API_KEY = '';
const OBSERVER_PROMPT = `You are the memory consciousness of an AI coding assistant. Your observations may become the ONLY information the assistant has about this trace later.

Extract dense trace-level observations from a coding-agent trace. Preserve what matters for continuing work after raw tool calls are removed.

Use priority levels inside observationsMarkdown:
- 🔴 High: explicit user request, unresolved goal, critical context, important decision
- 🟡 Medium: project details, tool results, files inspected/changed, learned information
- 🟢 Low: minor detail or uncertainty
- ✅ Completed: concrete task/question/subtask resolved

Guidelines adapted from Mastra Observational Memory:
- Be specific enough for a future coding agent to act on.
- Add 1-8 observations for the trace.
- Use terse dense language.
- Do not list every tool call. Group repeated reads/searches/commands by purpose and outcome.
- If tools were called, observe what was called, why, and what was learned.
- Preserve file paths and line numbers when available.
- Capture user words closely when important.
- Track completion explicitly with ✅ when a concrete outcome is done.
- Capture state changes: if later evidence supersedes earlier info in the same trace, state the latest state.
- Keep exact errors, commands, file paths, and tests when useful.

Return ONLY valid JSON. No markdown fence. Shape:
{
  "observationsMarkdown": "Date: Jul 17, 2026\\n* 🔴 (14:30) ...\\n* 🟡 (14:31) ...\\n* ✅ ...",
  "currentTask": "short current task/status after this trace",
  "summary": "one short paragraph",
  "filesTouched": ["path/or/file.ts"],
  "toolsUsed": ["bash", "read", "edit"],
  "decisions": ["decision/rationale"],
  "completed": ["completed outcome"],
  "openIssues": ["remaining issue/blocker"]
}

Do not include suggestedResponse.`;
const LANGFUSE_CONFIG = process.env.LANGFUSE_CONFIG || join(homedir(), '.pi', 'agent', 'extensions', 'langfuse', 'config.json');

const args = parseArgs(process.argv.slice(2));
const sessionId = normalizeSessionId(args.session || args._[0] || DEFAULT_SESSION_ID);
const dryRun = Boolean(args['dry-run']);
const force = Boolean(args.force);
const limit = args.limit ? Number(args.limit) : Infinity;

if (!sessionId) fail('Missing session id');

const langfuse = loadLangfuseConfig();
OBSERVER_API = ((process.env.OBSERVER_API || process.env.PI_LANGFUSE_OBSERVER_API || langfuse.observer?.api || (process.env.OPENAI_API_KEY ? 'openai' : 'anthropic')).toLowerCase() === 'openai') ? 'openai' : 'anthropic';
OBSERVER_ENABLED = process.env.OBSERVER_ENABLED === 'false' || process.env.PI_LANGFUSE_OBSERVER_ENABLED === 'false' ? false : langfuse.observer?.enabled !== false;
OBSERVER_MODEL = process.env.OBSERVER_MODEL || process.env.PI_LANGFUSE_OBSERVER_MODEL || langfuse.observer?.model || '';
OBSERVER_BASE_URL = process.env.OBSERVER_BASE_URL || process.env.PI_LANGFUSE_OBSERVER_BASE_URL || langfuse.observer?.baseUrl || (OBSERVER_API === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com');
OBSERVER_API_KEY = process.env.OBSERVER_API_KEY || process.env.PI_LANGFUSE_OBSERVER_API_KEY || langfuse.observer?.apiKey || (OBSERVER_API === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) || '';
if (!OBSERVER_ENABLED) fail('Observer disabled. Set observer.enabled=true or remove observer.enabled=false.');
if (!OBSERVER_MODEL) fail('Missing observer model. Set observer.model in config.json or OBSERVER_MODEL.');
if (!OBSERVER_API_KEY) fail('Missing observer API key. Set observer.apiKey in config.json or OBSERVER_API_KEY.');

const langfuseAuth = `Basic ${Buffer.from(`${langfuse.publicKey}:${langfuse.secretKey}`).toString('base64')}`;

console.log(`session=${sessionId}`);
console.log(`observerApi=${OBSERVER_API}`);
console.log(`model=${OBSERVER_MODEL}`);
console.log(`dryRun=${dryRun} force=${force}`);

const traces = await fetchAllTraces(sessionId);
console.log(`traces=${traces.length}`);

let processed = 0;
let skipped = 0;
let failed = 0;

for (const trace of traces.slice(0, limit)) {
  try {
    const fullTrace = await lfGet(`/api/public/traces/${encodeURIComponent(trace.id)}`);
    const existing = fullTrace.scores?.find(s => s.name === SCORE_NAME && s.metadata?.version === VERSION);
    if (existing && !force) {
      skipped++;
      console.log(`skip existing ${trace.timestamp} ${trace.id}`);
      continue;
    }

    const observations = await fetchAllObservations(trace.id);
    const sourceObservations = observations.filter(o => !String(o.name || '').startsWith('memory:'));
    const timeline = buildTimeline(fullTrace, sourceObservations);
    const memory = await observeTrace(fullTrace, sourceObservations, timeline);
    const metadata = buildScoreMetadata(fullTrace, sourceObservations, memory, timeline);
    const comment = firstLine(memory.summary || stripXml(memory.observationsMarkdown) || 'Trace observed');
    const scoreId = deterministicUuid(`${SCORE_NAME}:${VERSION}:${trace.id}`);

    if (dryRun) {
      console.log(`dry ${trace.timestamp} ${trace.id}`);
      console.log(JSON.stringify({ scoreId, comment, metadata }, null, 2).slice(0, 5000));
    } else {
      await writeScore({ traceId: trace.id, scoreId, comment, metadata });
      console.log(`wrote ${trace.timestamp} ${trace.id}`);
    }
    processed++;
  } catch (e) {
    failed++;
    console.error(`fail ${trace.id}: ${e?.message || e}`);
  }
}

console.log(JSON.stringify({ sessionId, traces: traces.length, processed, skipped, failed, dryRun }, null, 2));
if (failed > 0) process.exitCode = 1;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (a.includes('=')) {
      const [k, ...v] = a.slice(2).split('=');
      out[k] = v.join('=');
    } else {
      const k = a.slice(2);
      if (['dry-run', 'force'].includes(k)) out[k] = true;
      else out[k] = argv[++i];
    }
  }
  return out;
}

function normalizeSessionId(value) {
  if (!value) return '';
  return String(value).replace(/^\/?sessions\//, '').replace(/\.jsonl$/, '');
}

function loadLangfuseConfig() {
  if (!existsSync(LANGFUSE_CONFIG)) fail(`Langfuse config not found: ${LANGFUSE_CONFIG}`);
  const cfg = JSON.parse(readFileSync(LANGFUSE_CONFIG, 'utf8'));
  if (!cfg.publicKey || !cfg.secretKey) fail('Langfuse config missing publicKey/secretKey');
  return { host: cfg.host || 'https://cloud.langfuse.com', publicKey: cfg.publicKey, secretKey: cfg.secretKey, observer: cfg.observer || {} };
}

function observerEndpoint() {
  const base = OBSERVER_BASE_URL.replace(/\/+$/, '');
  if (OBSERVER_API === 'openai') return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

async function fetchAllTraces(sessionId) {
  const all = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ sessionId, page: String(page), limit: '100', orderBy: 'timestamp.asc', fields: 'core,io,scores,metrics' });
    const res = await lfGet(`/api/public/traces?${params}`);
    all.push(...(res.data || []));
    if (!res.meta || page >= res.meta.totalPages) break;
  }
  return all.filter(t => t.name !== 'memory:session-state');
}

async function fetchAllObservations(traceId) {
  const all = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ traceId, page: String(page), limit: '100' });
    const res = await lfGet(`/api/public/observations?${params}`);
    all.push(...(res.data || []));
    if (!res.meta || page >= res.meta.totalPages) break;
  }
  return all.sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')));
}

async function lfGet(path) {
  const text = await fetchTextWithRetry(`${langfuse.host}${path}`, { headers: { Authorization: langfuseAuth } }, `Langfuse GET ${path}`);
  return text ? JSON.parse(text) : null;
}

async function writeScore({ traceId, scoreId, comment, metadata }) {
  const body = {
    id: scoreId,
    traceId,
    name: SCORE_NAME,
    value: 'observed',
    dataType: 'CATEGORICAL',
    comment: clamp(comment, 1000),
    metadata,
  };
  await fetchTextWithRetry(`${langfuse.host}/api/public/scores`, {
    method: 'POST',
    headers: { Authorization: langfuseAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'Langfuse score write');
}

function buildTimeline(trace, observations) {
  const lines = [];
  lines.push(`Trace ${trace.id}`);
  lines.push(`Session: ${trace.sessionId || ''}`);
  lines.push(`Time: ${trace.timestamp || ''}`);
  lines.push(`CWD: ${trace.metadata?.cwd || ''}`);
  lines.push(`Model: ${trace.metadata?.provider || ''}/${trace.metadata?.model || ''}`);
  lines.push(`User: ${stringifyValue(trace.input, 2000)}`);
  if (trace.output) lines.push(`Final assistant output: ${stringifyValue(trace.output, 2000)}`);
  lines.push('');
  lines.push('Steps:');
  for (const o of observations) {
    const time = o.startTime ? new Date(o.startTime).toISOString() : '';
    const label = `${o.type || ''} ${o.name || ''}`.trim();
    lines.push(`- ${time} ${label}`);
    if (o.input != null) lines.push(`  input: ${stringifyValue(o.input, 1200).replace(/\n/g, '\n  ')}`);
    if (o.output != null) lines.push(`  output: ${stringifyValue(o.output, 1600).replace(/\n/g, '\n  ')}`);
    if (o.metadata && Object.keys(o.metadata).length) lines.push(`  metadata: ${stringifyValue(o.metadata, 600)}`);
  }
  return lines.join('\n');
}

async function observeTrace(trace, observations, timeline) {
  const system = OBSERVER_PROMPT;
  const user = `## New Message History to Observe\n\n${timeline}\n\n---\n\nExtract trace-level memory observations. Do not include <suggested-response>. Output only valid JSON with keys: observationsMarkdown, currentTask, summary, filesTouched, toolsUsed, decisions, completed, openIssues.`;
  const text = await observerComplete(system, user);
  return parseObserverJson(text);
}

async function observerComplete(system, user) {
  const headers = {
    Authorization: `Bearer ${OBSERVER_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (OBSERVER_API === 'anthropic') headers['anthropic-version'] = '2023-06-01';

  const body = OBSERVER_API === 'openai'
    ? {
        model: OBSERVER_MODEL,
        temperature: 0.1,
        max_tokens: 6000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }
    : {
        model: OBSERVER_MODEL,
        max_tokens: 6000,
        stream: false,
        temperature: 0.1,
        system,
        messages: [{ role: 'user', content: user }],
      };

  const raw = await fetchTextWithRetry(observerEndpoint(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, 'Observer model');
  const data = JSON.parse(raw);
  const text = OBSERVER_API === 'openai'
    ? data.choices?.[0]?.message?.content
    : (data.content || []).filter(p => p.type === 'text' && p.text).map(p => p.text).join('\n');
  if (!text?.trim()) throw new Error(`Observer model returned no text: ${raw.slice(0, 1000)}`);
  return text.trim();
}

function parseObserverJson(text) {
  const jsonText = extractJson(text);
  const parsed = JSON.parse(jsonText);
  return {
    observationsMarkdown: String(parsed.observationsMarkdown || '').trim(),
    currentTask: String(parsed.currentTask || '').trim(),
    summary: String(parsed.summary || '').trim(),
    filesTouched: arrayOfStrings(parsed.filesTouched),
    toolsUsed: arrayOfStrings(parsed.toolsUsed),
    decisions: arrayOfStrings(parsed.decisions),
    completed: arrayOfStrings(parsed.completed),
    openIssues: arrayOfStrings(parsed.openIssues),
    rawModelOutput: text,
  };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error(`No JSON object in observer output: ${text.slice(0, 1000)}`);
  return text.slice(start, end + 1);
}

async function fetchTextWithRetry(url, options, label, attempts = 5) {
  let lastText = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(url, options);
    const text = await res.text();
    lastText = text;
    if (res.ok) return text;
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      const retryAfter = Number(res.headers.get('retry-after')) || parseRetryAfter(text) || attempt * 2;
      await sleep(Math.min(retryAfter, 30) * 1000);
      continue;
    }
    throw new Error(`${label} ${res.status}: ${text.slice(0, 1000)}`);
  }
  throw new Error(`${label} failed: ${lastText.slice(0, 1000)}`);
}

function parseRetryAfter(text) {
  try { return Number(JSON.parse(text)?.details?.retryAfterSeconds) || 0; } catch { return 0; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildScoreMetadata(trace, observations, memory, timeline) {
  return trimMetadata({
    version: VERSION,
    scope: 'trace',
    source: 'pi-langfuse-memory',
    observerApi: OBSERVER_API,
    observerModel: OBSERVER_MODEL,
    traceId: trace.id,
    sessionId: trace.sessionId || null,
    traceTimestamp: trace.timestamp || null,
    cwd: trace.metadata?.cwd || null,
    pathKey: trace.metadata?.cwd || null,
    model: trace.metadata?.model || null,
    provider: trace.metadata?.provider || null,
    observationsMarkdown: memory.observationsMarkdown,
    currentTask: memory.currentTask,
    summary: memory.summary,
    filesTouched: memory.filesTouched,
    toolsUsed: memory.toolsUsed.length ? memory.toolsUsed : unique(observations.map(o => o.metadata?.tool || (String(o.name || '').startsWith('tool:') ? String(o.name).slice(5) : '')).filter(Boolean)),
    decisions: memory.decisions,
    completed: memory.completed,
    openIssues: memory.openIssues,
    sourceObservationIds: observations.map(o => o.id).filter(Boolean),
    sourceObservationCount: observations.length,
    timelinePreview: clamp(timeline, 6000),
    generatedAt: new Date().toISOString(),
  });
}

function trimMetadata(metadata) {
  let out = { ...metadata };
  let text = JSON.stringify(out);
  if (text.length <= 50000) return out;
  delete out.timelinePreview;
  text = JSON.stringify(out);
  if (text.length <= 50000) return out;
  out.observationsMarkdown = clamp(out.observationsMarkdown, 12000);
  out.summary = clamp(out.summary, 3000);
  return out;
}

function stringifyValue(value, max) {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return clamp(s, max);
}

function clamp(s, max) {
  s = String(s ?? '');
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}

function stripXml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

function firstLine(s) {
  return String(s || '').split('\n').map(x => x.trim()).find(Boolean) || 'Trace observed';
}

function arrayOfStrings(v) {
  return Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [];
}

function unique(v) {
  return [...new Set(v)];
}

function deterministicUuid(input) {
  const h = crypto.createHash('sha256').update(input).digest('hex').slice(0, 32).split('');
  h[12] = '4';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

