# @ravan08/pi-langfuse

Observability extension for [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) that sends traces to [Langfuse](https://langfuse.com) for monitoring tokens, costs, latency, and tool calls.

## Installation

```bash
pi install npm:@ravan08/pi-langfuse
```

Or from git:
```bash
pi install git:github.com/saravananravi08/pi-langfuse-extension
```

## Features

- **Trace Creation**: Captures user prompts and assistant responses
- **Session Tracking**: Groups traces by pi session
- **Model Info**: Records model name and provider (e.g., MiniMax-M2.7, anthropic)
- **Token Usage**: Tracks input/output tokens
- **Cost Tracking**: Records API costs (input, output, total)
- **Tool Call Spans**: Records tool calls with input/output
- **Langfuse Sessions**: Groups traces by conversation session

## Installation

### 1. Install npm dependencies

```bash
cd ~/.pi/agent/extensions/langfuse
npm install
```

### 2. Configure API keys

Copy the example config and add your keys:

```bash
cp config.example.json config.json
# Then edit config.json with your keys
```

Edit `config.json` with your Langfuse keys:

```json
{
  "publicKey": "pk-lf-xxxx",
  "secretKey": "sk-lf-xxxx",
  "host": "https://cloud.langfuse.com"
}
```

Get your API keys from [Langfuse Cloud](https://cloud.langfuse.com) → Settings → API Keys.

### 3. Run pi with the extension

```bash
pi -e ~/.pi/agent/extensions/langfuse/index.ts "your prompt"
```

Or for auto-loading (no `-e` flag needed):

```bash
cp ~/.pi/agent/extensions/langfuse/index.ts ~/.pi/agent/extensions/langfuse-auto.ts
pi "your prompt"
```

## What Gets Tracked

### Trace Level
| Field | Description |
|-------|-------------|
| `input` | User prompt |
| `output` | Assistant response |
| `sessionId` | Pi session identifier |
| `metadata.model` | Model name (e.g., "MiniMax-M2.7") |
| `metadata.provider` | API provider (e.g., "minimax") |
| `metadata.cwd` | Working directory |

### Generation Observations (LLM Calls)
| Field | Description |
|-------|-------------|
| `model` | Model identifier |
| `usage` | Token counts (input/output/total) |
| `costDetails` | Cost breakdown (input/output/total in USD) |

### Span Observations (Tool Calls)
| Field | Description |
|-------|-------------|
| `name` | Tool name (e.g., "tool:bash") |
| `input` | Tool parameters |
| `output` | Tool result |
| `metadata.isError` | Whether tool execution failed |

## Langfuse Dashboard

After running with the extension, you'll see:

1. **Traces**: All pi agent runs
2. **Sessions**: Grouped by pi session ID
3. **Observations**: Tool calls and LLM generations
4. **Scores**: Token counts and costs
5. **Model Usage**: Usage breakdown by model

## Repository Structure

```
pi-langfuse-extension/
├── index.ts          # Main extension code
├── package.json       # Dependencies (langfuse npm package)
├── config.json        # API keys (create this)
└── node_modules/      # Installed dependencies
```

## Troubleshooting

### Extension not loading?
- Make sure `node_modules` exists (run `npm install`)
- Check `config.json` has valid API keys
- Verify Langfuse project is active

### No traces appearing?
- Check Langfuse dashboard for the correct project
- Verify API keys have write permissions

### Model/cost not showing?
- Ensure you're using a model that provides usage/cost info
- Check Langfuse traces API for observation details

## Dependencies

- [langfuse](https://www.npmjs.com/package/langfuse) - Langfuse SDK
- [pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) - Pi extension API

## License

MIT