# Suggested Commands

## Build

```bash
npm run build         # Compiles TypeScript → dist/ via tsc
```

## Development

```bash
npm run dev           # Runs daemon in dev mode with tsx --watch (auto-reload)
npm run daemon        # Runs daemon directly via tsx (no watch)
npm run tui           # Starts terminal UI client (connects to running daemon)
```

## Formatting

```bash
npm run format        # Format all files with prettier
npm run format:check  # Check formatting without writing
```

## CLI Usage (after npm link or install)

```bash
nzb setup             # Interactive setup wizard (creates ~/.nzb/.env)
nzb update            # Check for and perform self-updates
nzb start             # Start daemon, or 'nzb daemon'
nzb version           # Show version
nzb help              # Show help
```

## Installation

```bash
bash install.sh       # System install from repo
bash install.sh --dev # Dev mode install (links to repo)
npm install           # Install dependencies
npm run build         # Build
npm link              # Make 'nzb' command available globally
```

## Testing

No test framework configured yet. Manual testing via:

1. Start daemon: `npm run dev`
2. In another terminal: `npm run tui`
3. Or send Telegram messages if bot is configured
