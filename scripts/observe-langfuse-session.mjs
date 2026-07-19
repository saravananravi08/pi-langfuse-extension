#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import { OBSERVER_PROMPT_VERSION as PROMPT_VERSION, OBSERVER_SYSTEM_PROMPT } from '../memory-prompts.js';
import { validateMemoryOutput } from '../memory-validation.js';
import { auditObservationCoverage } from '../memory-audit.js';

const DEFAULT_SESSION_ID = '2026-07-17T05-14-22-976Z_019f6e7f-477f-711f-abfc-69e15e5624f7';
const SCORE_NAME = 'memory_trace_observation';
const VERSION = 'v1';
let OBSERVER_API = 'anthropic';
let OBSERVER_ENABLED = true;
let OBSERVER_MODEL = '';
let OBSERVER_BASE_URL = '';
let OBSERVER_API_KEY = '';
const LANGFUSE_CONFIG = process.env.LANGFUSE_CONFIG || join(homedir(), '.pi', 'agent', 'extensions', 'langfuse', 'config.json');

const args = parseArgs(process.argv.slice(2));
const sessionId = normalizeSessionId(args.session || args._[0] || DEFAULT_SESSION_ID);
const dryRun = Boolean(args['dry-run']);
const force = Boolean(args.force);
const backfill = Boolean(args.backfill);
const includePreCoverage = Boolean(args['include-pre-coverage']);
const auditMode = Boolean(args.audit) || backfill;
const limit = args.limit ? Number(args.limit) : Infinity;

if (!sessionId) fail('Missing session id');

const langfuse = loadLangfuseConfig();
OBSERVER_API = ((process.env.OBSERVER_API || process.env.PI_LANGFUSE_OBSERVER_API || langfuse.observer?.api || (process.env.OPENAI_API_KEY ? 'openai' : 'anthropic')).toLowerCase() === 'openai') ? 'openai' : 'anthropic';
OBSERVER_ENABLED = process.env.OBSERVER_ENABLED === 'false' || process.env.PI_LANGFUSE_OBSERVER_ENABLED === 'false' ? false : langfuse.observer?.enabled !== false;
OBSERVER_MODEL = process.env.OBSERVER_MODEL || process.env.PI_LANGFUSE_OBSERVER_MODEL || langfuse.observer?.model || '';
OBSERVER_BASE_URL = process.env.OBSERVER_BASE_URL || process.env.PI_LANGFUSE_OBSERVER_BASE_URL || langfuse.observer?.baseUrl || (OBSERVER_API === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com');
OBSERVER_API_KEY = process.env.OBSERVER_API_KEY || process.env.PI_LANGFUSE_OBSERVER_API_KEY || langfuse.observer?.apiKey || (OBSERVER_API === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) || '';
if ((!auditMode || backfill) && !OBSERVER_ENABLED) fail('Observer disabled. Set observer.enabled=true or remove observer.enabled=false.');
if ((!auditMode || backfill) && !OBSERVER_MODEL) fail('Missing observer model. Set observer.model in config.json or OBSERVER_MODEL.');
if ((!auditMode || backfill) && !OBSERVER_API_KEY) fail('Missing observer API key. Set observer.apiKey in config.json or OBSERVER_API_KEY.');

const langfuseAuth = `Basic ${Buffer.from(`${langfuse.publicKey}:${langfuse.secretKey}`).toString('base64')}`;

console.log(`session=${sessionId}`);
console.log(`observerApi=${OBSERVER_API}`);
console.log(`model=${OBSERVER_MODEL}`);
console.log(`dryRun=${dryRun} force=${force} audit=${auditMode} backfill=${backfill} includePreCoverage=${includePreCoverage}`);

let traces = await fetchAllTraces(sessionId);
console.log(`traces=${traces.length}`);

if (auditMode) {
  const traceIds = new Set(traces.map(trace => trace.id));
  const observationScores = (await fetchScoresByName(SCORE_NAME)).filter(score => traceIds.has(score.traceId || score.metadata?.traceId));
  const audit = auditObservationCoverage(traces, observationScores, {
    scoreName: SCORE_NAME,
    version: VERSION,
    expectedScoreId: traceId => deterministicUuid(`${SCORE_NAME}:${VERSION}:${traceId}`),
  });
  console.log(JSON.stringify({ sessionId, ...audit }, null, 2));
  if (!backfill) process.exit(0);
  const missing = new Set([
    ...audit.eligibleMissingTraceIds,
    ...(includePreCoverage ? audit.preCoverageTraceIds : []),
  ]);
  traces = traces.filter(trace => missing.has(trace.id));
  console.log(`backfillEligible=${traces.length}`);
}

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
      if (['dry-run', 'force', 'audit', 'backfill', 'include-pre-coverage'].includes(k)) out[k] = true;
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

async function fetchScoresByName(name) {
  const scores = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ name, dataType: 'CATEGORICAL', page: String(page), limit: '100' });
    const response = await lfGet(`/api/public/v2/scores?${params}`);
    scores.push(...(response.data || []));
    if (!response.meta?.totalPages || page >= response.meta.totalPages) break;
  }
  return scores;
}

