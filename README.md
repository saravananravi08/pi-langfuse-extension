# Pi Langfuse Observability + Memory

[![npm version](https://img.shields.io/npm/v/@ravan08/pi-langfuse.svg)](https://www.npmjs.com/package/@ravan08/pi-langfuse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Langfuse integration for [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) combining production-grade tracing with optional observational memory. It records Pi turns, model usage, cost, and tool calls; generates structured trace observations; consolidates long sessions into reflections; and can safely replace covered model-visible history with compact memory.

**Stored Pi session history is never deleted or rewritten.** Memory context replacement is opt-in and blocks rather than guessing when exact Pi-entry provenance cannot be verified.

![Langfuse trace view](./docs/screenshot1.jpg)

## 🔭 What It Does

### 📊 Observability

- Maps each Pi turn to a Langfuse trace.
- Records model, provider, latency, token usage, and cost.
- Captures nested tool calls, arguments, results, and errors.
- Groups traces by Pi session and working directory.

### 🧠 Observational Memory

- Creates asynchronous episodic `memory_trace_observation` scores with exact user requests, question/answer pairs, corrections, durable items, and Pi provenance.
- Consolidates active observations into append-only canonical `memory_session_reflection` scores.
- Keeps exact recent user requests as deterministic working memory.
- Reduces durable state by authority: user corrections > user state > verified results > assistant proposals.
- Retrieves prompt-relevant episodes automatically instead of injecting every observation.
- Creates safe in-turn checkpoints after 20 completed tool calls, 8k new textual tokens, or 70% context usage.
- Exposes scoped recall through the `langfuse_memory_lookup` tool.
- Optionally replaces structurally and semantically covered model-visible history through `/memory-context on`.
- Records exact Pi session entries and complete tool-call/result pairs as provenance.
- Provides read-only audits, controlled backfill, redacted diagnostics, and bounded source retrieval.

## 🧠 Memory Flow

```text
Pi agent turn
   │
   ├─ Langfuse trace
   │    ├─ LLM generation
   │    └─ tool spans
   │
   └─ memory_trace_observation score
              │
              ├─ latest uncovered observations
              └─ threshold reached
                        │
                        ▼
             memory_session_reflection score
                        │
                        ▼
              active memory + scoped lookup
                        │
                        ▼
       optional provenance-safe model context
```

Observations and reflections are Langfuse scores, not additions to raw trace events. Reflections are append-only; the current reflection is selected by highest `generation`, then `generatedAt`.

## 🛡️ Safety Guarantees

- Pi's stored JSONL session history remains unchanged.
- Context replacement affects only messages sent to the model.
- Covered ranges must belong to the current Pi session and active branch.
- Observations from abandoned sibling branches remain available for lookup but are excluded from active context and reflection inputs.
- Entry ranges must be complete, contiguous, non-overlapping, and exactly mapped.
- Semantic coverage must preserve every user request, correction, and question before raw messages become replaceable.
- The latest two raw user turns are retained where they fit; oversized turns keep the exact request and newest complete tail.
- Legacy observation schemas remain lookup-only until append-only migration.
- Tool calls and results remain complete pairs.
- Calls emitted by errored or aborted assistant responses are accepted only when proven unexecuted.
- Current trailing user messages and pending parallel tool results are retained safely.
- Invalid or incomplete provenance disables replacement immediately.
- Replacement remains disabled when transformed context still exceeds 70% of the selected model window, leaving Pi compaction as fallback.
- Lookup output and diagnostic logs redact secret-like values.
- Session changes and shutdown abort queued or running memory work.

## 📦 Install

### Stable npm package

```bash
pi install npm:@ravan08/pi-langfuse
```

### Git repository

```bash
pi install git:github.com/saravananravi08/pi-langfuse-extension
```

The provenance-safe lookup and context-replacement work is currently being tested on `feature/provenance-memory-context` and has not been published to npm yet. To test that exact build:

```bash
pi install git:github.com/saravananravi08/pi-langfuse-extension@feature/provenance-memory-context
```

Pi packages execute with full system access. Review third-party package source before installing.

## 🚀 Quick Start

### 1. Create Langfuse keys

Create project API keys in [Langfuse Cloud](https://cloud.langfuse.com) or your self-hosted Langfuse instance.

### 2. Create `config.json`

Copy [`config.example.json`](./config.example.json) to `config.json` in the installed package directory, then set your credentials and observer model:

```json
{
  "publicKey": "YOUR_LANGFUSE_PUBLIC_KEY",
  "secretKey": "YOUR_LANGFUSE_SECRET_KEY",
  "host": "https://cloud.langfuse.com",
  "observer": {
    "enabled": true,
    "api": "anthropic",
    "baseUrl": "https://api.example.com/anthropic",
    "apiKey": "YOUR_OBSERVER_API_KEY",
    "model": "YOUR_OBSERVER_MODEL"
  },
  "memory": {
    "reflection": {
      "enabled": true,
      "thresholdTokens": 20000,
      "minNewObservationTokens": 8000,
      "minNewObservations": 5
    }
  }
}
```

Install paths depend on package source, Pi scope, and Node installation. Use `pi list` to confirm the source. For a global npm install, find npm's actual package root with:

```bash
npm root -g
```

Place `config.json` beside this package's `index.ts`. Typical locations are:

```text
npm, global:  <npm-root>/@ravan08/pi-langfuse/config.json
npm, project: <project>/.pi/npm/@ravan08/pi-langfuse/config.json
git, global:  ~/.pi/agent/git/github.com/saravananravi08/pi-langfuse-extension/config.json
git, project: <project>/.pi/git/github.com/saravananravi08/pi-langfuse-extension/config.json
```

`config.json` is gitignored and must never be committed.

The observer supports Anthropic-compatible and OpenAI-compatible endpoints. Example OpenAI-compatible configuration:

```json
{
  "observer": {
    "enabled": true,
    "api": "openai",
    "baseUrl": "https://api.openai.com",
    "apiKey": "YOUR_OBSERVER_API_KEY",
    "model": "YOUR_OBSERVER_MODEL"
  }
}
```

### 3. Fully restart Pi

A full process restart is required after extension module changes. `/reload` may retain imported modules in Node's cache.

### 4. Run a turn and verify memory

```bash
pi "inspect this project and summarize its architecture"
```

After the turn completes, Langfuse should contain a `pi-agent` trace and, when the observer is enabled, a `memory_trace_observation` score. In interactive Pi:

```text
/memory-context preview
/memory-context on
```

`preview` shows the exact replacement plan without changing model context. `on` succeeds only when all safety checks pass.

## 🧭 Usage

### Automatic tracing

Pi auto-loads the extension. Normal prompts require no special command:

```bash
pi "your prompt"
```

### Memory context commands

```text
/memory-context preview          Show structural/semantic coverage, retained entries, tool pairs, and token estimates
/memory-context explain <topic>  Show winning/superseded durable state and exact provenance
/memory-context on               Enable provenance-gated model-visible context replacement
/memory-context off              Restore full Pi model context
/memory-context status           Show current setting
/memory-context                  Toggle on/off
```

While replacement is active, Pi shows compact status such as:

```text
Memory 24.9%/272k · est 7.1k · $1.235
```

The percentage is actual provider input usage against the selected model's context window. `est` is the estimated textual replacement-message size. Cost is cumulative main-model cost reported by the provider; OAuth subscription models show `$0.000 (sub)`, matching Pi, and cost is omitted when neither pricing nor subscription status is available. Binary image data is excluded and reported separately, for example `est 7.1k + 2 images`, because image token accounting varies by provider and model.

### Scoped memory lookup

Pi can call `langfuse_memory_lookup` when exact older decisions, files, errors, symbols, IDs, or source traces are needed.

```js
langfuse_memory_lookup({
  query: "authentication migration decision",
  scope: "path",
  includeSource: true,
  includePiEntries: true
})
```

Scopes:

- `session` — current session and cwd; default.
- `path` — sessions sharing the selected cwd/path key.
- `all` — all available memory scores.

Exact `traceId` and `scoreId` filters are supported. `includeSource` returns bounded details for at most two source traces. `includePiEntries` returns at most 50 exact, redacted Pi entries per matched session.

## ⚙️ Configuration

Tracing requires `publicKey`, `secretKey`, and `host`. Memory generation additionally requires an observer API key and model.

| Setting | Default | Purpose |
|---|---:|---|
| `observer.enabled` | `true` | Generate trace observation scores when model config exists. |
| `observer.api` | `anthropic` | `anthropic` or `openai` compatible request format. |
| `observer.baseUrl` | Provider default | Observer/reflector API base URL. |
| `observer.apiKey` | Provider environment key | Observer/reflector API credential. |
| `observer.model` | none | Observer and reflector model ID. |
| `memory.reflection.enabled` | `false` | Enable automatic session reflection. |
| `memory.reflection.thresholdTokens` | `20000` | Minimum active structured-memory size. |
| `memory.reflection.minNewObservationTokens` | `8000` | Minimum uncovered observation size. |
| `memory.reflection.minNewObservations` | `5` | Minimum uncovered observation count. |

All three reflection thresholds must pass. Token estimates count every structured reflector field, not only rendered Markdown.

Environment variables override file configuration:

```bash
PI_LANGFUSE_OBSERVER_ENABLED=true
PI_LANGFUSE_OBSERVER_API=anthropic
PI_LANGFUSE_OBSERVER_BASE_URL=https://api.example.com/anthropic
PI_LANGFUSE_OBSERVER_API_KEY=...
PI_LANGFUSE_OBSERVER_MODEL=...
PI_LANGFUSE_REFLECTION_ENABLED=true
PI_LANGFUSE_REFLECTION_THRESHOLD_TOKENS=20000
PI_LANGFUSE_REFLECTION_MIN_NEW_TOKENS=8000
PI_LANGFUSE_REFLECTION_MIN_NEW_OBSERVATIONS=5
PI_LANGFUSE_MEMORY_ERROR_LOG=~/.pi/agent/logs/langfuse-memory-errors.jsonl
```

Prompts are centralized in [`memory/memory-prompts.js`](./memory/memory-prompts.js). `observer-v3` and `reflection-v4` outputs must pass structured schema, authority, semantic-coverage, retention, duplication, and contradiction checks. Reflection Markdown is rendered deterministically from canonical fields. Default injected memory is bounded to approximately 10k estimated textual tokens.

## 🗃️ Langfuse Data Model

```text
Trace: pi-agent
├─ sessionId: Pi session ID
├─ input/output: user and assistant messages
├─ metadata: model, provider, cwd
├─ Generation: llm-response
│  ├─ model and provider
│  ├─ input/output tokens
│  └─ input/output/total cost
├─ Span: tool:<name>
│  ├─ arguments and result
│  └─ error state
└─ Score: memory_trace_observation
   ├─ exact user requests and question/answer pairs
   ├─ corrections, durable items, task delta, files, and tools
   ├─ replacementEligible + semanticCoverage
   └─ exact pi-entry-v1 provenance

Session score: memory_session_reflection
├─ generation and coveredUntil
├─ canonical durable state with authority/status/source IDs
├─ active/superseded decisions and constraints
├─ source observation/reflection score IDs
├─ source trace IDs
└─ aggregated Pi entry ranges and tool pairs
```

Active memory is scoped by Langfuse session ID and cwd/path key. Remote reads are cached for five minutes, updated immediately after local writes, and refreshed before reflection creation.

## 🧰 Audit, Backfill, and Reflection Scripts

### Read-only audit

```bash
node scripts/observe-langfuse-session.mjs <session-id> --audit
```

`--audit` does not write. It reports missing observations, historical pre-coverage traces, incomplete or invalid Pi provenance, semantic-coverage failures, active decision conflicts, duplicate scores, overlapping entries, deterministic-ID mismatches, and prompt versions.

### Controlled observation backfill

```bash
node scripts/observe-langfuse-session.mjs <session-id> --audit --backfill --dry-run
node scripts/observe-langfuse-session.mjs <session-id> --audit --backfill
node scripts/observe-langfuse-session.mjs <session-id> --audit --backfill --include-pre-coverage
```

Backfill writes only eligible traces that map uniquely to complete Pi provenance. `--include-pre-coverage` explicitly includes older historical traces.

Additional controls:

```bash
node scripts/observe-langfuse-session.mjs <session-id> --dry-run --limit 1
node scripts/observe-langfuse-session.mjs <session-id> --trace <trace-id> --audit --backfill
node scripts/observe-langfuse-session.mjs <session-id> --force
```

Version-2 migration is append-only. Use `--trace` for a targeted repair or `--include-pre-coverage` for an explicitly reviewed historical migration.

### Reflection inspection or generation

```bash
node scripts/reflect-langfuse-session.mjs <session-id>
node scripts/reflect-langfuse-session.mjs <session-id> --dry-run
node scripts/reflect-langfuse-session.mjs <session-id> --force --dry-run
node scripts/reflect-langfuse-session.mjs <session-id> --path /project/cwd --limit 10
```

Without `--force`, configured thresholds apply. `--dry-run` may call the reflector but never writes a score.

Both scripts read the same `config.json`. One-off observer aliases are also supported:

```bash
OBSERVER_API=openai OBSERVER_BASE_URL=https://api.openai.com OBSERVER_API_KEY=... OBSERVER_MODEL=... \
  node scripts/observe-langfuse-session.mjs <session-id>
```

## 🩺 Diagnostics

Memory failures are appended to:

```text
~/.pi/agent/logs/langfuse-memory-errors.jsonl
```

The file is created with `0600` permissions. Records contain safe request, validation, scope, and provenance details but never raw observer or reflector model output. Use `PI_LANGFUSE_MEMORY_ERROR_LOG` to override the path.

## ⚠️ Operational Limits

- Version-1 observations and sessions without complete structural and semantic provenance remain lookup-only until append-only version-2 migration.
- Context replacement intentionally fails closed on ambiguous branches, mappings, or tool pairs.
- Request throttling is coordinated within one Pi process; multiple concurrent Pi processes do not yet share a global rate limiter.
- Pi auto-compaction behavior is unchanged.
- Imported extension modules may remain cached after `/reload`; use a full restart when testing code changes.

## 🛠️ Troubleshooting

### No traces

- Verify Langfuse keys and `host`.
- Confirm the extension appears in `pi list`.
- Fully restart Pi.

### No `memory_trace_observation`

- Set `observer.enabled=true`.
- Configure `observer.model` and `observer.apiKey`.
- Final observation runs asynchronously after `agent_end`; long turns can also emit non-overlapping in-turn checkpoints.
- Transient `408`, `429`, and `5xx` responses retry up to eight times with bounded exponential or provider-directed backoff.
- If all retries fail, run the read-only audit, then controlled `--backfill` after the provider recovers.
- Inspect the private diagnostic log.

### No `memory_session_reflection`

- Set `memory.reflection.enabled=true`.
- Confirm all three thresholds pass.
- Run `scripts/reflect-langfuse-session.mjs <session-id>` for status.

### Memory context is blocked

- Run `/memory-context preview` and inspect the exact reason.
- Run the session audit for incomplete, invalid, or overlapping provenance.
- Do not bypass the gate; retain full Pi context until provenance is valid.

### Model cost is missing

Not every provider reports pricing data. Token usage may still be available.

## 🤝 Contributing

Contributions are welcome.

1. Fork the repository.
2. Create a focused feature or fix branch.
3. Install dependencies with `npm install`.
4. Make the smallest relevant change and add or update tests.
5. Run `npm test`.
6. Submit a pull request describing the problem, solution, and verification.

Open an issue before large architectural changes. Never commit `config.json`, API keys, private session data, or files under `documents/`.

## 📚 Dependencies

- [`langfuse`](https://www.npmjs.com/package/langfuse) — Langfuse SDK.
- [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) — Pi extension API.

## 📄 License

MIT
