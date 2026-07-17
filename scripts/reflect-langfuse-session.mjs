#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

const OBSERVATION_SCORE_NAME = 'memory_trace_observation';
const REFLECTION_SCORE_NAME = 'memory_session_reflection';
const VERSION = 'v1';
const CONFIG_PATH = process.env.LANGFUSE_CONFIG || join(homedir(), '.pi', 'agent', 'extensions', 'langfuse', 'config.json');
const args = parseArgs(process.argv.slice(2));
const sessionId = normalizeSessionId(args.session || args._[0]);
const dryRun = Boolean(args['dry-run']);
const force = Boolean(args.force);
const limit = args.limit ? positiveInteger(args.limit, 0) : Infinity;

if (!sessionId) fail('Missing session id. Pass --session <id> or a positional session id.');

const config = loadConfig();
const observerApi = ((process.env.OBSERVER_API || process.env.PI_LANGFUSE_OBSERVER_API || config.observer?.api || (process.env.OPENAI_API_KEY ? 'openai' : 'anthropic')).toLowerCase() === 'openai') ? 'openai' : 'anthropic';
const observerModel = process.env.OBSERVER_MODEL || process.env.PI_LANGFUSE_OBSERVER_MODEL || config.observer?.model || '';
const observerBaseUrl = process.env.OBSERVER_BASE_URL || process.env.PI_LANGFUSE_OBSERVER_BASE_URL || config.observer?.baseUrl || (observerApi === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com');
const observerApiKey = process.env.OBSERVER_API_KEY || process.env.PI_LANGFUSE_OBSERVER_API_KEY || config.observer?.apiKey || (observerApi === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) || '';
const reflectionConfig = config.memory?.reflection || {};
const reflectionEnabled = process.env.PI_LANGFUSE_REFLECTION_ENABLED
  ? process.env.PI_LANGFUSE_REFLECTION_ENABLED !== 'false'
  : reflectionConfig.enabled === true;
const thresholdTokens = positiveInteger(process.env.PI_LANGFUSE_REFLECTION_THRESHOLD_TOKENS || reflectionConfig.thresholdTokens, 20_000);
const minNewObservationTokens = positiveInteger(process.env.PI_LANGFUSE_REFLECTION_MIN_NEW_TOKENS || reflectionConfig.minNewObservationTokens, 8_000);
const minNewObservations = positiveInteger(process.env.PI_LANGFUSE_REFLECTION_MIN_NEW_OBSERVATIONS || reflectionConfig.minNewObservations, 5);
const auth = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')}`;

if (!reflectionEnabled) fail('Reflection disabled. Set memory.reflection.enabled=true or PI_LANGFUSE_REFLECTION_ENABLED=true.');
if (!observerModel) fail('Missing reflector model. Configure observer.model or OBSERVER_MODEL.');
if (!observerApiKey) fail('Missing reflector API key. Configure observer.apiKey or OBSERVER_API_KEY.');

const scoreIds = await fetchScoreIdsForSession(sessionId);
const [allObservations, allReflections] = await Promise.all([
  fetchScoresByIds(scoreIds, OBSERVATION_SCORE_NAME),
  fetchScoresByName(REFLECTION_SCORE_NAME),
]);
const sessionObservations = allObservations
  .filter(score => metadataString(score, 'version') === VERSION && metadataString(score, 'sessionId') === sessionId)
  .sort((a, b) => generatedAt(a).localeCompare(generatedAt(b)));
if (!sessionObservations.length) fail(`No ${OBSERVATION_SCORE_NAME} scores found for session ${sessionId}.`);

const pathKey = String(args.path || metadataString(sessionObservations[sessionObservations.length - 1], 'pathKey') || '');
const observations = sessionObservations.filter(score => !pathKey || metadataString(score, 'pathKey') === pathKey);
const reflections = allReflections.filter(score =>
  metadataString(score, 'version') === VERSION
  && metadataString(score, 'sessionId') === sessionId
  && (!pathKey || metadataString(score, 'pathKey') === pathKey)
);
const previous = latestReflection(reflections);
const coveredUntil = metadataString(previous, 'coveredUntil');
let newObservations = coveredUntil ? observations.filter(score => generatedAt(score) > coveredUntil) : observations;
if (Number.isFinite(limit)) newObservations = newObservations.slice(0, limit);

const previousMarkdown = metadataString(previous, 'reflectionMarkdown');
const newMarkdown = newObservations.map(score => metadataString(score, 'observationsMarkdown')).join('\n\n');
const activeTokens = estimateTokens(`${previousMarkdown}\n\n${newMarkdown}`);
const newObservationTokens = estimateTokens(newMarkdown);
const thresholdMet = newObservations.length > 0
  && activeTokens >= thresholdTokens
  && newObservationTokens >= minNewObservationTokens
  && newObservations.length >= minNewObservations;

console.log(JSON.stringify({
  sessionId,
  pathKey,
  previousReflectionId: previous?.id || null,
  previousGeneration: Number(previous?.metadata?.generation || 0),
  coveredUntil: coveredUntil || null,
  newObservations: newObservations.length,
  activeTokensEstimated: activeTokens,
  newObservationTokensEstimated: newObservationTokens,
  thresholds: { thresholdTokens, minNewObservationTokens, minNewObservations },
  thresholdMet,
  force,
  dryRun,
}, null, 2));

if (!newObservations.length) {
  console.log('skip: no observations after coveredUntil');
  process.exit(0);
}
if (!thresholdMet && !force) {
  console.log('skip: reflection thresholds not met');
  process.exit(0);
}

const reflection = await generateReflection(previous, newObservations, { sessionId, pathKey });
if (dryRun) {
  console.log(JSON.stringify(reflection, null, 2));
} else {
  await writeScore(reflection);
  console.log(`wrote ${reflection.id} generation=${reflection.metadata.generation} coveredUntil=${reflection.metadata.coveredUntil}`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) out._.push(value);
    else if (value.includes('=')) {
      const [key, ...rest] = value.slice(2).split('=');
      out[key] = rest.join('=');
    } else {
      const key = value.slice(2);
      if (['dry-run', 'force'].includes(key)) out[key] = true;
      else out[key] = argv[++i];
    }
  }
  return out;
}

