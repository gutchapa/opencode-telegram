# opencode-telegram-plugin

Local Qwen-powered Telegram bot that executes terminal commands and file
operations via opencode.

## Architecture

- **LLM Engine**: Local Qwen (via opencode)
- **File Access**: user home directory (full access)
- **Command Execution**: All terminal commands run through opencode
- **No Cloud APIs**: 100% local processing
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
