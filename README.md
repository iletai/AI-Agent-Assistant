# NZB

AI orchestrator powered by [Copilot SDK](https://github.com/github/copilot-sdk) — control multiple Copilot CLI sessions from Telegram or a local terminal.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/iletai/AI-Agent-Assistant/main/install.sh | bash
```

Or install directly with npm:

```bash
npm install -g nzb
```

## Quick Start

### 1. Run setup

```bash
nzb setup
```

This creates `~/.nzb/` and walks you through configuration (Telegram bot token, etc.). Telegram is optional — you can use NZB with just the terminal UI.

### 2. Make sure Copilot CLI is authenticated

```bash
copilot login
```

### 3. Start NZB

```bash
nzb start
```

### 4. Connect via terminal

In a separate terminal:

```bash
nzb tui
```

### 5. Talk to NZB

From Telegram or the TUI, just send natural language:

- "Start working on the auth bug in ~/dev/myapp"
- "What sessions are running?"
- "Check on the api-tests session"
- "Kill the auth-fix session"
- "What's the capital of France?"

## Commands

| Command | Description |
|---------|-------------|
| `nzb start` | Start the NZB daemon |
| `nzb tui` | Connect to the daemon via terminal |
| `nzb setup` | Interactive first-run configuration |
| `nzb update` | Check for and install updates |
| `nzb help` | Show available commands |

### Flags

| Flag | Description |
|------|-------------|
| `--self-edit` | Allow NZB to modify his own source code (use with `nzb start`) |

### TUI commands

| Command | Description |
|---------|-------------|
| `/model [name]` | Show or switch the current model |
| `/memory` | Show stored memories |
| `/skills` | List installed skills |
| `/workers` | List active worker sessions |
| `/copy` | Copy last response to clipboard |
| `/status` | Daemon health check |
| `/restart` | Restart the daemon |
| `/cancel` | Cancel the current in-flight message |
| `/clear` | Clear the screen |
| `/help` | Show help |
| `/quit` | Exit the TUI |
| `Escape` | Cancel a running response |

## How it Works

NZB runs a persistent **orchestrator Copilot session** — an always-on AI brain that receives your messages and decides how to handle them. For coding tasks, it spawns **worker Copilot sessions** in specific directories. For simple questions, it answers directly.

You can talk to NZB from:

- **Telegram** — remote access from your phone (authenticated by user ID)
- **TUI** — local terminal client (no auth needed)

## Architecture

```
Telegram ──→ NZB Daemon ←── TUI
                │
          Orchestrator Session (Copilot SDK)
                │
      ┌─────────┼─────────┐
   Worker 1  Worker 2  Worker N
```

- **Daemon** (`nzb start`) — persistent service running Copilot SDK + Telegram bot + HTTP API
- **TUI** (`nzb tui`) — lightweight terminal client connecting to the daemon
- **Orchestrator** — long-running Copilot session with custom tools for session management
- **Workers** — child Copilot sessions for specific coding tasks

## Development

```bash
# Clone and install
git clone https://github.com/iletai/AI-Agent-Assistant.git
cd AI-Agent-Assistant
npm install

# Watch mode
npm run dev

# Build TypeScript
npm run build
```

This project uses TypeScript, Zod for schema validation, and a simple file-based SQLite database for state management. The Copilot SDK is used to create and manage AI sessions, and the Telegram Bot API is used for remote messaging. Reference the source code for implementation details!

Thankful for <https://github.com/burkeholland/max> which inspired this project.
