# @ravan08/pi-langfuse

[![npm version](https://img.shields.io/npm/v/@ravan08/pi-langfuse.svg)](https://www.npmjs.com/package/@ravan08/pi-langfuse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Langfuse observability extension for [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent). Sends traces to [Langfuse](https://langfuse.com) for monitoring tokens, costs, latency, and tool calls.

![Langfuse Trace Screenshot](./docs/screenshot1.jpg)

## Why Langfuse?

Langfuse provides open-source observability for LLM applications. This extension allows you to **trace**, **monitor**, and **debug** your Pi sessions with production-grade detail, helping you understand exactly how your agent is performing, what it's costing you, and where it might be failing.

## Features

- **Hierarchical Tracing**: Maps user prompts to per-turn spans and nested tool executions for deep visibility.
- **LLM Metadata**: Automatically records model name, provider, token usage, and API costs per turn.
- **Tool Observability**: Detailed logs for every tool call, including arguments, results, and error states.
- **Session Correlation**: Groups all prompts from the same Pi session into a single Langfuse session.
- **Cost Tracking**: Records input/output/total costs in USD per generation.
- **Token Usage**: Tracks input and output tokens per turn.
- **Trace Memory Scores**: Optionally generates compact Mastra-style trace observations and writes them back as Langfuse score metadata.
- **Session Reflections**: Asynchronously consolidates large observation logs into append-only session scores while retaining exact source score/trace IDs.
- **Resilient Memory Calls**: Retries connection failures, rate limits, and server errors; validates malformed/repetitive observer and reflector output.

## Quick Install

### Via npm (recommended)
```bash
pi install npm:@ravan08/pi-langfuse
```

### Via git
```bash
pi install git:github.com/saravananravi08/pi-langfuse-extension
```

## Configuration

Get your keys from [Langfuse Cloud](https://cloud.langfuse.com) → Settings → API Keys.

Create `config.json` in the extension directory:

```json
{
  "publicKey": "YOUR_LANGFUSE_PUBLIC_KEY",
  "secretKey": "YOUR_LANGFUSE_SECRET_KEY",
  "host": "https://cloud.langfuse.com",
  "observer": {
    "enabled": true,
    "api": "anthropic",
    "baseUrl": "https://api.example.com/anthropic",
    "apiKey": "observer-api-key",
    "model": "observer-model-id"
  },
  "memory": {
    "reflection": {
      "enabled": false,
      "thresholdTokens": 20000,
      "minNewObservationTokens": 8000,
      "minNewObservations": 5
    }
  }
}
```

`observer` is optional. When enabled, the extension creates a `memory_trace_observation` score for each completed trace. Set `"enabled": false` or omit `observer.model`/`observer.apiKey` to disable trace memory scoring. The observer endpoint can be Anthropic-compatible or OpenAI-compatible:

```json
{
  "observer": {
    "api": "openai",
    "baseUrl": "https://api.openai.com",
    "apiKey": "YOUR_OBSERVER_API_KEY",
    "model": "gpt-4.1-mini"
  }
}
```

Environment variables override config values:

```bash
PI_LANGFUSE_OBSERVER_ENABLED=false
PI_LANGFUSE_OBSERVER_API=anthropic
PI_LANGFUSE_OBSERVER_BASE_URL=https://api.example.com/anthropic
PI_LANGFUSE_OBSERVER_API_KEY=...
PI_LANGFUSE_OBSERVER_MODEL=...
PI_LANGFUSE_REFLECTION_ENABLED=true
PI_LANGFUSE_REFLECTION_THRESHOLD_TOKENS=20000
PI_LANGFUSE_REFLECTION_MIN_NEW_TOKENS=8000
PI_LANGFUSE_REFLECTION_MIN_NEW_OBSERVATIONS=5
```

Reflection reuses the observer API/model. It triggers only when all structured active-memory fields reach 20,000 estimated tokens, with at least 8,000 structured observation tokens and five observations added since the latest reflection. Each `memory_session_reflection` is append-only. `coveredUntil` identifies observations already incorporated; newer observations remain available for append/retrieval. Live remote memory is cached per session/path for five minutes, updated immediately after writes, and refreshed before reflection creation.

Observer and reflector system prompts are centralized in [`memory-prompts.js`](./memory-prompts.js). Live and batch paths use the same prompt versions. Outputs must satisfy the complete structured schema before they are stored; malformed or incomplete outputs are retried. Reflection structured fields are canonical, and `reflectionMarkdown` is rendered deterministically after retention, duplication, and contradiction checks.

Observer, reflection, memory-update, and context-replacement failures are appended as redacted JSONL diagnostics to `~/.pi/agent/logs/langfuse-memory-errors.jsonl` with `0600` permissions. Records include the safe validation reason, attempt, scope/provenance, and output field types/lengths—but never raw model output. Override the path with `PI_LANGFUSE_MEMORY_ERROR_LOG`.

The `langfuse_memory_lookup` tool searches observations and reflections. It defaults to the current session and cwd, supports exact trace/score IDs and broader path/all scopes, caches score reads for five minutes, returns score/trace provenance, redacts secret-like values, and can include bounded source details for up to two traces.

Model-visible history replacement is disabled by default. Use `/memory-context on` to replace older model context with the latest scoped reflection, uncovered observations, and the two most recent complete user turns. Use `/memory-context off` to restore full Pi context or `/memory-context status` to inspect the session setting. The setting persists in the Pi session; stored history is never deleted.

For npm install, find the extension at:
```
~/.pi/agent/npm/@ravan08/pi-langfuse/index.ts
```

## Usage

### Run pi with tracing enabled

```bash
pi "your prompt"
```

Pi auto-loads the extension. All sessions will be traced to Langfuse.

## Trace Model

```
Trace (name: "pi-agent")
├── Session ID: <pi-session-id>
├── Metadata: model, provider, cwd
└── Span (name: "tool:<name>")
    └── Input/Output logs

Generation (name: "llm-response")
├── Model: active pi model
├── Usage: input/output tokens
└── Cost: input/output/total USD

Score (name: "memory_trace_observation")
├── Value: observed
├── Comment: short memory summary
└── Metadata: observations, files, tools, decisions, completed work, open issues

Session score (name: "memory_session_reflection")
├── Value: reflected
├── Session ID: <pi-session-id>
└── Metadata: generation, coveredUntil, merged memory, source score/trace IDs
```

## What Gets Tracked

### Trace Level
- `input` - User prompt
- `output` - Assistant response
- `sessionId` - Pi session identifier
- `metadata` - Model, provider, cwd

### Generation Observations (LLM Calls)
- `model` - Active model identifier
- `usage` - Token counts (input/output/total)
- `costDetails` - Cost breakdown in USD

### Span Observations (Tool Calls)
- `name` - Tool name (e.g., "tool:bash")
- `input` - Tool parameters (JSON)
- `output` - Tool result
- `metadata.isError` - Whether tool failed

### Memory Trace Score
- `name` - `memory_trace_observation`
- `value` - `observed`
- `comment` - Short summary
- `metadata.observationsMarkdown` - Dense observation bullets using 🔴/🟡/🟢/✅ markers
- `metadata.currentTask` / `taskStatus` - Current task and active/waiting/blocked/complete state
- `metadata.goal` / `constraints` - User goals, requirements, and preferences
- `metadata.completed` / `inProgress` / `openIssues` - Verified progress state
- `metadata.decisions` / `nextSteps` / `criticalContext` - Continuation checkpoint
- `metadata.filesRead` / `filesModified` / `filesCreated` / `filesDeleted` - Classified file operations
- `metadata.filesTouched` - Backward-compatible union of file paths
- `metadata.toolsUsed` - Tool names used in the trace

### Session Reflection Score
- `name` - `memory_session_reflection`
- `sessionId` - Pi session identifier; no source trace required
- `metadata.generation` - Monotonic reflection generation
- `metadata.coveredUntil` - Latest observation timestamp incorporated
- `metadata.reflectionMarkdown` - Consolidated active session memory
- `metadata.sourceObservationScoreIds` - Newly incorporated observation scores
- `metadata.sourceReflectionScoreIds` - Previous reflection in the append-only chain
- `metadata.sourceTraceIds` - Source traces for future recall
- `metadata.inputTokensEstimated` / `outputTokensEstimated` / `compressionRatio` - Reflection compression metrics
- `metadata.compressionAttempt` / `promptVersion` - Validation and prompt version details

## Langfuse Dashboard

After running, check your Langfuse project for:

1. **Traces** - All pi agent runs with I/O
2. **Sessions** - Traces grouped by session ID
3. **Observations** - Tool calls and LLM generations
4. **Scores** - Evaluation metrics and trace memory observations
5. **Model Usage** - Usage breakdown by model

## Backfill Existing Sessions

Use the included script to generate memory scores for older traces:

```bash
node scripts/observe-langfuse-session.mjs 2026-07-17T05-14-22-976Z_019f6e7f-477f-711f-abfc-69e15e5624f7
```

Useful flags:

```bash
node scripts/observe-langfuse-session.mjs <session-id> --audit
node scripts/observe-langfuse-session.mjs <session-id> --audit --backfill --dry-run
node scripts/observe-langfuse-session.mjs <session-id> --audit --backfill
node scripts/observe-langfuse-session.mjs <session-id> --audit --backfill --include-pre-coverage
node scripts/observe-langfuse-session.mjs <session-id> --dry-run --limit 1
node scripts/observe-langfuse-session.mjs <session-id> --force
```

`--audit` is read-only. It reports observed traces, gaps after observation coverage began, historical pre-coverage traces, incomplete/skipped traces, duplicates, deterministic-ID mismatches, prompt versions, and path totals. `--backfill` writes only eligible gaps; add `--include-pre-coverage` to include older historical traces.

Create or inspect the next session reflection:

```bash
node scripts/reflect-langfuse-session.mjs <session-id>
node scripts/reflect-langfuse-session.mjs <session-id> --dry-run
node scripts/reflect-langfuse-session.mjs <session-id> --force --dry-run
node scripts/reflect-langfuse-session.mjs <session-id> --path /project/cwd --limit 10
```

Without `--force`, the script uses the configured token/count thresholds. `--dry-run` calls the reflector only when thresholds pass (or when combined with `--force`) and does not write the score.

The scripts read the same `config.json`. Short env aliases are also supported for one-off runs:

```bash
OBSERVER_API=openai OBSERVER_BASE_URL=https://api.openai.com OBSERVER_API_KEY=... OBSERVER_MODEL=... \
  node scripts/observe-langfuse-session.mjs <session-id>
```

## Architecture

For a deep dive into the tracing model and data flow, see [docs/architecture.md](./docs/architecture.md).

## Troubleshooting

**No traces appearing?**
- Verify API keys are correct in `config.json`
- Check Langfuse project is active
- Ensure API keys have write permissions

**Extension not loading?**
- Run `pi list` to check installed packages
- Try restarting pi

**Model/cost not showing?**
- Not all providers expose cost info
- Check Langfuse traces API for raw observation data

**No memory_trace_observation score?**
- Add `observer` config or set `PI_LANGFUSE_OBSERVER_*` environment variables
- Reload pi after changing config
- Check logs for observer API errors

**No memory_session_reflection score?**
- Set `memory.reflection.enabled=true`
- Check whether all three reflection thresholds are met
- Run `scripts/reflect-langfuse-session.mjs <session-id>` for a status report

## Dependencies

- [langfuse](https://www.npmjs.com/package/langfuse) - Langfuse SDK
- [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) - Pi extension API

## License

MIT