function normalizeSessionId(value) {
  return String(value || '').replace(/^\/?sessions\//, '').replace(/\.jsonl$/, '');
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) fail(`Langfuse config not found: ${CONFIG_PATH}`);
  const value = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (!value.publicKey || !value.secretKey) fail('Langfuse config missing publicKey/secretKey.');
  return { ...value, host: value.host || 'https://cloud.langfuse.com' };
}

function metadataString(score, key) {
  return typeof score?.metadata?.[key] === 'string' ? score.metadata[key] : '';
}

function metadataStrings(score, key) {
  return arrayOfStrings(score?.metadata?.[key]);
}

function generatedAt(score) {
  return metadataString(score, 'generatedAt') || score.createdAt || '';
}

function latestReflection(scores) {
  return [...scores].sort((a, b) => {
    const generationDiff = Number(b.metadata?.generation || 0) - Number(a.metadata?.generation || 0);
    return generationDiff || generatedAt(b).localeCompare(generatedAt(a));
  })[0];
}

function estimateTokens(value) {
  return Math.ceil(String(value || '').length / 4);
}

async function fetchScoreIdsForSession(id) {
  const ids = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ sessionId: id, page: String(page), limit: '100', fields: 'core,scores' });
    const response = await lfGet(`/api/public/traces?${params}`);
    for (const trace of response.data || []) ids.push(...(trace.scores || []));
    if (!response.meta?.totalPages || page >= response.meta.totalPages) break;
  }
  return unique(ids);
}

async function fetchScoresByIds(ids, name) {
  const scores = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const params = new URLSearchParams({ name, dataType: 'CATEGORICAL', limit: '100', scoreIds: ids.slice(offset, offset + 50).join(',') });
    const response = await lfGet(`/api/public/v2/scores?${params}`);
    scores.push(...(response.data || []));
  }
  return scores;
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

