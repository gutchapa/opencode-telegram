# Community post drafts — gutchapa-opencode-telegram

## Variant A: Discord post (short, paste into #plugins / #showcase / #community)

> 🚀 I built a **Telegram bot for opencode** — chat with your coding agent from your phone.
>
> `gutchapa-opencode-telegram` turns opencode into a Telegram bot: **70+ slash commands** (`/execute`, `/model`, `/compact`, `/status`, ...), agentic replies that run through your opencode server, and full support for **local LLMs** (llama.cpp etc.) — no cloud account needed.
>
> ✨ Highlights:
> - Works as an opencode **plugin** or a **standalone bot**
> - Polling is opt-in — no conflicts with existing bots or `opencode serve`
> - `/debug` shows bot + LLM health right in chat
>
> 📦 Install:
> ```json
> { "plugin": ["gutchapa-opencode-telegram"] }
> ```
> or `npm i -g gutchapa-opencode-telegram`
>
> 🔗 npm: https://www.npmjs.com/package/gutchapa-opencode-telegram
> 🔗 repo: https://github.com/gutchapa/opencode-telegram
>
> Feedback / feature requests welcome via Issues & Discussions. Star the repo if you find it useful ⭐

## Variant B: GitHub Discussion / longer forum post

> **Telegram bot for opencode — chat with your AI agent from anywhere**
>
> I've been running opencode as my daily driver on a local Qwen model (llama.cpp) and wanted the same assistant in my pocket. So I built a Telegram bot around it.
>
> **What it does**
> `gutchapa-opencode-telegram` connects a Telegram chat to an opencode instance. Replies are agentic — they run through your opencode server (TUI, `opencode serve`, or `opencode run`), so you get the same tools/skills/MCP context as in the terminal, but from your phone. It ships with 70+ slash commands covering session control (`/new`, `/reset`, `/compact`, `/restart`), model & config (`/model`, `/config`, `/mcp`), output modes (`/think`, `/reasoning`, `/verbose`), and bot ops (`/status`, `/debug`, `/bot-logs`, `/bot-version`).
>
> **Why it's a bit different**
> - **Local-first**: no cloud dependency — bring your own LLM (llama.cpp, Ollama, whatever opencode points at).
> - **No conflicts**: Telegram polling is opt-in via config (`{ "enabled": true }` or `TELEGRAM_PLUGIN_ENABLED=1`), so it never fights an existing poller or `opencode serve`.
> - **Two modes**: use it as a regular opencode plugin, or run it standalone (`opencode-telegram-bot`) as a long-lived poller.
>
> **Try it**
> ```bash
> npm i -g gutchapa-opencode-telegram
> ```
> add `"gutchapa-opencode-telegram"` to your `opencode.json` `plugin` array, set `TELEGRAM_BOT_TOKEN` + `ALLOWED_TELEGRAM_USERS`, and restart.
>
> **Feedback** — bugs, ideas, or just say hi:
> - Issues: https://github.com/gutchapa/opencode-telegram/issues
> - Discussions: https://github.com/gutchapa/opencode-telegram/discussions
>
> It's also listed on the opencode ecosystem page. Would love to hear how it works for your setup!

## Variant C: X/Twitter-style blurb

> Turned my local coding agent (opencode + Qwen on llama.cpp) into a Telegram bot.
> 70+ slash commands, agentic replies, no cloud.
> 📦 gutchapa-opencode-telegram on npm ⭐ github.com/gutchapa/opencode-telegram
> #opencode #llm #telegram

## Posting tips
- Discord: drop it in the plugin/showcase channel; add a screenshot of the `/` command menu or a chat reply — posts with images get far more replies. To grab the menu: open Telegram, type `/`, screenshot.
- The opencode ecosystem page (opencode.ai/docs/ecosystem) lists the plugin once the PR merges — that's passive discovery; the Discord post is the active push.
- Reply to your own post a day later with a short "update" (e.g. install numbers) to keep it alive.
