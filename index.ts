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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ============================================
// Configuration
// ============================================

interface Config {
  publicKey: string;
  secretKey: string;
  host: string;
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
  end(body?: { metadata?: Record<string, unknown>; usage?: unknown; output?: unknown }): void;
}

interface LangfuseClient {
  trace(body?: { name: string; metadata?: Record<string, unknown>; input?: unknown; output?: unknown; sessionId?: string }): {
    id: string;
    update(body?: { metadata?: Record<string, unknown>; output?: unknown; input?: unknown }): void;
  };
  span(body: { name: string; traceId: string; metadata?: Record<string, unknown>; input?: unknown }): LangfuseSpan;
  generation(body: { name: string; traceId: string; metadata?: Record<string, unknown>; input?: unknown; output?: unknown; usage?: unknown }): LangfuseGeneration;
  score(body: { name: string; value: number; traceId?: string; observationId?: string }): void;
  shutdownAsync(): Promise<void>;
}

let client: LangfuseClient | null = null;

async function getClient(): Promise<LangfuseClient> {
  if (!client) {
    const extDir = resolve(dirname(fileURLToPath(import.meta.url)));
    const lib = await import(`${extDir}/node_modules/langfuse/lib/index.mjs`) as {
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

let currentTrace: TraceData | null = null;
let currentUserPrompt: string = "";
let currentSessionId: string = "";
let currentModel: string = "";
let currentProvider: string = "";
const activeSpans: Map<string, SpanData> = new Map();

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
      
      currentTrace.update({ 
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
        
        console.log("📊 Langfuse: Evaluation scores sent:", scores);
      } catch (e) {
        console.warn("📊 Langfuse: Failed to send evaluation scores", e);
      }
      
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
