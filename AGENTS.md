# opencode-telegram-plugin

Telegram bot that executes terminal commands and file operations via opencode.

## Architecture

- **LLM Engine**: model from OPENCODE_MODEL env (e.g. Muse Spark via OpenCode Zen), else opencode-config default
- **File Access**: user home directory (full access)
- **Command Execution**: All terminal commands run through opencode
- **Routing**: every plain-text message goes straight to the model (no regex front-gate); explicit slash commands dispatch through the command layer
- **Runtime**: opencode plugin server contract (default export with `id` and
  `server`), plus a standalone bin for launchd deployments

## Design Invariants

1. **Command Handling**: All slash commands registered via the command registry
2. **Execution**: Commands executed via the runtime registry
3. **No Silent Failures**: All errors reported to user
4. **Local Processing**: 100% local, no external dependencies

## Setup

1. Run: `npm install`
2. Run: `npm run build`
3. Run: `npm run bot -- <BOT_TOKEN>`

## Commands

- `/execute <command>` - Run terminal command
- `/read <path>` - Read file content
- `/search <pattern>` - Search files
- `/list <dir>` - List directory contents
- `/help` - Show available commands
- `/accounts` - List configured accounts
- `/allow-from <id>` - Set allowed user ID