async function lfGet(path) {
  const response = await fetch(`${config.host}${path}`, { headers: { Authorization: auth } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Langfuse GET ${response.status}: ${raw.slice(0, 1000)}`);
  return raw ? JSON.parse(raw) : {};
}

function observerEndpoint() {
  const base = observerBaseUrl.replace(/\/+$/, '');
  if (observerApi === 'openai') return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

async function complete(prompt) {
  const headers = { Authorization: `Bearer ${observerApiKey}`, 'Content-Type': 'application/json' };
  if (observerApi === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  const body = observerApi === 'openai'
    ? { model: observerModel, temperature: 0.1, max_tokens: 6000, messages: [{ role: 'user', content: prompt }] }
    : { model: observerModel, temperature: 0.1, max_tokens: 6000, stream: false, messages: [{ role: 'user', content: prompt }] };
  const response = await fetch(observerEndpoint(), { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Reflector model ${response.status}: ${raw.slice(0, 1000)}`);
  const data = JSON.parse(raw);
  const text = observerApi === 'openai'
    ? data.choices?.[0]?.message?.content
    : (data.content || []).filter(part => part.type === 'text' && part.text).map(part => part.text).join('\n');
  if (!text?.trim()) throw new Error('Reflector model returned no text.');
  return text.trim();
}

async function generateReflection(previous, scores, scope) {
  const previousFields = previous ? {
    reflectionMarkdown: metadataString(previous, 'reflectionMarkdown'),
    summary: metadataString(previous, 'summary'),
    currentTask: metadataString(previous, 'currentTask'),
    filesTouched: metadataStrings(previous, 'filesTouched'),
    toolsUsed: metadataStrings(previous, 'toolsUsed'),
    decisions: metadataStrings(previous, 'decisions'),
    completed: metadataStrings(previous, 'completed'),
    openIssues: metadataStrings(previous, 'openIssues'),
  } : null;
  const observationFields = scores.map(score => ({
    scoreId: score.id,
    traceId: score.traceId || metadataString(score, 'traceId'),
    generatedAt: generatedAt(score),
    observationsMarkdown: metadataString(score, 'observationsMarkdown'),
    summary: metadataString(score, 'summary'),
    currentTask: metadataString(score, 'currentTask'),
    filesTouched: metadataStrings(score, 'filesTouched'),
    toolsUsed: metadataStrings(score, 'toolsUsed'),
    decisions: metadataStrings(score, 'decisions'),
    completed: metadataStrings(score, 'completed'),
    openIssues: metadataStrings(score, 'openIssues'),
  }));
  const prompt = `You are the reflector for an AI coding assistant's append-only observational memory.

Consolidate the previous reflection and new observations into dense, accurate session memory. This may become the ONLY context retained from the covered work.

Rules:
- Preserve exact user goals, current status, file paths, commands, errors, ports, URLs, IDs, tests, and decisions when useful.
- Carry forward unresolved work and still-valid facts.
- Remove duplicate or superseded details.
- Move clearly resolved open issues into completed outcomes.
- Keep filesTouched and toolsUsed comprehensive and deduplicated.
- Do not invent completion or resolution.
- Keep reflectionMarkdown concise but actionable and chronological where timing matters.

Return ONLY valid JSON:
{
  "reflectionMarkdown": "dense human-readable session memory",
  "summary": "short session summary",
  "currentTask": "current unresolved task/status",
  "filesTouched": ["path/or/file.ts"],
  "toolsUsed": ["bash", "read"],
  "decisions": ["decision/rationale"],
  "completed": ["concrete completed outcome"],
  "openIssues": ["still-open issue"]
}

Previous reflection:
${JSON.stringify(previousFields, null, 2)}

New observations ordered by generatedAt:
${JSON.stringify(observationFields, null, 2)}`;
  const parsed = JSON.parse(extractJson(await complete(prompt)));
  const generation = Number(previous?.metadata?.generation || 0) + 1;
  const sourceObservationScoreIds = scores.map(score => score.id);
  const sourceTraceIds = unique(scores.map(score => score.traceId || metadataString(score, 'traceId')));
  const generated = new Date().toISOString();
  const metadata = {
    version: VERSION,
    scope: 'session',
    source: 'pi-langfuse-memory',
    reflectorApi: observerApi,
    reflectorModel: observerModel,
    generation,
    sessionId: scope.sessionId,
    cwd: scope.pathKey || null,
    pathKey: scope.pathKey || null,
    reflectionMarkdown: clamp(String(parsed.reflectionMarkdown || ''), 24_000),
    summary: clamp(String(parsed.summary || ''), 3_000),
    currentTask: clamp(String(parsed.currentTask || ''), 2_000),
    filesTouched: unique([...metadataStrings(previous, 'filesTouched'), ...observationFields.flatMap(item => item.filesTouched), ...arrayOfStrings(parsed.filesTouched)]),
    toolsUsed: unique([...metadataStrings(previous, 'toolsUsed'), ...observationFields.flatMap(item => item.toolsUsed), ...arrayOfStrings(parsed.toolsUsed)]),
    decisions: arrayOfStrings(parsed.decisions),
    completed: arrayOfStrings(parsed.completed),
    openIssues: arrayOfStrings(parsed.openIssues),
    sourceTraceIds,
    sourceObservationScoreIds,
    sourceReflectionScoreIds: previous ? [previous.id] : [],
    sourceObservationCount: sourceObservationScoreIds.length,
    coveredUntil: generatedAt(scores[scores.length - 1]),
    generatedAt: generated,
  };
  return {
    id: deterministicUuid(`${REFLECTION_SCORE_NAME}:${VERSION}:${scope.sessionId}:${scope.pathKey}:${generation}`),
    name: REFLECTION_SCORE_NAME,
    value: 'reflected',
    sessionId: scope.sessionId,
    dataType: 'CATEGORICAL',
    comment: clamp(String(parsed.summary || firstLine(parsed.reflectionMarkdown)), 1000),
    metadata,
  };
}

async function writeScore(score) {
  const response = await fetch(`${config.host}/api/public/scores`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(score),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Langfuse score write ${response.status}: ${raw.slice(0, 1000)}`);
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`No JSON object in reflector output: ${text.slice(0, 1000)}`);
  return text.slice(start, end + 1);
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function firstLine(value) {
  return String(value || '').split('\n').map(line => line.trim()).find(Boolean) || 'Session reflected';
}

function clamp(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function deterministicUuid(input) {
  const chars = crypto.createHash('sha256').update(input).digest('hex').slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
