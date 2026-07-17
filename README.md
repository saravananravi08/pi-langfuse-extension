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
```

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
```

## What Gets Tracked

### Trace Level
- `input` - User prompt
- `output` - Assistant response
- `sessionId` - Pi session identifier
- `metadata` - Model, provider, cwd

### Generation Observations (LLM Calls)
- `model` - Model identifier (e.g., "MiniMax-M2.7")
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
- `metadata.currentTask` - Current task/status after the trace
- `metadata.filesTouched` - Important files/paths
- `metadata.toolsUsed` - Tool names used in the trace
- `metadata.decisions` - Key decisions/rationale
- `metadata.completed` - Finished outcomes
- `metadata.openIssues` - Remaining issues/blockers

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
node scripts/observe-langfuse-session.mjs <session-id> --dry-run --limit 1
node scripts/observe-langfuse-session.mjs <session-id> --force
```

The script reads the same `config.json`. Short env aliases are also supported for one-off runs:

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

## Dependencies

- [langfuse](https://www.npmjs.com/package/langfuse) - Langfuse SDK
- [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) - Pi extension API

## License

MIT