async function fetchAllObservations(traceId) {
  const all = [];
  let cursor;
  do {
    const params = new URLSearchParams({
      traceId,
      limit: '1000',
      fields: 'core,basic,time,io,metadata,model,usage',
    });
    if (cursor) params.set('cursor', cursor);
    const res = await lfGet(`/api/public/v2/observations?${params}`);
    all.push(...(res.data || []));
    cursor = res.meta?.cursor;
  } while (cursor);
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
  lines.push(`User: ${stringifyValue(trace.input, 8000)}`);
  if (trace.output) lines.push(`Final assistant output: ${stringifyValue(trace.output, 8000)}`);
  lines.push('');
  lines.push('Steps:');
  for (const o of observations) {
    const time = o.startTime ? new Date(o.startTime).toISOString() : '';
    const label = `${o.type || ''} ${o.name || ''}`.trim();
    lines.push(`- ${time} ${label}`);
    if (o.input != null) lines.push(`  input: ${stringifyValue(o.input, 8000).replace(/\n/g, '\n  ')}`);
    if (o.output != null) lines.push(`  output: ${stringifyValue(o.output, 40000).replace(/\n/g, '\n  ')}`);
    if (o.metadata && Object.keys(o.metadata).length) lines.push(`  metadata: ${stringifyValue(o.metadata, 600)}`);
  }
  return lines.join('\n');
}

