#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import {
  REFLECTION_PROMPT_VERSION as PROMPT_VERSION,
  REFLECTION_SYSTEM_PROMPT,
  REFLECTION_COMPRESSION_GUIDANCE,
  REQUIRED_REFLECTION_HEADINGS,
} from '../memory/memory-prompts.js';
import { validateMemoryOutput } from '../memory/memory-validation.js';
import { evaluateReflectionQuality, renderReflectionMarkdown } from '../memory/memory-reflection.js';
import { alignDurableItems, reduceDurableItems } from '../memory/memory-quality.js';
import { aggregatePiReflectionProvenance } from '../memory/memory-provenance.js';
import { findPiSessionFile } from '../memory/memory-pi-entries.js';
import { filterMemoryScoresForBranch } from '../memory/memory-context.js';
import {
  estimateTokens,
  generatedAt,
  latestReflection,
  metadataString,
  metadataStrings,
  observationFields,
  reflectionFields,
  reflectionThresholdMet,
} from '../memory/memory-state.js';

const OBSERVATION_SCORE_NAME = 'memory_trace_observation';
const REFLECTION_SCORE_NAME = 'memory_session_reflection';
const VERSION = 'v2';
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
let lfRequestQueue = Promise.resolve();
class MemoryOutputValidationError extends Error {}

if (!reflectionEnabled) fail('Reflection disabled. Set memory.reflection.enabled=true or PI_LANGFUSE_REFLECTION_ENABLED=true.');
if (!observerModel) fail('Missing reflector model. Configure observer.model or OBSERVER_MODEL.');
if (!observerApiKey) fail('Missing reflector API key. Configure observer.apiKey or OBSERVER_API_KEY.');

const scoreIds = await fetchScoreIdsForSession(sessionId);
const [allObservations, allReflections] = await Promise.all([
  fetchScoresByIds(scoreIds, OBSERVATION_SCORE_NAME),
  fetchScoresByName(REFLECTION_SCORE_NAME),
]);
const sessionObservations = allObservations
  .filter(score => metadataString(score, 'version') === VERSION
    && metadataString(score, 'sessionId') === sessionId
    && score.metadata?.memoryStatus === 'ready'
    && score.metadata?.replacementEligible === true)
  .sort((a, b) => generatedAt(a).localeCompare(generatedAt(b)));
if (!sessionObservations.length) fail(`No ${OBSERVATION_SCORE_NAME} scores found for session ${sessionId}.`);

const pathKey = String(args.path || metadataString(sessionObservations[sessionObservations.length - 1], 'pathKey') || '');
let observations = sessionObservations.filter(score => !pathKey || metadataString(score, 'pathKey') === pathKey);
let reflections = allReflections.filter(score =>
  metadataString(score, 'version') === VERSION
  && metadataString(score, 'sessionId') === sessionId
  && (!pathKey || metadataString(score, 'pathKey') === pathKey)
);
const piBranch = loadPiBranch(sessionId, String(args['branch-leaf'] || ''));
if (piBranch.length) {
  observations = filterMemoryScoresForBranch(observations, piBranch);
  reflections = filterMemoryScoresForBranch(reflections, piBranch);
}
const requestedBaseReflectionId = String(args['base-reflection'] || '');
const previous = requestedBaseReflectionId
  ? reflections.find(score => score.id === requestedBaseReflectionId)
  : latestReflection(reflections);
if (requestedBaseReflectionId && !previous) fail(`Compatible base reflection not found: ${requestedBaseReflectionId}`);
const coveredUntil = metadataString(previous, 'coveredUntil');
let newObservations = coveredUntil ? observations.filter(score => generatedAt(score) > coveredUntil) : observations;
if (Number.isFinite(limit)) newObservations = newObservations.slice(0, limit);

