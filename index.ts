/**
 * Langfuse Observability Extension for Pi Coding Agent
 * 
 * Sends traces to Langfuse for monitoring tokens, costs, latency, and tool calls.
 * Uses dynamic import to load the langfuse SDK properly.
 * 
 * Scores tracked:
 * - tool_call_count: Total number of tool calls
 * - turn_count: Number of turns in the session
 * - total_tool_errors: Number of tools that returned errors
 * - tool_success_rate: Success rate of tool calls (0-1)
 * - session_had_errors: Boolean indicating if any tool error occurred
 * - tool_is_error: Per-tool score indicating if that specific tool call errored
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  OBSERVER_PROMPT_VERSION,
  REFLECTION_PROMPT_VERSION,
  OBSERVER_SYSTEM_PROMPT,
  REFLECTION_SYSTEM_PROMPT,
  REFLECTION_COMPRESSION_GUIDANCE,
  REQUIRED_REFLECTION_HEADINGS,
} from "./memory-prompts.js";
import { validateMemoryOutput } from "./memory-validation.js";
import { createMemoryCache } from "./memory-cache.js";
import { evaluateReflectionQuality, renderReflectionMarkdown } from "./memory-reflection.js";
import { formatMemoryResult, redactSecrets, searchMemoryScores } from "./memory-lookup.js";
import { buildMemoryContextText, replaceWithMemoryContext } from "./memory-context.js";
import { appendMemoryErrorLog, describeMemoryOutput } from "./memory-error-log.js";
import {
  buildActiveMemory,
  estimateTokens,
  generatedAt,
  metadataString,
  metadataStrings,
  observationFields,
  reflectionFields,
  reflectionThresholdMet,
  sameMemoryScope,
} from "./memory-state.js";

// ============================================
// Configuration
// ============================================

interface ObserverConfig {
  enabled?: boolean;
  api?: "anthropic" | "openai";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

interface ReflectionConfig {
  enabled?: boolean;
  thresholdTokens?: number;
  minNewObservationTokens?: number;
  minNewObservations?: number;
}

interface Config {
  publicKey: string;
  secretKey: string;
  host: string;
  observer?: ObserverConfig;
  memory?: {
    reflection?: ReflectionConfig;
  };
}

function loadConfig(): Config {
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "config.json");
  
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const config = JSON.parse(content) as Config;
      if (config.publicKey && config.secretKey) {
        return {
          publicKey: config.publicKey,
          secretKey: config.secretKey,
          host: config.host || "https://cloud.langfuse.com",
          observer: config.observer,
          memory: config.memory,
        };
      }
    } catch (e) {
      console.warn("📊 Langfuse: Failed to load config.json", e);
    }
  }

  return {
    publicKey: "",
    secretKey: "",
    host: "https://cloud.langfuse.com",
  };
}

const config = loadConfig();
const MEMORY_ERROR_LOG_PATH = process.env.PI_LANGFUSE_MEMORY_ERROR_LOG
  || resolve(homedir(), ".pi", "agent", "logs", "langfuse-memory-errors.jsonl");
let memoryErrorLogWarningShown = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestErrorDetails(error: unknown): Record<string, unknown> {
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return {
    error: errorMessage(error),
    cause: cause ? errorMessage(cause) : undefined,
    code: typeof code === "string" ? code : undefined,
  };
}

function logMemoryError(entry: Record<string, unknown>): void {
  try {
    appendMemoryErrorLog(MEMORY_ERROR_LOG_PATH, entry);
  } catch (error) {
    if (!memoryErrorLogWarningShown) {
      console.warn(`📊 Langfuse: Failed to write memory error log ${MEMORY_ERROR_LOG_PATH}`, error);
      memoryErrorLogWarningShown = true;
    }
  }
}

// ============================================
// Langfuse Client (lazy-loaded via dynamic import)
// ============================================

interface LangfuseSpan {
  id: string;
  end(body?: { metadata?: Record<string, unknown>; isError?: boolean; output?: unknown }): void;
}

interface LangfuseGeneration {
  id: string;
  end(body?: { metadata?: Record<string, unknown>; usage?: unknown; output?: unknown; costDetails?: unknown }): void;
}

interface LangfuseClient {
  trace(body?: { name: string; metadata?: Record<string, unknown>; input?: unknown; output?: unknown; sessionId?: string }): {
    id: string;
    update(body?: { metadata?: Record<string, unknown>; output?: unknown; input?: unknown }): void;
  };
  span(body: { name: string; traceId: string; metadata?: Record<string, unknown>; input?: unknown }): LangfuseSpan;
  generation(body: { name: string; traceId: string; metadata?: Record<string, unknown>; input?: unknown; output?: unknown; usage?: unknown; model?: string; costDetails?: unknown }): LangfuseGeneration;
  score(body: { id?: string; name: string; value: number | string; traceId?: string; observationId?: string; dataType?: "NUMERIC" | "BOOLEAN" | "CATEGORICAL"; comment?: string; metadata?: Record<string, unknown> }): void;
  shutdownAsync(): Promise<void>;
}

let client: LangfuseClient | null = null;

async function getClient(): Promise<LangfuseClient> {
  if (!client) {
    const lib = await import("langfuse") as {
      Langfuse: new (options: { publicKey: string; secretKey?: string; baseUrl?: string }) => LangfuseClient;
    };
    client = new lib.Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.host,
    });
  }
  return client;
}

// ============================================
// State
// ============================================

interface TraceData {
  id: string;
  update?: (body?: { metadata?: Record<string, unknown>; output?: unknown; input?: unknown }) => void;
}

interface SpanData {
  span: LangfuseSpan;
  toolName: string;
}

interface TraceStep {
  id: string;
  type: "tool" | "generation";
  name: string;
  timestamp: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  isError?: boolean;
}

interface TraceSnapshot {
  traceId: string;
  traceTimestamp: string;
  sessionId: string;
  cwd: string;
  model: string;
  provider: string;
  userPrompt: string;
  output?: string;
  steps: TraceStep[];
}

interface AgentContentPart {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface ObservedAgentMessage {
  role: string;
  content?: AgentContentPart[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number | string;
}

let currentTrace: TraceData | null = null;
let currentTraceTimestamp: string = "";
let currentUserPrompt: string = "";
let currentSessionId: string = "";
let currentModel: string = "";
let currentProvider: string = "";
let currentCwd: string = "";
const activeSpans: Map<string, SpanData> = new Map();
const traceSteps: TraceStep[] = [];
const memoryQueues = new Map<string, Promise<void>>();
const sessionMemoryCache = createMemoryCache(300_000);
let lookupScoresCache: { scores: MemoryScore[]; loadedAt: number } | undefined;
const lookupTraceCache = new Map<string, { value: Record<string, unknown>; loadedAt: number }>();
let memoryContextEnabled = false;
let lastMemoryContextErrorAt = 0;

// Evaluation tracking state
let toolCallCount: number = 0;
let errorCount: number = 0;
let turnCount: number = 0;

function resetSessionState() {
  toolCallCount = 0;
  errorCount = 0;
  turnCount = 0;
  activeSpans.clear();
  currentTrace = null;
  currentTraceTimestamp = "";
  currentUserPrompt = "";
  currentModel = "";
  currentProvider = "";
  currentCwd = "";
  traceSteps.length = 0;
}

function computeEvaluationScores() {
  const toolSuccessRate = toolCallCount > 0 
    ? (toolCallCount - errorCount) / toolCallCount 
    : 1;
  const sessionHadErrors = errorCount > 0;
  
  return {
    tool_call_count: toolCallCount,
    turn_count: turnCount,
    total_tool_errors: errorCount,
    tool_success_rate: toolSuccessRate,
    session_had_errors: sessionHadErrors ? 1 : 0, // 1 for true, 0 for false
  };
}

// ============================================
// Trace Memory Observation
// ============================================

const MEMORY_SCORE_NAME = "memory_trace_observation";
const REFLECTION_SCORE_NAME = "memory_session_reflection";
const MEMORY_SCORE_VERSION = "v1";
type ObserverApi = "anthropic" | "openai";
const configuredObserverApi = process.env.PI_LANGFUSE_OBSERVER_API || config.observer?.api || (process.env.OPENAI_API_KEY ? "openai" : "anthropic");
const OBSERVER_API = (configuredObserverApi.toLowerCase() === "openai" ? "openai" : "anthropic") as ObserverApi;
const OBSERVER_ENABLED = process.env.PI_LANGFUSE_OBSERVER_ENABLED === "false" ? false : config.observer?.enabled !== false;
const OBSERVER_MODEL = process.env.PI_LANGFUSE_OBSERVER_MODEL || config.observer?.model || "";
const OBSERVER_BASE_URL = process.env.PI_LANGFUSE_OBSERVER_BASE_URL || config.observer?.baseUrl || (OBSERVER_API === "openai" ? "https://api.openai.com" : "https://api.anthropic.com");
const OBSERVER_API_KEY = process.env.PI_LANGFUSE_OBSERVER_API_KEY || config.observer?.apiKey || (OBSERVER_API === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) || "";
const reflectionConfig = config.memory?.reflection;
const REFLECTION_ENABLED = process.env.PI_LANGFUSE_REFLECTION_ENABLED
  ? process.env.PI_LANGFUSE_REFLECTION_ENABLED !== "false"
  : reflectionConfig?.enabled === true;
const REFLECTION_THRESHOLD_TOKENS = positiveInteger(process.env.PI_LANGFUSE_REFLECTION_THRESHOLD_TOKENS || reflectionConfig?.thresholdTokens, 20_000);
const REFLECTION_MIN_NEW_TOKENS = positiveInteger(process.env.PI_LANGFUSE_REFLECTION_MIN_NEW_TOKENS || reflectionConfig?.minNewObservationTokens, 8_000);
const REFLECTION_MIN_NEW_OBSERVATIONS = positiveInteger(process.env.PI_LANGFUSE_REFLECTION_MIN_NEW_OBSERVATIONS || reflectionConfig?.minNewObservations, 5);

interface MemoryScore {
  id: string;
  name?: string;
  traceId?: string | null;
  sessionId?: string | null;
  createdAt?: string;
  comment?: string | null;
  metadata?: Record<string, unknown>;
}

interface ActiveSessionMemory {
  latestReflection?: MemoryScore;
  newObservations: MemoryScore[];
  activeTokens: number;
  newObservationTokens: number;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function observerEndpoint(): string {
  const base = OBSERVER_BASE_URL.replace(/\/+$/, "");
  if (OBSERVER_API === "openai") return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

function deterministicUuid(input: string): string {
  const chars = createHash("sha256").update(input).digest("hex").slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = ((parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function clampText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

class MemoryOutputValidationError extends Error {}

function taskStatus(value: unknown): "active" | "waiting_for_user" | "blocked" | "complete" {
  return ["active", "waiting_for_user", "blocked", "complete"].includes(String(value))
    ? String(value) as "active" | "waiting_for_user" | "blocked" | "complete"
    : "active";
}

function detectDegenerateRepetition(text: string): boolean {
  if (text.length < 2000) return false;
  const windows = new Map<string, number>();
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
  return (total > 5 && duplicates / total > 0.4) || text.split("\n").some(line => line.length > 50_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response, raw: string, attempt: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 30) * 1000;
  try {
    const providerSeconds = Number(JSON.parse(raw)?.details?.retryAfterSeconds);
    if (Number.isFinite(providerSeconds) && providerSeconds > 0) return Math.min(providerSeconds, 30) * 1000;
  } catch {}
  return attempt * 1000;
}

function deriveFileOperations(steps: TraceStep[]) {
  const filesRead: string[] = [];
  const filesModified: string[] = [];
  for (const step of steps) {
    if (step.type !== "tool" || !step.input || typeof step.input !== "object") continue;
    const path = (step.input as Record<string, unknown>).path;
    if (typeof path !== "string" || !path) continue;
    const tool = step.name.replace(/^tool:/, "");
    if (tool === "read") filesRead.push(path);
    if (tool === "edit" || tool === "write") filesModified.push(path);
  }
  return { filesRead: unique(filesRead), filesModified: unique(filesModified) };
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in observer output");
  return text.slice(start, end + 1);
}

function firstLine(text: string): string {
  return text.split("\n").map(line => line.trim()).find(Boolean) || "Trace observed";
}

function messageTimestamp(value: number | string | undefined): string {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function contentText(content: AgentContentPart[] | undefined): string {
  return (content || [])
    .filter(part => part.type === "text" && part.text)
    .map(part => part.text)
    .join("\n");
}

function buildObservationSteps(messages: ObservedAgentMessage[], existingSteps: TraceStep[]): TraceStep[] {
  const steps = new Map(existingSteps.map(step => [step.id, { ...step }]));

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content || []) {
        if (part.type !== "toolCall" || !part.id || !part.name) continue;
        const existing = steps.get(part.id);
        steps.set(part.id, {
          id: part.id,
          type: "tool",
          name: `tool:${part.name}`,
          timestamp: existing?.timestamp || messageTimestamp(message.timestamp),
          input: existing?.input ?? part.arguments,
          output: existing?.output,
          metadata: { ...(existing?.metadata || {}), tool: part.name, source: "agent_messages" },
          isError: existing?.isError,
        });
      }
      continue;
    }

    if (message.role !== "toolResult" || !message.toolCallId) continue;
    const output = contentText(message.content);
    const existing = steps.get(message.toolCallId);
    steps.set(message.toolCallId, {
      id: message.toolCallId,
      type: "tool",
      name: `tool:${message.toolName || existing?.name.replace(/^tool:/, "") || "unknown"}`,
      timestamp: existing?.timestamp || messageTimestamp(message.timestamp),
      input: existing?.input,
      output: output || existing?.output,
      metadata: { ...(existing?.metadata || {}), tool: message.toolName || existing?.metadata?.tool, source: "agent_messages" },
      isError: message.isError ?? existing?.isError,
    });
  }

  return [...steps.values()];
}

async function observerComplete(
  system: string,
  user: string,
  maxTokens = 4000,
  label = "Observer",
  temperature = 0.1,
  diagnostics: Record<string, unknown> = {},
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${OBSERVER_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (OBSERVER_API === "anthropic") headers["anthropic-version"] = "2023-06-01";

  const body = OBSERVER_API === "openai"
    ? {
        model: OBSERVER_MODEL,
        temperature,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }
    : {
        model: OBSERVER_MODEL,
        max_tokens: maxTokens,
        temperature,
        stream: false,
        system,
        messages: [{ role: "user", content: user }],
      };

  const endpoint = observerEndpoint();
  const requestBody = JSON.stringify(body);
  const requestDiagnostics = {
    stage: `${label.toLowerCase()}-request`,
    endpointHost: new URL(endpoint).host,
    requestChars: requestBody.length,
    model: OBSERVER_MODEL,
    ...diagnostics,
  };
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: requestBody,
      });
    } catch (error) {
      lastError = error;
      logMemoryError({
        ...requestDiagnostics,
        kind: "connection",
        attempt,
        maxAttempts: 3,
        ...requestErrorDetails(error),
      });
      if (attempt === 3) break;
      console.warn(`📊 Langfuse: ${label} connection failed; retrying (${attempt}/3); details: ${MEMORY_ERROR_LOG_PATH}`);
      await sleep(attempt * 1000);
      continue;
    }

    const raw = await response.text();
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const retryDelayMs = retryable ? retryAfterMs(response, raw, attempt) : 0;
      logMemoryError({
        ...requestDiagnostics,
        kind: "http",
        attempt,
        maxAttempts: 3,
        status: response.status,
        retryable,
        retryDelayMs,
        responseChars: raw.length,
      });
      if (retryable && attempt < 3) {
        console.warn(`📊 Langfuse: ${label} model ${response.status}; retrying (${attempt}/3); details: ${MEMORY_ERROR_LOG_PATH}`);
        await sleep(retryDelayMs);
        continue;
      }
      throw new Error(`${label} model ${response.status}`);
    }

    let data: Record<string, any>;
    try {
      data = JSON.parse(raw) as Record<string, any>;
    } catch (error) {
      logMemoryError({
        ...requestDiagnostics,
        kind: "invalid-response-json",
        attempt,
        maxAttempts: 3,
        responseChars: raw.length,
        ...requestErrorDetails(error),
      });
      throw error;
    }
    const text = OBSERVER_API === "openai"
      ? data.choices?.[0]?.message?.content
      : (data.content || [])
          .filter((part: { type?: string; text?: string }) => part.type === "text" && part.text)
          .map((part: { text: string }) => part.text)
          .join("\n");
    if (!text?.trim()) {
      logMemoryError({
        ...requestDiagnostics,
        kind: "empty-response",
        attempt,
        maxAttempts: 3,
        responseChars: raw.length,
      });
      throw new Error(`${label} model returned no text`);
    }
    return text.trim();
  }

  throw new Error(`${label} model connection failed after 3 attempts`, { cause: lastError });
}

function buildTraceTimeline(snapshot: TraceSnapshot) {
  const lines = [
    `Trace ${snapshot.traceId}`,
    `Session: ${snapshot.sessionId}`,
    `Trace time: ${snapshot.traceTimestamp}`,
    `CWD: ${snapshot.cwd}`,
    `Model: ${snapshot.provider}/${snapshot.model}`,
    `User: ${clampText(snapshot.userPrompt, 8000)}`,
  ];

  if (snapshot.output) lines.push(`Final assistant output: ${clampText(snapshot.output, 8000)}`);
  lines.push("", "Steps:");

  for (const step of snapshot.steps) {
    if (step.type === "tool") {
      const toolName = step.name.replace(/^tool:/, "");
      lines.push(`- ${step.timestamp} Tool Call ${toolName}`);
      if (step.input !== undefined) lines.push(`  args: ${clampText(step.input, 8000).replace(/\n/g, "\n  ")}`);
      if (step.output !== undefined) lines.push(`  Tool Result ${toolName}: ${clampText(step.output, 40_000).replace(/\n/g, "\n  ")}`);
      if (step.isError !== undefined) lines.push(`  isError: ${step.isError}`);
      continue;
    }

    lines.push(`- ${step.timestamp} Assistant Generation ${step.name}`);
    if (step.input !== undefined) lines.push(`  input: ${clampText(step.input, 4000).replace(/\n/g, "\n  ")}`);
    if (step.output !== undefined) lines.push(`  output: ${clampText(step.output, 8000).replace(/\n/g, "\n  ")}`);
  }

  return lines.join("\n");
}

async function generateTraceMemoryObservation(snapshot: TraceSnapshot) {
  if (!OBSERVER_ENABLED || !OBSERVER_MODEL || !OBSERVER_API_KEY) return undefined;

  const timeline = buildTraceTimeline(snapshot);
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

  let parsed: Record<string, unknown> | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await observerComplete(OBSERVER_SYSTEM_PROMPT, user, 6000, "Observer", 0.1, {
      traceId: snapshot.traceId,
      sessionId: snapshot.sessionId,
      pathKey: snapshot.cwd,
      promptVersion: OBSERVER_PROMPT_VERSION,
    });
    let outputShape: Record<string, unknown> | undefined;
    try {
      if (detectDegenerateRepetition(text)) throw new Error("Observer output contains degenerate repetition");
      const candidate = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
      outputShape = describeMemoryOutput(candidate);
      const validationError = validateMemoryOutput(candidate, "observer");
      if (validationError) throw new Error(`Invalid observer schema: ${validationError}`);
      parsed = candidate;
      break;
    } catch (error) {
      lastError = error;
      logMemoryError({
        stage: "observer-validation",
        attempt,
        maxAttempts: 2,
        error: errorMessage(error),
        responseChars: text.length,
        outputShape,
        traceId: snapshot.traceId,
        sessionId: snapshot.sessionId,
        pathKey: snapshot.cwd,
        promptVersion: OBSERVER_PROMPT_VERSION,
        model: OBSERVER_MODEL,
      });
      if (attempt === 2) throw error;
      console.warn(`📊 Langfuse: Invalid observer output; retrying once; details: ${MEMORY_ERROR_LOG_PATH}`);
    }
  }
  if (!parsed) throw lastError;

  const derivedFiles = deriveFileOperations(snapshot.steps);
  const filesRead = unique([...derivedFiles.filesRead, ...arrayOfStrings(parsed.filesRead)]);
  const filesModified = unique([...derivedFiles.filesModified, ...arrayOfStrings(parsed.filesModified)]);
  const filesCreated = arrayOfStrings(parsed.filesCreated);
  const filesDeleted = arrayOfStrings(parsed.filesDeleted);
  const filesTouched = unique([...filesRead, ...filesModified, ...filesCreated, ...filesDeleted]);
  const toolsUsed = unique([
    ...arrayOfStrings(parsed.toolsUsed),
    ...snapshot.steps.filter(step => step.type === "tool").map(step => step.name.replace(/^tool:/, "")),
  ]);

  return {
    id: deterministicUuid(`${MEMORY_SCORE_NAME}:${MEMORY_SCORE_VERSION}:${snapshot.traceId}`),
    name: MEMORY_SCORE_NAME,
    value: "observed",
    traceId: snapshot.traceId,
    dataType: "CATEGORICAL" as const,
    comment: clampText(parsed.summary || firstLine(String(parsed.observationsMarkdown || "")), 1000),
    metadata: {
      version: MEMORY_SCORE_VERSION,
      promptVersion: OBSERVER_PROMPT_VERSION,
      scope: "trace",
      source: "pi-langfuse-memory",
      observerApi: OBSERVER_API,
      observerModel: OBSERVER_MODEL,
      traceId: snapshot.traceId,
      sessionId: snapshot.sessionId || null,
      traceTimestamp: snapshot.traceTimestamp,
      cwd: snapshot.cwd || null,
      pathKey: snapshot.cwd || null,
      model: snapshot.model || null,
      provider: snapshot.provider || null,
      observationsMarkdown: String(parsed.observationsMarkdown).trim(),
      summary: String(parsed.summary).trim(),
      goal: arrayOfStrings(parsed.goal),
      constraints: arrayOfStrings(parsed.constraints),
      currentTask: String(parsed.currentTask || "").trim(),
      taskStatus: taskStatus(parsed.taskStatus),
      completed: arrayOfStrings(parsed.completed),
      inProgress: arrayOfStrings(parsed.inProgress),
      openIssues: arrayOfStrings(parsed.openIssues),
      decisions: arrayOfStrings(parsed.decisions),
      nextSteps: arrayOfStrings(parsed.nextSteps),
      criticalContext: arrayOfStrings(parsed.criticalContext),
      filesRead,
      filesModified,
      filesCreated,
      filesDeleted,
      filesTouched,
      toolsUsed,
      sourceStepIds: snapshot.steps.map(step => step.id),
      sourceStepCount: snapshot.steps.length,
      generatedAt: new Date().toISOString(),
    },
  };
}

function memoryScopeKey(sessionId: string, pathKey: string): string {
  return `${sessionId}:${pathKey}`;
}

let langfuseRequestQueue = Promise.resolve();

function langfuseRetryAfterMs(response: Response, raw: string, attempt: number): number {
  const header = response.headers.get("retry-after");
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
  return Math.min(2 ** (attempt - 1) * 1000, 10_000);
}

async function langfuseRequest(path: string, init: RequestInit = {}): Promise<{ response: Response; raw: string }> {
  const request = langfuseRequestQueue.catch(() => undefined).then(async () => {
    const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${config.host}${path}`, {
          ...init,
          headers: { Authorization: `Basic ${auth}`, ...init.headers },
        });
      } catch (error) {
        lastError = error;
        if (attempt < 5) {
          await sleep(Math.min(2 ** (attempt - 1) * 1000, 10_000));
          continue;
        }
        break;
      }
      const raw = await response.text();
      if (response.ok) return { response, raw };
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 5) throw new Error(`Langfuse ${init.method || "GET"} ${response.status}: ${raw.slice(0, 500)}`);
      await sleep(langfuseRetryAfterMs(response, raw, attempt));
    }
    throw new Error(`Langfuse ${init.method || "GET"} failed after 5 attempts`, { cause: lastError });
  });
  langfuseRequestQueue = request.then(() => undefined, () => undefined);
  return request;
}

async function langfuseGet(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { raw } = await langfuseRequest(path, { signal });
  return raw ? JSON.parse(raw) : {};
}

async function fetchScoreIdsForSession(sessionId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ sessionId, page: String(page), limit: "100", fields: "core,scores" });
    const response = await langfuseGet(`/api/public/traces?${params}`) as { data?: Array<{ scores?: string[] }>; meta?: { totalPages?: number } };
    for (const trace of response.data || []) ids.push(...(trace.scores || []));
    if (!response.meta?.totalPages || page >= response.meta.totalPages) break;
  }
  return unique(ids);
}

async function fetchScoresByIds(ids: string[], name: string): Promise<MemoryScore[]> {
  const scores: MemoryScore[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const params = new URLSearchParams({ name, dataType: "CATEGORICAL", limit: "100", scoreIds: ids.slice(offset, offset + 50).join(",") });
    const response = await langfuseGet(`/api/public/v2/scores?${params}`) as { data?: MemoryScore[] };
    scores.push(...(response.data || []));
  }
  return scores;
}

async function fetchScoresByName(name: string, signal?: AbortSignal): Promise<MemoryScore[]> {
  const scores: MemoryScore[] = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ name, dataType: "CATEGORICAL", page: String(page), limit: "100" });
    const response = await langfuseGet(`/api/public/v2/scores?${params}`, signal) as { data?: MemoryScore[]; meta?: { totalPages?: number } };
    scores.push(...(response.data || []));
    if (!response.meta?.totalPages || page >= response.meta.totalPages) break;
  }
  return scores;
}

async function getActiveSessionMemory(snapshot: TraceSnapshot, currentObservation: MemoryScore, forceRefresh = false): Promise<ActiveSessionMemory> {
  const scopeKey = memoryScopeKey(snapshot.sessionId, snapshot.cwd);
  sessionMemoryCache.addObservation(scopeKey, currentObservation);

  if (forceRefresh || sessionMemoryCache.needsRefresh(scopeKey)) {
    const scoreIds = await fetchScoreIdsForSession(snapshot.sessionId);
    const [observations, reflections] = await Promise.all([
      fetchScoresByIds(scoreIds, MEMORY_SCORE_NAME),
      fetchScoresByName(REFLECTION_SCORE_NAME),
    ]);
    sessionMemoryCache.mergeRemote(
      scopeKey,
      observations.filter(score => sameMemoryScope(score, snapshot.sessionId, snapshot.cwd, MEMORY_SCORE_VERSION)),
      reflections.filter(score => sameMemoryScope(score, snapshot.sessionId, snapshot.cwd, MEMORY_SCORE_VERSION)),
    );
  }

  const cached = sessionMemoryCache.get(scopeKey);
  return buildActiveMemory(
    cached.observations,
    cached.reflection ? [cached.reflection] : [],
    snapshot.sessionId,
    snapshot.cwd,
    MEMORY_SCORE_VERSION,
  );
}

async function writeSessionReflection(snapshot: TraceSnapshot, memory: ActiveSessionMemory): Promise<void> {
  const previous = memory.latestReflection;
  const previousFields = reflectionFields(previous);
  const newObservationFields = memory.newObservations.map(observationFields);
  const targetTokens = Math.max(2_000, Math.min(8_000, Math.floor(memory.activeTokens * 0.5)));
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
  "toolsUsed": ["tool name"]
}

Target rendered checkpoint size: at most ${targetTokens} estimated tokens.`;
  const compressionGuidance = REFLECTION_COMPRESSION_GUIDANCE;
  let parsed: Record<string, unknown> | undefined;
  let renderedMarkdown = "";
  let qualityMetrics: Record<string, unknown> = {};
  let compressionAttempt = 0;
  let lastError: unknown;
  let correction = "";
  for (let attempt = 1; attempt <= compressionGuidance.length; attempt++) {
    compressionAttempt = attempt;
    let responseChars = 0;
    let outputShape: Record<string, unknown> | undefined;
    try {
      const text = await observerComplete(
        REFLECTION_SYSTEM_PROMPT,
        `${user}\n\nCompression guidance: ${compressionGuidance[attempt - 1] || "Use concise, dense language."}${correction}`,
        6000,
        "Reflector",
        0,
        {
          sessionId: snapshot.sessionId,
          pathKey: snapshot.cwd,
          promptVersion: REFLECTION_PROMPT_VERSION,
          previousReflectionScoreId: previous?.id || null,
          sourceObservationCount: memory.newObservations.length,
        },
      );
      responseChars = text.length;
      if (detectDegenerateRepetition(text)) throw new MemoryOutputValidationError("Reflector output contains degenerate repetition");
      let candidate: Record<string, unknown>;
      try {
        candidate = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
        outputShape = describeMemoryOutput(candidate);
      } catch (error) {
        throw new MemoryOutputValidationError(`Reflector returned invalid JSON: ${error instanceof Error ? error.message : error}`);
      }
      const validationError = validateMemoryOutput(candidate, "reflection");
      if (validationError) throw new MemoryOutputValidationError(`Invalid reflector schema: ${validationError}`);
      const canonical = {
        ...candidate,
        summary: String(candidate.summary).trim(),
        goal: arrayOfStrings(candidate.goal),
        constraints: arrayOfStrings(candidate.constraints),
        currentTask: String(candidate.currentTask || "").trim(),
        taskStatus: taskStatus(candidate.taskStatus),
        completed: arrayOfStrings(candidate.completed),
        inProgress: arrayOfStrings(candidate.inProgress),
        openIssues: arrayOfStrings(candidate.openIssues),
        decisions: arrayOfStrings(candidate.decisions),
        nextSteps: arrayOfStrings(candidate.nextSteps),
        criticalContext: arrayOfStrings(candidate.criticalContext),
        filesRead: unique([...metadataStrings(previous, "filesRead"), ...newObservationFields.flatMap(item => item.filesRead), ...arrayOfStrings(candidate.filesRead)]),
        filesModified: unique([...metadataStrings(previous, "filesModified"), ...newObservationFields.flatMap(item => item.filesModified), ...arrayOfStrings(candidate.filesModified)]),
        filesCreated: unique([...metadataStrings(previous, "filesCreated"), ...newObservationFields.flatMap(item => item.filesCreated), ...arrayOfStrings(candidate.filesCreated)]),
        filesDeleted: unique([...metadataStrings(previous, "filesDeleted"), ...newObservationFields.flatMap(item => item.filesDeleted), ...arrayOfStrings(candidate.filesDeleted)]),
        toolsUsed: unique([...metadataStrings(previous, "toolsUsed"), ...newObservationFields.flatMap(item => item.toolsUsed), ...arrayOfStrings(candidate.toolsUsed)]),
      };
      const quality = evaluateReflectionQuality(canonical, previousFields, newObservationFields);
      if (quality.errors.length) throw new MemoryOutputValidationError(`Reflection quality failed: ${quality.errors.join("; ")}`);
      const markdown = renderReflectionMarkdown(canonical);
      const missingHeading = REQUIRED_REFLECTION_HEADINGS.find(heading => !markdown.includes(heading));
      if (missingHeading) throw new MemoryOutputValidationError(`Rendered reflection missing ${missingHeading}`);
      const outputTokens = estimateTokens(markdown);
      if (outputTokens > targetTokens) throw new MemoryOutputValidationError(`Reflection ${outputTokens} tokens exceeds ${targetTokens}-token target`);
      parsed = canonical;
      renderedMarkdown = markdown;
      qualityMetrics = quality.metrics;
      break;
    } catch (error) {
      if (!(error instanceof MemoryOutputValidationError) && !(error instanceof SyntaxError)) throw error;
      lastError = error;
      logMemoryError({
        stage: "reflection-validation",
        attempt,
        maxAttempts: compressionGuidance.length,
        error: errorMessage(error),
        responseChars,
        outputShape,
        sessionId: snapshot.sessionId,
        pathKey: snapshot.cwd,
        promptVersion: REFLECTION_PROMPT_VERSION,
        model: OBSERVER_MODEL,
        targetTokens,
        activeTokens: memory.activeTokens,
        previousReflectionScoreId: previous?.id || null,
        sourceObservationScoreIds: memory.newObservations.map(score => score.id),
      });
      correction = `\nPrevious output was rejected: ${error instanceof Error ? error.message : error}. Correct that issue in the next output.`;
      if (attempt < compressionGuidance.length) {
        console.warn(`📊 Langfuse: Reflection validation failed; retrying compression (${attempt}/${compressionGuidance.length}); details: ${MEMORY_ERROR_LOG_PATH}`);
      }
    }
  }
  if (!parsed) throw lastError;
  const generation = Number(previous?.metadata?.generation || 0) + 1;
  const sourceObservationScoreIds = memory.newObservations.map(score => score.id);
  const sourceTraceIds = unique(memory.newObservations.map(score => score.traceId || metadataString(score, "traceId")));
  const coveredUntil = generatedAt(memory.newObservations[memory.newObservations.length - 1]!);
  const generated = new Date().toISOString();
  const metadata = {
    version: MEMORY_SCORE_VERSION,
    promptVersion: REFLECTION_PROMPT_VERSION,
    scope: "session",
    source: "pi-langfuse-memory",
    reflectorApi: OBSERVER_API,
    reflectorModel: OBSERVER_MODEL,
    generation,
    sessionId: snapshot.sessionId,
    cwd: snapshot.cwd || null,
    pathKey: snapshot.cwd || null,
    reflectionMarkdown: renderedMarkdown,
    summary: String(parsed.summary).trim(),
    goal: arrayOfStrings(parsed.goal),
    constraints: arrayOfStrings(parsed.constraints),
    currentTask: String(parsed.currentTask || "").trim(),
    taskStatus: taskStatus(parsed.taskStatus),
    completed: arrayOfStrings(parsed.completed),
    inProgress: arrayOfStrings(parsed.inProgress),
    openIssues: arrayOfStrings(parsed.openIssues),
    decisions: arrayOfStrings(parsed.decisions),
    nextSteps: arrayOfStrings(parsed.nextSteps),
    criticalContext: arrayOfStrings(parsed.criticalContext),
    filesRead: unique([...metadataStrings(previous, "filesRead"), ...newObservationFields.flatMap(item => item.filesRead), ...arrayOfStrings(parsed.filesRead)]),
    filesModified: unique([...metadataStrings(previous, "filesModified"), ...newObservationFields.flatMap(item => item.filesModified), ...arrayOfStrings(parsed.filesModified)]),
    filesCreated: unique([...metadataStrings(previous, "filesCreated"), ...newObservationFields.flatMap(item => item.filesCreated), ...arrayOfStrings(parsed.filesCreated)]),
    filesDeleted: unique([...metadataStrings(previous, "filesDeleted"), ...newObservationFields.flatMap(item => item.filesDeleted), ...arrayOfStrings(parsed.filesDeleted)]),
    filesTouched: unique([...metadataStrings(previous, "filesTouched"), ...newObservationFields.flatMap(item => item.filesTouched), ...arrayOfStrings(parsed.filesRead), ...arrayOfStrings(parsed.filesModified), ...arrayOfStrings(parsed.filesCreated), ...arrayOfStrings(parsed.filesDeleted)]),
    toolsUsed: unique([...metadataStrings(previous, "toolsUsed"), ...newObservationFields.flatMap(item => item.toolsUsed), ...arrayOfStrings(parsed.toolsUsed)]),
    inputTokensEstimated: memory.activeTokens,
    outputTokensEstimated: estimateTokens(renderedMarkdown),
    compressionRatio: Number((estimateTokens(renderedMarkdown) / memory.activeTokens).toFixed(3)),
    compressionAttempt,
    qualityMetrics,
    sourceTraceIds,
    sourceObservationScoreIds,
    sourceReflectionScoreIds: previous ? [previous.id] : [],
    sourceObservationCount: sourceObservationScoreIds.length,
    coveredUntil,
    generatedAt: generated,
  };
  const score = {
    id: deterministicUuid(`${REFLECTION_SCORE_NAME}:${MEMORY_SCORE_VERSION}:${snapshot.sessionId}:${snapshot.cwd}:${generation}`),
    name: REFLECTION_SCORE_NAME,
    value: "reflected",
    sessionId: snapshot.sessionId,
    dataType: "CATEGORICAL",
    comment: clampText(parsed.summary || firstLine(renderedMarkdown), 1000),
    metadata,
  };

  await writeMemoryScore(score);
  sessionMemoryCache.setReflection(memoryScopeKey(snapshot.sessionId, snapshot.cwd), score);
}

async function maybeWriteSessionReflection(snapshot: TraceSnapshot, currentObservation: MemoryScore): Promise<void> {
  if (!REFLECTION_ENABLED || !snapshot.sessionId) return;
  const thresholds = {
    activeTokens: REFLECTION_THRESHOLD_TOKENS,
    newObservationTokens: REFLECTION_MIN_NEW_TOKENS,
    newObservations: REFLECTION_MIN_NEW_OBSERVATIONS,
  };
  const scopeKey = memoryScopeKey(snapshot.sessionId, snapshot.cwd);
  const refreshesDuringRead = sessionMemoryCache.needsRefresh(scopeKey);
  let memory = await getActiveSessionMemory(snapshot, currentObservation);
  if (!reflectionThresholdMet(memory, thresholds)) return;

  // Refresh before writing so external batch reflections cannot cause a stale generation.
  if (!refreshesDuringRead) memory = await getActiveSessionMemory(snapshot, currentObservation, true);
  if (!reflectionThresholdMet(memory, thresholds)) return;
  await writeSessionReflection(snapshot, memory);
}

async function writeMemoryScore(score: Record<string, unknown>): Promise<void> {
  await langfuseRequest("/api/public/scores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(score),
  });
  lookupScoresCache = undefined;
}

async function writeTraceMemoryObservation(snapshot: TraceSnapshot): Promise<void> {
  const score = await generateTraceMemoryObservation(snapshot);
  if (!score) return;
  await writeMemoryScore(score);
  sessionMemoryCache.addObservation(memoryScopeKey(snapshot.sessionId, snapshot.cwd), score);
  await maybeWriteSessionReflection(snapshot, score);
}

function enqueueTraceMemoryObservation(snapshot: TraceSnapshot): void {
  const key = `${snapshot.sessionId}:${snapshot.cwd}`;
  const previous = memoryQueues.get(key) || Promise.resolve();
  const task = previous.catch(() => undefined).then(() => writeTraceMemoryObservation(snapshot));
  memoryQueues.set(key, task);
  void task.catch(e => {
    logMemoryError({
      stage: "memory-update",
      error: errorMessage(e),
      stack: e instanceof Error ? e.stack : undefined,
      traceId: snapshot.traceId,
      sessionId: snapshot.sessionId,
      pathKey: snapshot.cwd,
    });
    console.warn(`📊 Langfuse: Failed to update observational memory; details: ${MEMORY_ERROR_LOG_PATH}`, e);
  }).finally(() => {
    if (memoryQueues.get(key) === task) memoryQueues.delete(key);
  });
}

async function getLookupScores(refresh: boolean, signal?: AbortSignal): Promise<MemoryScore[]> {
  if (!refresh && lookupScoresCache && Date.now() - lookupScoresCache.loadedAt < 300_000) return lookupScoresCache.scores;
  const [observations, reflections] = await Promise.all([
    fetchScoresByName(MEMORY_SCORE_NAME, signal),
    fetchScoresByName(REFLECTION_SCORE_NAME, signal),
  ]);
  const scores = [...observations, ...reflections].filter(score => metadataString(score, "version") === MEMORY_SCORE_VERSION);
  lookupScoresCache = { scores, loadedAt: Date.now() };
  return scores;
}

function buildContextMemoryPayload(scores: MemoryScore[], sessionId: string, pathKey: string) {
  const memory = buildActiveMemory(
    scores.filter(score => score.name === MEMORY_SCORE_NAME),
    scores.filter(score => score.name === REFLECTION_SCORE_NAME),
    sessionId,
    pathKey,
    MEMORY_SCORE_VERSION,
  );
  return {
    reflection: memory.latestReflection ? {
      scoreId: memory.latestReflection.id,
      generation: memory.latestReflection.metadata?.generation || null,
      generatedAt: generatedAt(memory.latestReflection),
      coveredUntil: metadataString(memory.latestReflection, "coveredUntil") || null,
      sourceObservationScoreIds: metadataStrings(memory.latestReflection, "sourceObservationScoreIds"),
      sourceTraceIds: metadataStrings(memory.latestReflection, "sourceTraceIds"),
      fields: reflectionFields(memory.latestReflection),
    } : undefined,
    observations: memory.newObservations.map(score => ({
      scoreId: score.id,
      traceId: score.traceId || metadataString(score, "traceId") || null,
      generatedAt: generatedAt(score),
      fields: observationFields(score),
    })),
  };
}

function boundedLookupValue(value: unknown, max: number): string {
  return clampText(redactSecrets(value), max);
}

async function getLookupTrace(traceId: string, refresh: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const cached = lookupTraceCache.get(traceId);
  if (!refresh && cached && Date.now() - cached.loadedAt < 300_000) return cached.value;

  const trace = await langfuseGet(`/api/public/traces/${encodeURIComponent(traceId)}`, signal);
  const observations: Array<Record<string, unknown>> = [];
  let cursor = "";
  do {
    const params = new URLSearchParams({
      traceId,
      limit: "1000",
      fields: "core,basic,time,io,metadata,model,usage",
    });
    if (cursor) params.set("cursor", cursor);
    const response = await langfuseGet(`/api/public/v2/observations?${params}`, signal) as {
      data?: Array<Record<string, unknown>>;
      meta?: { cursor?: string };
    };
    observations.push(...(response.data || []));
    cursor = response.meta?.cursor || "";
  } while (cursor);

  const value = redactSecrets({
    traceId,
    timestamp: trace.timestamp || null,
    name: trace.name || null,
    input: boundedLookupValue(trace.input, 2000),
    output: boundedLookupValue(trace.output, 3000),
    metadata: boundedLookupValue(trace.metadata, 2000),
    sourceObservationCount: observations.filter(observation => !String(observation.name || "").startsWith("memory:")).length,
    observations: observations
      .filter(observation => !String(observation.name || "").startsWith("memory:"))
      .sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")))
      .slice(0, 20)
      .map(observation => ({
        id: observation.id,
        type: observation.type,
        name: observation.name,
        startTime: observation.startTime,
        input: boundedLookupValue(observation.input, 800),
        output: boundedLookupValue(observation.output, 1200),
        metadata: boundedLookupValue(observation.metadata, 800),
      })),
    sourceLimit: "First 20 source observations; values are bounded to protect context.",
  }) as Record<string, unknown>;
  lookupTraceCache.set(traceId, { value, loadedAt: Date.now() });
  return value;
}

// ============================================
// Extension
// ============================================

export default async function (pi: ExtensionAPI) {
  if (!config.publicKey || !config.secretKey) {
    console.log("📊 Langfuse: Set publicKey and secretKey in config.json to enable");
    return;
  }

  console.log("📊 Langfuse: Tracing enabled →", config.host);

  pi.registerCommand("memory-context", {
    description: "Toggle Langfuse memory-based context replacement",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(`Langfuse memory context replacement is ${memoryContextEnabled ? "on" : "off"}.`, "info");
        return;
      }
      if (action && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /memory-context [on|off|status]", "warning");
        return;
      }
      memoryContextEnabled = action === "on" || (action === "" && !memoryContextEnabled);
      pi.appendEntry("langfuse-memory-context-state", { enabled: memoryContextEnabled });
      ctx.ui.notify(
        memoryContextEnabled
          ? "Langfuse memory context replacement enabled. Latest memory plus two recent user turns will be sent to the model."
          : "Langfuse memory context replacement disabled. Full Pi context will be sent to the model.",
        "info",
      );
    },
  });

  pi.registerTool({
    name: "langfuse_memory_lookup",
    label: "Langfuse Memory Lookup",
    description: "Search scoped Langfuse memory observations/reflections with provenance. Defaults to current session and cwd. Optionally returns bounded source-trace details for at most two traces.",
    promptSnippet: "Search prior Langfuse observations/reflections with provenance",
    promptGuidelines: [
      "Use langfuse_memory_lookup when exact older session details, decisions, files, errors, IDs, or covered source traces are needed.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Text, path, symbol, error, URL, or identifier to find." })),
      scope: Type.Optional(Type.String({ description: "session (default), path, or all." })),
      sessionId: Type.Optional(Type.String({ description: "Override session ID used by session scope." })),
      cwd: Type.Optional(Type.String({ description: "Override cwd/pathKey used by session or path scope." })),
      traceId: Type.Optional(Type.String({ description: "Exact source trace ID." })),
      scoreId: Type.Optional(Type.String({ description: "Exact observation/reflection score ID." })),
      includeSource: Type.Optional(Type.Boolean({ description: "Include bounded original trace/tool details for up to two matching source traces." })),
      refresh: Type.Optional(Type.Boolean({ description: "Bypass five-minute lookup cache." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum memory results; default 5." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const scope = ["session", "path", "all"].includes(params.scope || "") ? params.scope : "session";
      const sessionId = String(params.sessionId || currentSessionId || "").replace(/^\/?sessions\//, "").replace(/\.jsonl$/, "");
      const pathKey = String(params.cwd || ctx.cwd || "");
      const scores = await getLookupScores(Boolean(params.refresh), signal);
      const matches = searchMemoryScores(scores, {
        query: params.query,
        scope,
        sessionId,
        pathKey,
        traceId: params.traceId,
        scoreId: params.scoreId,
        limit: params.limit,
      });
      const results = matches.map(({ score, rank }) => ({ rank, ...formatMemoryResult(score) }));
      const sourceTraceIds = unique(matches.flatMap(({ score }) => [
        score.traceId || metadataString(score, "traceId"),
        ...metadataStrings(score, "sourceTraceIds"),
      ])).slice(0, 2);
      const sourceTraces = params.includeSource
        ? await Promise.all(sourceTraceIds.map(traceId => getLookupTrace(traceId, Boolean(params.refresh), signal)))
        : [];
      const payload = redactSecrets({
        scope: { mode: scope, sessionId: scope === "session" ? sessionId || null : null, pathKey: scope === "all" ? null : pathKey || null },
        query: params.query || null,
        resultCount: results.length,
        results,
        sourceTraces,
        sourceDetailsLimited: Boolean(params.includeSource),
      }) as Record<string, unknown>;
      const text = clampText(payload, 48_000);
      return {
        content: [{ type: "text", text }],
        details: payload,
      };
    },
  });

  // Capture session ID on session start
  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = "";
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      // Extract session ID from file path (format: 2026-04-25T13-23-54-756Z_<uuid>.jsonl)
      const filename = sessionFile.split('/').pop() || '';
      currentSessionId = filename.replace('.jsonl', '');
    }
    // Reset state for new session
    resetSessionState();
    memoryContextEnabled = false;
    lastMemoryContextErrorAt = 0;
    for (const entry of ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: { enabled?: boolean } }>) {
      if (entry.type === "custom" && entry.customType === "langfuse-memory-context-state") {
        memoryContextEnabled = entry.data?.enabled === true;
      }
    }
  });

  pi.on("context", async (event, ctx) => {
    if (!memoryContextEnabled || !currentSessionId) return;
    try {
      const scores = await getLookupScores(false, ctx.signal);
      const memoryText = buildMemoryContextText(buildContextMemoryPayload(scores, currentSessionId, ctx.cwd));
      if (!memoryText) return;
      return { messages: replaceWithMemoryContext(event.messages, memoryText, 2) };
    } catch (error) {
      if (Date.now() - lastMemoryContextErrorAt > 60_000) {
        logMemoryError({
          stage: "context-replacement",
          error: errorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
          sessionId: currentSessionId,
          pathKey: ctx.cwd,
        });
        console.warn(`📊 Langfuse: Memory context replacement skipped; details: ${MEMORY_ERROR_LOG_PATH}`, error);
        lastMemoryContextErrorAt = Date.now();
      }
      return;
    }
  });

  // Capture model info on model select
  pi.on("model_select", async (event, ctx) => {
    currentModel = event.model?.id || '';
    currentProvider = event.model?.provider || '';
  });

  // Use before_agent_start to capture user prompt and create trace
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const lf = await getClient();
      const cwd = event.systemPromptOptions?.cwd || process.cwd();
      currentUserPrompt = event.prompt;
      currentTraceTimestamp = new Date().toISOString();
      currentCwd = cwd;
      traceSteps.length = 0;
      
      // Fallback to ctx.model if not captured via model_select
      if (!currentModel && ctx.model) {
        currentModel = ctx.model.id || '';
        currentProvider = ctx.model.provider || '';
      }
      
      // Create trace with user input and session ID
      currentTrace = lf.trace({ 
        name: "pi-agent", 
        input: event.prompt,
        metadata: { 
          cwd,
          model: currentModel,
          provider: currentProvider
        },
        sessionId: currentSessionId || undefined
      });
    } catch (e) {
      console.warn("📊 Langfuse: Failed to create trace", e);
    }
  });

  pi.on("agent_end", async (event) => {
    if (currentTrace) {
      // Get final response/output
      const eventData = event as unknown as {
        messages?: ObservedAgentMessage[];
      };
      const messages = eventData.messages || [];
      const lastAssistant = messages.filter(m => m.role === "assistant").pop();
      
      // Extract text from content array (filter out thinking blocks)
      let output: string | undefined = undefined;
      if (lastAssistant?.content) {
        output = lastAssistant.content
          .filter(c => c.type === "text" && c.text)
          .map(c => c.text)
          .join("\n");
        if (output.length === 0) output = undefined;
      }
      
      // Compute evaluation scores
      const scores = computeEvaluationScores();
      
      currentTrace.update?.({ 
        output: output || undefined,
        metadata: { 
          completed: true, 
          totalTools: toolCallCount,
          model: currentModel,
          provider: currentProvider,
          ...scores
        }
      });
      
      // Send evaluation scores to Langfuse
      try {
        const lf = await getClient();
        
        // Trace-level evaluation scores
        lf.score({ name: "tool_call_count", value: scores.tool_call_count, traceId: currentTrace.id });
        lf.score({ name: "turn_count", value: scores.turn_count, traceId: currentTrace.id });
        lf.score({ name: "total_tool_errors", value: scores.total_tool_errors, traceId: currentTrace.id });
        lf.score({ name: "tool_success_rate", value: scores.tool_success_rate, traceId: currentTrace.id });
        lf.score({ name: "session_had_errors", value: scores.session_had_errors, traceId: currentTrace.id });
      } catch (e) {
        console.warn("📊 Langfuse: Failed to send evaluation scores", e);
      }

      const memorySnapshot: TraceSnapshot = {
        traceId: currentTrace.id,
        traceTimestamp: currentTraceTimestamp,
        sessionId: currentSessionId,
        cwd: currentCwd,
        model: currentModel,
        provider: currentProvider,
        userPrompt: currentUserPrompt,
        output,
        steps: buildObservationSteps(messages, traceSteps),
      };
      enqueueTraceMemoryObservation(memorySnapshot);
      
      currentTrace = null;
    }
    
    // Reset for next session
    resetSessionState();
    
    if (client) {
      await client.shutdownAsync();
      client = null;
    }
  });

  // Track tool calls and create spans
  pi.on("tool_call", async (event) => {
    if (!currentTrace) return;

    try {
      const lf = await getClient();
      
      // Increment tool call counter
      toolCallCount++;
      
      // Format input nicely
      let inputStr = "";
      if (event.input) {
        inputStr = JSON.stringify(event.input, null, 2);
        if (inputStr.length > 1000) {
          inputStr = inputStr.slice(0, 1000) + "...";
        }
      }
      
      const span = lf.span({
        name: `tool:${event.toolName}`,
        traceId: currentTrace.id,
        input: inputStr,
        metadata: { tool: event.toolName }
      });
      
      activeSpans.set(event.toolCallId, { span, toolName: event.toolName });
      traceSteps.push({
        id: event.toolCallId,
        type: "tool",
        name: `tool:${event.toolName}`,
        timestamp: new Date().toISOString(),
        input: event.input,
        metadata: { tool: event.toolName },
      });
    } catch (e) {
      console.warn("📊 Langfuse: Failed to create span", e);
    }
  });

  // Track tool results and errors
  pi.on("tool_result", async (event) => {
    const spanData = activeSpans.get(event.toolCallId);
    if (spanData) {
      const { span, toolName } = spanData;
      
      // Format output nicely
      let outputStr = "";
      if (event.content && event.content.length > 0) {
        // Extract text from content array
        for (const item of event.content) {
          if (item.type === "text" && item.text) {
            outputStr += item.text;
          }
        }
        if (outputStr.length > 2000) {
          outputStr = outputStr.slice(0, 2000) + "...";
        }
      }
      
      span.end({ 
        isError: event.isError,
        output: outputStr || undefined
      });

      const step = traceSteps.find(step => step.id === event.toolCallId);
      if (step) {
        step.output = outputStr || undefined;
        step.isError = event.isError;
      }
      
      // Track errors and send per-tool score
      if (event.isError) {
        errorCount++;
        try {
          const lf = await getClient();
          // Per-tool error score (observation level)
          lf.score({ 
            name: "tool_is_error", 
            value: 1, 
            traceId: currentTrace?.id 
          });
        } catch (e) {
          console.warn("📊 Langfuse: Failed to send tool error score", e);
        }
      }
      
      activeSpans.delete(event.toolCallId);
    }
  });

  // Track turns and generations
  pi.on("turn_end", async (event) => {
    if (!currentTrace) return;

    // Increment turn counter
    turnCount++;

    const eventData = event as unknown as {
      message?: {
        role: string;
        content: Array<{ type: string; text?: string }>;
        model?: string;
        cost?: { input: number; output: number; total: number };
        usage?: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          totalTokens: number;
          cost?: { input: number; output: number; total: number };
        };
      };
      toolResults?: Array<{ toolName: string; toolCallId: string }>;
    };

    const message = eventData.message;
    if (!message || message.role !== "assistant") return;

    const usage = message.usage;
    const modelId = message.model || currentModel;
    const provider = currentProvider;
    const cost = usage?.cost;

    if (usage) {
      try {
        const lf = await getClient();
        
        // Extract output text
        let outputText = "";
        if (message.content) {
          outputText = message.content
            .filter(c => c.type === "text" && c.text)
            .map(c => c.text)
            .join("\n");
        }
        
        // Create generation for the LLM response with model info
        // Note: usage and costDetails go in the generation observation, NOT as scores
        const gen = lf.generation({
          name: "llm-response",
          traceId: currentTrace.id,
          input: currentUserPrompt.slice(0, 500),
          output: outputText.slice(0, 1000),
          model: modelId,
          metadata: {
            provider: provider,
            inputTokens: usage.input || 0,
            outputTokens: usage.output || 0,
            cachedTokens: usage.cacheRead || 0,
          },
          usage: {
            input: usage.input || 0,
            output: usage.output || 0,
            total: usage.totalTokens || (usage.input || 0) + (usage.output || 0)
          },
          costDetails: cost ? { total: cost.total, input: cost.input, output: cost.output } : undefined
        });
        gen.end({ 
          costDetails: cost ? { total: cost.total, input: cost.input, output: cost.output } : undefined,
          usage: {
            input: usage.input || 0,
            output: usage.output || 0,
            total: usage.totalTokens || (usage.input || 0) + (usage.output || 0)
          }
        });
        traceSteps.push({
          id: gen.id,
          type: "generation",
          name: "llm-response",
          timestamp: new Date().toISOString(),
          input: currentUserPrompt.slice(0, 500),
          output: outputText.slice(0, 1000) || undefined,
          metadata: {
            provider,
            model: modelId,
            inputTokens: usage.input || 0,
            outputTokens: usage.output || 0,
            cachedTokens: usage.cacheRead || 0,
          },
        });
      } catch (e) {
        console.warn("📊 Langfuse: Failed to create generation", e);
      }
      
      // NOTE: We no longer send token counts or cost as scores
      // Those belong in usage/costDetails on the generation observation
      // Scores are for EVALUATION metrics (success rates, error counts, etc.)
    }
  });

  pi.on("session_shutdown", async () => {
    if (currentTrace) {
      if (currentTrace.update) {
        currentTrace.update({ metadata: { completed: true } });
      }
      currentTrace = null;
    }
    if (client) {
      await client.shutdownAsync();
      client = null;
    }
    resetSessionState();
  });
}