async function observeTrace(trace, observations, timeline) {
  const system = OBSERVER_SYSTEM_PROMPT;
  const user = `<trace-data>\n${timeline}\n</trace-data>\n\nExtract trace-level memory and return ONLY valid JSON with this shape:
{
  "observationsMarkdown": "Date: <date from trace>\\n* 🔴 (<time>) ...",
  "summary": "one short paragraph",
  "goal": ["user goal"],
  "constraints": ["requirement or preference"],
  "currentTask": "current task/status after this trace",
  "taskStatus": "active | waiting_for_user | blocked | complete",
  "completed": ["verified completed outcome"],
  "inProgress": ["unfinished work"],
  "openIssues": ["remaining issue or blocker"],
  "decisions": ["decision and rationale"],
  "nextSteps": ["next action"],
  "criticalContext": ["detail required to continue"],
  "filesRead": ["path inspected"],
  "filesModified": ["path changed"],
  "filesCreated": ["path created"],
  "filesDeleted": ["path deleted"],
  "toolsUsed": ["tool name"]
}`;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await observerComplete(system, user);
    try {
      if (detectDegenerateRepetition(text)) throw new Error('Observer output contains degenerate repetition');
      return parseObserverJson(text);
    } catch (error) {
      lastError = error;
      if (attempt < 2) console.warn('invalid observer output; retrying once');
    }
  }
  throw lastError;
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
  const validationError = validateMemoryOutput(parsed, 'observer');
  if (validationError) throw new Error(`Invalid observer schema: ${validationError}`);
  return {
    observationsMarkdown: String(parsed.observationsMarkdown).trim(),
    summary: String(parsed.summary).trim(),
    goal: arrayOfStrings(parsed.goal),
    constraints: arrayOfStrings(parsed.constraints),
    currentTask: String(parsed.currentTask || '').trim(),
    taskStatus: normalizeTaskStatus(parsed.taskStatus),
    completed: arrayOfStrings(parsed.completed),
    inProgress: arrayOfStrings(parsed.inProgress),
    openIssues: arrayOfStrings(parsed.openIssues),
    decisions: arrayOfStrings(parsed.decisions),
    nextSteps: arrayOfStrings(parsed.nextSteps),
    criticalContext: arrayOfStrings(parsed.criticalContext),
    filesRead: arrayOfStrings(parsed.filesRead),
    filesModified: arrayOfStrings(parsed.filesModified),
    filesCreated: arrayOfStrings(parsed.filesCreated),
    filesDeleted: arrayOfStrings(parsed.filesDeleted),
    toolsUsed: arrayOfStrings(parsed.toolsUsed),
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
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(Math.min(attempt * 2, 10) * 1000);
        continue;
      }
      break;
    }
    const text = await res.text();
    lastText = text;
    if (res.ok) return text;
    if ((res.status === 408 || res.status === 429 || res.status >= 500) && attempt < attempts) {
      const retryAfter = Number(res.headers.get('retry-after')) || parseRetryAfter(text) || attempt * 2;
      await sleep(retryAfter * 1000);
      continue;
    }
    throw new Error(`${label} ${res.status}: ${text.slice(0, 1000)}`);
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastText.slice(0, 1000)}`, { cause: lastError });
}

function parseRetryAfter(text) {
  try { return Number(JSON.parse(text)?.details?.retryAfterSeconds) || 0; } catch { return 0; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildScoreMetadata(trace, observations, memory, timeline) {
  const derivedFiles = deriveFileOperations(observations);
  const filesRead = unique([...derivedFiles.filesRead, ...memory.filesRead]);
  const filesModified = unique([...derivedFiles.filesModified, ...memory.filesModified]);
  return trimMetadata({
    version: VERSION,
    promptVersion: PROMPT_VERSION,
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
    summary: memory.summary,
    goal: memory.goal,
    constraints: memory.constraints,
    currentTask: memory.currentTask,
    taskStatus: memory.taskStatus,
    completed: memory.completed,
    inProgress: memory.inProgress,
    openIssues: memory.openIssues,
    decisions: memory.decisions,
    nextSteps: memory.nextSteps,
    criticalContext: memory.criticalContext,
    filesRead,
    filesModified,
    filesCreated: memory.filesCreated,
    filesDeleted: memory.filesDeleted,
    filesTouched: unique([...filesRead, ...filesModified, ...memory.filesCreated, ...memory.filesDeleted]),
    toolsUsed: memory.toolsUsed.length ? memory.toolsUsed : unique(observations.map(o => o.metadata?.tool || (String(o.name || '').startsWith('tool:') ? String(o.name).slice(5) : '')).filter(Boolean)),
    sourceObservationIds: observations.map(o => o.id).filter(Boolean),
    sourceObservationCount: observations.length,
    timelinePreview: clamp(timeline, 6000),
    generatedAt: new Date().toISOString(),
  });
}

function deriveFileOperations(observations) {
  const filesRead = [];
  const filesModified = [];
  for (const observation of observations) {
    const tool = observation.metadata?.tool || String(observation.name || '').replace(/^tool:/, '');
    let input = observation.input;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch {}
    }
    const path = input && typeof input === 'object' ? input.path : undefined;
    if (typeof path !== 'string' || !path) continue;
    if (tool === 'read') filesRead.push(path);
    if (tool === 'edit' || tool === 'write') filesModified.push(path);
  }
  return { filesRead: unique(filesRead), filesModified: unique(filesModified) };
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

function normalizeTaskStatus(value) {
  return ['active', 'waiting_for_user', 'blocked', 'complete'].includes(String(value)) ? String(value) : 'active';
}

function detectDegenerateRepetition(text) {
  if (text.length < 2000) return false;
  const windows = new Map();
  const size = 200;
  const step = Math.max(1, Math.floor(text.length / 50));
  let duplicates = 0;
  let total = 0;
  for (let i = 0; i + size <= text.length; i += step) {
    const window = text.slice(i, i + size);
    const count = (windows.get(window) || 0) + 1;
    windows.set(window, count);
    if (count > 1) duplicates++;
    total++;
  }
  return (total > 5 && duplicates / total > 0.4) || text.split('\n').some(line => line.length > 50_000);
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