const previousPayload = JSON.stringify(reflectionFields(previous), null, 2);
const newObservationPayload = JSON.stringify(newObservations.map(observationFields), null, 2);
const activeTokens = estimateTokens(`${previousPayload}\n\n${newObservationPayload}`);
const newObservationTokens = newObservations.length ? estimateTokens(newObservationPayload) : 0;
const thresholdMet = reflectionThresholdMet({ newObservations, activeTokens, newObservationTokens }, {
  activeTokens: thresholdTokens,
  newObservationTokens: minNewObservationTokens,
  newObservations: minNewObservations,
});

console.log(JSON.stringify({
  sessionId,
  pathKey,
  branchLeafEntryId: piBranch.at(-1)?.id || null,
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

const reflection = await generateReflection(previous, newObservations, { sessionId, pathKey, branchLeafEntryId: piBranch.at(-1)?.id || '' });
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

function loadPiBranch(id, requestedLeafId) {
  const sessionFile = findPiSessionFile(join(homedir(), '.pi', 'agent', 'sessions'), id);
  if (!sessionFile) return [];
  const entries = readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.id);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const parentIds = new Set(entries.map(entry => entry.parentId).filter(Boolean));
  const leaf = requestedLeafId ? byId.get(requestedLeafId) : entries.filter(entry => !parentIds.has(entry.id)).at(-1);
  if (!leaf) fail(`Pi branch leaf not found: ${requestedLeafId}`);
  const branch = [];
  for (let entry = leaf; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.unshift(entry);
  return branch;
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

async function lfRequest(path, init = {}) {
  const request = lfRequestQueue.catch(() => undefined).then(async () => {
    let lastError;
    for (let attempt = 1; attempt <= 5; attempt++) {
      let response;
      try {
        response = await fetch(`${config.host}${path}`, {
          ...init,
          headers: { Authorization: auth, ...init.headers },
        });
      } catch (error) {
        lastError = error;
        if (attempt < 5) {
          await sleep(Math.min(2 ** (attempt - 1), 10) * 1000);
          continue;
        }
        break;
      }
      const raw = await response.text();
      if (response.ok) return raw;
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 5) throw new Error(`Langfuse ${init.method || 'GET'} ${response.status}: ${raw.slice(0, 1000)}`);
      await sleep(langfuseRetryAfterMs(response, raw, attempt));
    }
    throw new Error(`Langfuse ${init.method || 'GET'} failed after 5 attempts`, { cause: lastError });
  });
  lfRequestQueue = request.then(() => undefined, () => undefined);
  return request;
}

function langfuseRetryAfterMs(response, raw, attempt) {
  const header = response.headers.get('retry-after');
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  if (header) {
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  try {
    const bodySeconds = Number(JSON.parse(raw)?.details?.retryAfterSeconds);
    if (Number.isFinite(bodySeconds) && bodySeconds > 0) return bodySeconds * 1000;
  } catch {}
  return Math.min(2 ** (attempt - 1), 10) * 1000;
}

async function lfGet(path) {
  const raw = await lfRequest(path);
  return raw ? JSON.parse(raw) : {};
}

function observerEndpoint() {
  const base = observerBaseUrl.replace(/\/+$/, '');
  if (observerApi === 'openai') return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

async function complete(system, user) {
  const headers = { Authorization: `Bearer ${observerApiKey}`, 'Content-Type': 'application/json' };
  if (observerApi === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  const body = observerApi === 'openai'
    ? { model: observerModel, temperature: 0, max_tokens: 12000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
    : { model: observerModel, temperature: 0, max_tokens: 12000, stream: false, system, messages: [{ role: 'user', content: user }] };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await fetch(observerEndpoint(), { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`reflector connection failed; retrying (${attempt}/3)`);
        await sleep(attempt * 1000);
        continue;
      }
      break;
    }
    const raw = await response.text();
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (retryable && attempt < 3) {
        console.warn(`reflector model ${response.status}; retrying (${attempt}/3)`);
        await sleep(retryAfterMs(response, raw, attempt));
        continue;
      }
      throw new Error(`Reflector model ${response.status}: ${raw.slice(0, 1000)}`);
    }
    const data = JSON.parse(raw);
    const text = observerApi === 'openai'
      ? data.choices?.[0]?.message?.content
      : (data.content || []).filter(part => part.type === 'text' && part.text).map(part => part.text).join('\n');
    if (!text?.trim()) throw new Error('Reflector model returned no text.');
    return text.trim();
  }
  throw new Error('Reflector model connection failed after 3 attempts', { cause: lastError });
}

async function generateReflection(previous, scores, scope) {
  const previousFields = reflectionFields(previous);
  const newObservationFields = scores.map(observationFields);
  const inputTokens = estimateTokens(`${JSON.stringify(previousFields, null, 2)}\n\n${JSON.stringify(newObservationFields, null, 2)}`);
  const targetTokens = Math.max(2_000, Math.min(10_000, Math.floor(inputTokens * 0.5)));
  const user = `Consolidate the delimited memory into one updated coding checkpoint.

<previous-reflection>
${JSON.stringify(previousFields, null, 2)}
</previous-reflection>

<new-observations>
${JSON.stringify(newObservationFields, null, 2)}
</new-observations>

Return ONLY valid JSON:
{
  "summary": "short session summary",
  "goal": ["current user goal"],
  "constraints": ["requirement or preference"],
  "currentTask": "current unresolved task/status",
  "taskStatus": "active | waiting_for_user | blocked | complete",
  "completed": ["verified completed outcome"],
  "inProgress": ["unfinished work"],
  "openIssues": ["remaining issue or blocker"],
  "decisions": ["decision and rationale"],
  "nextSteps": ["ordered next action"],
  "criticalContext": ["detail required to continue"],
  "filesRead": ["path inspected"],
  "filesModified": ["path changed"],
  "filesCreated": ["path created"],
  "filesDeleted": ["path deleted"],
  "toolsUsed": ["tool name"],
  "durableItems": [{"id":"stable existing ID","kind":"request | decision | constraint | fact | task | question | commitment","topic":"stable topic","content":"canonical state","status":"active | completed | superseded | revoked | proposed","authority":"user | verified-result | assistant-proposal","sourceEntryIds":["exact Pi entry ID"]}]
}

Target rendered checkpoint size: at most ${targetTokens} estimated tokens.`;
  const compressionGuidance = REFLECTION_COMPRESSION_GUIDANCE;
  let parsed;
  let renderedMarkdown = '';
  let qualityMetrics = {};
  let compressionAttempt = 0;
  let lastError;
  let correction = '';
  for (let attempt = 1; attempt <= compressionGuidance.length; attempt++) {
    compressionAttempt = attempt;
    try {
      const text = await complete(REFLECTION_SYSTEM_PROMPT, `${user}\n\nCompression guidance: ${compressionGuidance[attempt - 1]}${correction}`);
      if (detectDegenerateRepetition(text)) throw new MemoryOutputValidationError('Reflector output contains degenerate repetition');
      let candidate;
      try {
        candidate = JSON.parse(extractJson(text));
      } catch (error) {
        throw new MemoryOutputValidationError(`Reflector returned invalid JSON: ${error instanceof Error ? error.message : error}`);
      }
      const validationError = validateMemoryOutput(candidate, 'reflection');
      if (validationError) throw new MemoryOutputValidationError(`Invalid reflector schema: ${validationError}`);
      const previousDurableItems = Array.isArray(previousFields?.durableItems) ? previousFields.durableItems : [];
      const observationDurableItems = newObservationFields.flatMap(item => Array.isArray(item.durableItems) ? item.durableItems : []);
      const reducedDurable = reduceDurableItems(
        previousDurableItems,
        alignDurableItems(previousDurableItems, observationDurableItems, Array.isArray(candidate.durableItems) ? candidate.durableItems : []),
      );
      const canonical = {
        ...candidate,
        summary: String(candidate.summary).trim(),
        goal: arrayOfStrings(candidate.goal),
        constraints: arrayOfStrings(candidate.constraints),
        currentTask: String(candidate.currentTask || '').trim(),
        taskStatus: normalizeTaskStatus(candidate.taskStatus),
        completed: arrayOfStrings(candidate.completed),
        inProgress: arrayOfStrings(candidate.inProgress),
        openIssues: arrayOfStrings(candidate.openIssues),
        decisions: arrayOfStrings(candidate.decisions),
        nextSteps: arrayOfStrings(candidate.nextSteps),
        criticalContext: arrayOfStrings(candidate.criticalContext),
        filesRead: unique([...metadataStrings(previous, 'filesRead'), ...newObservationFields.flatMap(item => item.filesRead), ...arrayOfStrings(candidate.filesRead)]),
        filesModified: unique([...metadataStrings(previous, 'filesModified'), ...newObservationFields.flatMap(item => item.filesModified), ...arrayOfStrings(candidate.filesModified)]),
        filesCreated: unique([...metadataStrings(previous, 'filesCreated'), ...newObservationFields.flatMap(item => item.filesCreated), ...arrayOfStrings(candidate.filesCreated)]),
        filesDeleted: unique([...metadataStrings(previous, 'filesDeleted'), ...newObservationFields.flatMap(item => item.filesDeleted), ...arrayOfStrings(candidate.filesDeleted)]),
        toolsUsed: unique([...metadataStrings(previous, 'toolsUsed'), ...newObservationFields.flatMap(item => item.toolsUsed), ...arrayOfStrings(candidate.toolsUsed)]),
        durableItems: reducedDurable.items,
        supersededItems: reducedDurable.superseded,
        decisionConflicts: reducedDurable.conflicts,
      };
      const quality = evaluateReflectionQuality(canonical, previousFields, newObservationFields);
      if (quality.errors.length) throw new MemoryOutputValidationError(`Reflection quality failed: ${quality.errors.join('; ')}`);
      const markdown = renderReflectionMarkdown(canonical);
      const missingHeading = REQUIRED_REFLECTION_HEADINGS.find(heading => !markdown.includes(heading));
      if (missingHeading) throw new MemoryOutputValidationError(`Rendered reflection missing ${missingHeading}`);
      const outputTokens = estimateTokens(markdown);
      if (outputTokens > Math.ceil(targetTokens * 1.02)) throw new MemoryOutputValidationError(`Reflection ${outputTokens} tokens exceeds ${targetTokens}-token target`);
      parsed = canonical;
      renderedMarkdown = markdown;
      qualityMetrics = quality.metrics;
      break;
    } catch (error) {
      if (!(error instanceof MemoryOutputValidationError) && !(error instanceof SyntaxError)) throw error;
      lastError = error;
      correction = `\nPrevious output was rejected: ${error instanceof Error ? error.message : error}. Correct that issue in the next output.`;
      if (attempt < compressionGuidance.length) console.warn(`reflection validation failed; retrying compression (${attempt}/${compressionGuidance.length})`);
    }
  }
  if (!parsed) throw lastError;
  const generation = Number(previous?.metadata?.generation || 0) + 1;
  const sourceObservationScoreIds = scores.map(score => score.id);
  const sourceTraceIds = unique(scores.map(score => score.traceId || metadataString(score, 'traceId')));
  const generated = new Date().toISOString();
  const durableItems = Array.isArray(parsed.durableItems) ? parsed.durableItems : [];
  const activeDurable = durableItems.filter(item => item?.status === 'active');
  const semanticCoverageComplete = (!previous || previous.metadata?.semanticCoverageComplete === true)
    && scores.every(score => score.metadata?.replacementEligible === true && score.metadata?.memoryStatus === 'ready');
  const piReflectionProvenance = aggregatePiReflectionProvenance(previous?.metadata, scores);
  const metadata = {
    version: VERSION,
    promptVersion: PROMPT_VERSION,
    scope: 'session',
    source: 'pi-langfuse-memory',
    reflectorApi: observerApi,
    reflectorModel: observerModel,
    generation,
    sessionId: scope.sessionId,
    cwd: scope.pathKey || null,
    pathKey: scope.pathKey || null,
    branchLeafEntryId: scope.branchLeafEntryId || null,
    reflectionMarkdown: renderedMarkdown,
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
    filesRead: unique([...metadataStrings(previous, 'filesRead'), ...newObservationFields.flatMap(item => item.filesRead), ...arrayOfStrings(parsed.filesRead)]),
    filesModified: unique([...metadataStrings(previous, 'filesModified'), ...newObservationFields.flatMap(item => item.filesModified), ...arrayOfStrings(parsed.filesModified)]),
    filesCreated: unique([...metadataStrings(previous, 'filesCreated'), ...newObservationFields.flatMap(item => item.filesCreated), ...arrayOfStrings(parsed.filesCreated)]),
    filesDeleted: unique([...metadataStrings(previous, 'filesDeleted'), ...newObservationFields.flatMap(item => item.filesDeleted), ...arrayOfStrings(parsed.filesDeleted)]),
    filesTouched: unique([...metadataStrings(previous, 'filesTouched'), ...newObservationFields.flatMap(item => item.filesTouched), ...arrayOfStrings(parsed.filesRead), ...arrayOfStrings(parsed.filesModified), ...arrayOfStrings(parsed.filesCreated), ...arrayOfStrings(parsed.filesDeleted)]),
    toolsUsed: unique([...metadataStrings(previous, 'toolsUsed'), ...newObservationFields.flatMap(item => item.toolsUsed), ...arrayOfStrings(parsed.toolsUsed)]),
    durableItems,
    activeUserRequests: activeDurable.filter(item => item.kind === 'request'),
    activeDecisions: activeDurable.filter(item => item.kind === 'decision'),
    activeConstraints: activeDurable.filter(item => item.kind === 'constraint'),
    verifiedFacts: activeDurable.filter(item => item.kind === 'fact' && item.authority === 'verified-result'),
    activeTasks: activeDurable.filter(item => item.kind === 'task'),
    openQuestions: activeDurable.filter(item => item.kind === 'question'),
    blockedItems: arrayOfStrings(parsed.openIssues),
    supersededItems: parsed.supersededItems || [],
    decisionConflicts: parsed.decisionConflicts || [],
    memoryStatus: 'ready',
    semanticCoverageComplete,
    inputTokensEstimated: inputTokens,
    outputTokensEstimated: estimateTokens(renderedMarkdown),
    compressionRatio: Number((estimateTokens(renderedMarkdown) / inputTokens).toFixed(3)),
    compressionAttempt,
    qualityMetrics,
    sourceTraceIds,
    sourceObservationScoreIds,
    sourceReflectionScoreIds: previous ? [previous.id] : [],
    sourceObservationCount: sourceObservationScoreIds.length,
    ...piReflectionProvenance,
    coveredUntil: generatedAt(scores[scores.length - 1]),
    generatedAt: generated,
  };
  return {
    id: deterministicUuid(`${REFLECTION_SCORE_NAME}:${VERSION}:${scope.sessionId}:${scope.pathKey}:${scope.branchLeafEntryId || 'unscoped'}:${generation}:${sourceObservationScoreIds.join(',')}`),
    name: REFLECTION_SCORE_NAME,
    value: 'reflected',
    sessionId: scope.sessionId,
    dataType: 'CATEGORICAL',
    comment: clamp(String(parsed.summary || firstLine(renderedMarkdown)), 1000),
    metadata,
  };
}

async function writeScore(score) {
  await lfRequest('/api/public/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(score),
  });
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`No JSON object in reflector output: ${text.slice(0, 1000)}`);
  return text.slice(start, end + 1);
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

function retryAfterMs(response, raw, attempt) {
  const seconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 30) * 1000;
  try {
    const providerSeconds = Number(JSON.parse(raw)?.details?.retryAfterSeconds);
    if (Number.isFinite(providerSeconds) && providerSeconds > 0) return Math.min(providerSeconds, 30) * 1000;
  } catch {}
  return attempt * 1000;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
