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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

interface Config {
  publicKey: string;
  secretKey: string;
  host: string;
  observer?: ObserverConfig;
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
  sessionId: string;
  cwd: string;
  model: string;
  provider: string;
  userPrompt: string;
  output?: string;
  steps: TraceStep[];
}

let currentTrace: TraceData | null = null;
let currentUserPrompt: string = "";
let currentSessionId: string = "";
let currentModel: string = "";
let currentProvider: string = "";
let currentCwd: string = "";
const activeSpans: Map<string, SpanData> = new Map();
const traceSteps: TraceStep[] = [];

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
const MEMORY_SCORE_VERSION = "v1";
type ObserverApi = "anthropic" | "openai";
const configuredObserverApi = process.env.PI_LANGFUSE_OBSERVER_API || config.observer?.api || (process.env.OPENAI_API_KEY ? "openai" : "anthropic");
const OBSERVER_API = (configuredObserverApi.toLowerCase() === "openai" ? "openai" : "anthropic") as ObserverApi;
const OBSERVER_ENABLED = process.env.PI_LANGFUSE_OBSERVER_ENABLED === "false" ? false : config.observer?.enabled !== false;
const OBSERVER_MODEL = process.env.PI_LANGFUSE_OBSERVER_MODEL || config.observer?.model || "";
const OBSERVER_BASE_URL = process.env.PI_LANGFUSE_OBSERVER_BASE_URL || config.observer?.baseUrl || (OBSERVER_API === "openai" ? "https://api.openai.com" : "https://api.anthropic.com");
const OBSERVER_API_KEY = process.env.PI_LANGFUSE_OBSERVER_API_KEY || config.observer?.apiKey || (OBSERVER_API === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) || "";

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

async function observerComplete(prompt: string): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${OBSERVER_API_KEY}`,
    "Content-Type": "application/json",
  };
  const body = OBSERVER_API === "openai"
    ? {
        model: OBSERVER_MODEL,
        temperature: 0.1,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }
    : {
        model: OBSERVER_MODEL,
        max_tokens: 4000,
        temperature: 0.1,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      };

  if (OBSERVER_API === "anthropic") headers["anthropic-version"] = "2023-06-01";

  const response = await fetch(observerEndpoint(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`Observer model ${response.status}: ${raw.slice(0, 500)}`);

  const data = JSON.parse(raw);
  const text = OBSERVER_API === "openai"
    ? data.choices?.[0]?.message?.content
    : (data.content || [])
        .filter((part: { type?: string; text?: string }) => part.type === "text" && part.text)
        .map((part: { text: string }) => part.text)
        .join("\n");

  if (!text?.trim()) throw new Error("Observer model returned no text");
  return text.trim();
}

function buildTraceTimeline(snapshot: TraceSnapshot) {
  const lines = [
    `Trace ${snapshot.traceId}`,
    `Session: ${snapshot.sessionId}`,
    `CWD: ${snapshot.cwd}`,
    `Model: ${snapshot.provider}/${snapshot.model}`,
    `User: ${clampText(snapshot.userPrompt, 2000)}`,
  ];

  if (snapshot.output) lines.push(`Final assistant output: ${clampText(snapshot.output, 2000)}`);
  lines.push("", "Steps:");

  for (const step of snapshot.steps) {
    lines.push(`- ${step.timestamp} ${step.type} ${step.name}`);
    if (step.input !== undefined) lines.push(`  input: ${clampText(step.input, 1200).replace(/\n/g, "\n  ")}`);
    if (step.output !== undefined) lines.push(`  output: ${clampText(step.output, 1600).replace(/\n/g, "\n  ")}`);
    if (step.isError !== undefined) lines.push(`  isError: ${step.isError}`);
  }

  return lines.join("\n");
}

async function generateTraceMemoryObservation(snapshot: TraceSnapshot) {
  if (!OBSERVER_ENABLED || !OBSERVER_MODEL || !OBSERVER_API_KEY) return undefined;

  const timeline = buildTraceTimeline(snapshot);
  const prompt = `You are the memory consciousness of an AI coding assistant. Your observations may become the ONLY information the assistant has about this trace later.

Extract dense trace-level observations from this coding-agent trace. Preserve what matters for continuing work after raw tool calls are removed.

Priority markers for observationsMarkdown:
- 🔴 High: explicit user request, unresolved goal, critical context, important decision
- 🟡 Medium: project details, tool results, files inspected/changed, learned information
- 🟢 Low: minor detail or uncertainty
- ✅ Completed: concrete task/question/subtask resolved

Guidelines:
- Be specific enough for a future coding agent to act on.
- Add 1-8 observations for the trace.
- Use terse dense language.
- Do not list every tool call; group repeated reads/searches/commands by purpose and outcome.
- Preserve file paths, errors, commands, tests, and line numbers when useful.
- Do not include suggestedResponse.

Return ONLY valid JSON:
{
  "observationsMarkdown": "Date: Jul 17, 2026\\n* 🔴 ...",
  "currentTask": "short current task/status after this trace",
  "summary": "one short paragraph",
  "filesTouched": ["path/or/file.ts"],
  "toolsUsed": ["bash", "read", "edit"],
  "decisions": ["decision/rationale"],
  "completed": ["completed outcome"],
  "openIssues": ["remaining issue/blocker"]
}

## Trace timeline

${timeline}`;

  const text = await observerComplete(prompt);

  const parsed = JSON.parse(extractJsonObject(text));
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
      scope: "trace",
      source: "pi-langfuse-memory",
      observerApi: OBSERVER_API,
      observerModel: OBSERVER_MODEL,
      traceId: snapshot.traceId,
      sessionId: snapshot.sessionId || null,
      cwd: snapshot.cwd || null,
      pathKey: snapshot.cwd || null,
      model: snapshot.model || null,
      provider: snapshot.provider || null,
      observationsMarkdown: String(parsed.observationsMarkdown || "").trim(),
      currentTask: String(parsed.currentTask || "").trim(),
      summary: String(parsed.summary || "").trim(),
      filesTouched: arrayOfStrings(parsed.filesTouched),
      toolsUsed,
      decisions: arrayOfStrings(parsed.decisions),
      completed: arrayOfStrings(parsed.completed),
      openIssues: arrayOfStrings(parsed.openIssues),
      sourceStepIds: snapshot.steps.map(step => step.id),
      sourceStepCount: snapshot.steps.length,
      generatedAt: new Date().toISOString(),
    },
  };
}

async function writeTraceMemoryObservation(snapshot: TraceSnapshot) {
  const score = await generateTraceMemoryObservation(snapshot);
  if (!score) return;

  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
  const response = await fetch(`${config.host}/api/public/scores`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(score),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Langfuse memory score ${response.status}: ${text.slice(0, 500)}`);
  }
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

  // Capture session ID on session start
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      // Extract session ID from file path (format: 2026-04-25T13-23-54-756Z_<uuid>.jsonl)
      const filename = sessionFile.split('/').pop() || '';
      currentSessionId = filename.replace('.jsonl', '');
    }
    // Reset state for new session
    resetSessionState();
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
        messages?: Array<{
          role: string;
          content: Array<{ type: string; text?: string; thinking?: string }>;
        }>;
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
        sessionId: currentSessionId,
        cwd: currentCwd,
        model: currentModel,
        provider: currentProvider,
        userPrompt: currentUserPrompt,
        output,
        steps: traceSteps.map(step => ({ ...step })),
      };
      void writeTraceMemoryObservation(memorySnapshot).catch(e => {
        console.warn("📊 Langfuse: Failed to generate trace memory observation", e);
      });
      
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
