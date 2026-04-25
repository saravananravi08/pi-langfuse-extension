# @ravan08/pi-langfuse

Langfuse observability extension for [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent). Sends traces to [Langfuse](https://langfuse.com) for monitoring tokens, costs, latency, and tool calls.

## Quick Install

### Via npm (recommended)
```bash
pi install npm:@ravan08/pi-langfuse
```

### Via git
```bash
pi install git:github.com/saravananravi08/pi-langfuse-extension
```

## Setup

### 1. Configure API Keys

Get your keys from [Langfuse Cloud](https://cloud.langfuse.com) → Settings → API Keys.

Create `config.json` in the extension directory:

```json
{
  "publicKey": "pk-lf-xxxx",
  "secretKey": "sk-lf-xxxx",
  "host": "https://cloud.langfuse.com"
}
```

For npm install, find the extension at:
```bash
~/.pi/agent/npm/@ravan08/pi-langfuse/index.ts
```

### 2. Run pi

After installation, pi auto-loads the extension. Just run:

```bash
pi "your prompt"
```

Or use `-e` for specific session:
```bash
pi -e npm:@ravan08/pi-langfuse "your prompt"
```

## Features

| Feature | Description |
|---------|-------------|
| **Trace Input/Output** | Captures user prompts and assistant responses |
| **Session Tracking** | Groups traces by pi session ID |
| **Model Info** | Records model name (e.g., "MiniMax-M2.7") and provider |
| **Token Usage** | Tracks input/output tokens per generation |
| **Cost Tracking** | Records API costs (input, output, total in USD) |
| **Tool Call Spans** | Records tool calls with parameters and results |
| **Langfuse Sessions** | Traces grouped by conversation session |

## What Gets Tracked

### Trace Level
- `input` - User prompt
- `output` - Assistant response
- `sessionId` - Pi session identifier
- `metadata` - Model, provider, cwd

### Generation Observations (LLM Calls)
- `model` - Model identifier
- `usage` - Token counts (input/output/total)
- `costDetails` - Cost breakdown in USD

### Span Observations (Tool Calls)
- `name` - Tool name (e.g., "tool:bash")
- `input` - Tool parameters (JSON)
- `output` - Tool result
- `metadata.isError` - Whether tool failed

## Langfuse Dashboard

After running, check your Langfuse project for:

1. **Traces** - All pi agent runs with I/O
2. **Sessions** - Traces grouped by session ID
3. **Observations** - Tool calls and LLM generations
4. **Scores** - Token counts and costs
5. **Model Usage** - Usage breakdown by model

## Manual Installation (from source)

```bash
# Clone repo
git clone https://github.com/saravananravi08/pi-langfuse-extension.git
cd pi-langfuse-extension

# Install dependencies
npm install

# Configure
cp config.example.json config.json
# Edit config.json with your Langfuse API keys

# Run with extension
pi -e ./index.ts "your prompt"
```

## File Structure

```
pi-langfuse-extension/
├── index.ts              # Extension code
├── package.json          # Dependencies
├── config.example.json   # API key template
└── README.md             # This file
```

## Dependencies

- [langfuse](https://www.npmjs.com/package/langfuse) - Langfuse SDK
- [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) - Pi extension API

## Troubleshooting

**No traces appearing?**
- Verify API keys are correct in `config.json`
- Check Langfuse project is active
- Ensure API keys have write permissions

**Extension not loading?**
- Run `pi list` to check installed packages
- Try `pi reload` to refresh

**Model/cost not showing?**
- Not all providers expose cost info
- Check Langfuse traces API for raw observation data

## License

MIT