# Telegram-for-opencode — competitor study + standout plan (2026-10-02)

## Numbers (live today)

| Project | GitHub ⭐/🍴 | npm / month | Last push | Status |
|---|---|---|---|---|
| grinev/opencode-telegram-bot | 1219 / 221 | 5792 (`@grinev/opencode-telegram-bot`) | today | Dominant incumbent, ecosystem PR #15742 pending |
| gutchapa-opencode-telegram (us) | 0 / 0 | 2714 | Sep 30 (1.3.1) | #2 on npm, invisible on GitHub |
| marco-jardim/opencode-telegram-plugin | 2 / 2 | n/a (repo install) | Sep 9 | Closest tech cousin, no distribution |
| Shenean/opencode-tbot | 2 / 0 | 192 | Mar 26 (stale) | Dormant |
| timjonez/opencode_telegram_plugin (`opencode-telegram-plugin` npm) | 0 / 0 | 78 | Mar 6 (stale) | Name-squat, dormant |

Share of telegram-plugin npm installs: grinev 66%, **us 31%**, rest 3%. We are the clear #2 by installs with 0 stars — conversion problem, not product problem.

## Feature matrix (what each owns)

| Capability | grinev | marco | tbot | timjonez | **us** |
|---|---|---|---|---|---|
| Remote prompts + sessions + permissions | ✅ | ✅ | ✅ | ✅ | ✅ |
| Live streaming edits | ❌ (poll) | ✅ throttled | ❌ | ❌ | ❌ (`opencode run` batch) |
| Inline permission buttons | ✅ | ✅ | ✅ | ✅ text-only | ✅ (event push + approve buttons, 1.3.0) |
| Voice / TTS / images | ✅ full | ❌ | images only | ❌ | ✅ media both ways + voice note hook |
| Scheduled tasks | ✅ in-bot | ❌ | ❌ | ❌ | ❌ (digest scheduler only) |
| Multi-language UI | ✅ 5 langs | ❌ | ❌ | ❌ | ❌ |
| **Bundled AI morning digest w/ fitment ✅/⏭️** | ❌ | ❌ | ❌ | ❌ | ✅ **ONLY US** |
| **Dual runtime: plugin + standalone poller** | ❌ bot-only | ❌ plugin-only | ❌ plugin-only | ❌ | ✅ **ONLY US** |
| **launchd/systemd/Docker templates** | ❌ | ❌ | ❌ | ❌ | ✅ **ONLY US** |
| **70+ slash commands (agent control surface)** | ~15 cmds | ~25 cmds | ~10 cmds | ~15 cmds | ✅ **widest** |
| Local-first / free-tier / llama.cpp explicit | ❌ | ❌ | ❌ | ❌ | ✅ **ONLY US** |
| Opt-in polling (no double-poller fights) | ❌ | ❌ | ❌ | ❌ | ✅ **ONLY US** |

## Standout positioning (3 lines, use everywhere)

> The only Telegram plugin that is BOTH a plugin and a 24/7 standalone bot, with a bundled AI morning briefing (news + trending + tracked repos + ✅/⏭️ fitment), 70+ slash commands, and local-first free-model routing. #2 on npm (2.7k/mo), MIT.

Attack plan:
1. Ecosystem PR (Projects table) — draft below. grinev's PR is still pending, so file ours NOW while the table has no Telegram row; first-listed Telegram entry wins the click.
2. awesome-opencode PR — same row, Plugins section.
3. Close the streaming gap later (throttled in-place edits like marco) — only feature gap that matters in reviews. Everything else we lead.

---

## DRAFT 1 — GitHub issue (anomalyco/opencode)

Title: `[FEATURE]: Add gutchapa-opencode-telegram to ecosystem projects list`

Body:
```
I'd like to add my project to the OpenCode ecosystem page in the Projects section.

- Name: gutchapa-opencode-telegram
- GitHub: https://github.com/gutchapa/opencode-telegram
- NPM: https://www.npmjs.com/package/gutchapa-opencode-telegram (2.7k downloads last month, 1.3.1)
- Description: Telegram bot for opencode — dual runtime (opencode plugin + standalone 24/7 poller), 70+ slash commands, file/media both ways, and a bundled AI morning briefing with fitment verdicts. Local-first, MIT.

What makes it different from the other Telegram entries:
- Only one that runs BOTH as an opencode plugin and as a standalone bot (launchd/systemd/Docker templates included)
- Only one with a bundled daily AI digest (HN news + trending + tracked repos + ✅ useful / ⏭️ skip fitment against your running setup)
- Widest slash-command surface (70+: session, model, reasoning/output modes, goal/steer, bot ops, diagnostics)
- Local-first: routes via `opencode run`, works with free-tier and local models (llama.cpp/Ollama), opt-in polling so it never fights an existing poller

Happy to adjust the listing format to match whatever the maintainers prefer.
```

## DRAFT 2 — Ecosystem PR row (Projects table, ecosystem.mdx)

```mdx
[gutchapa-opencode-telegram](https://github.com/gutchapa/opencode-telegram)

Telegram bot for opencode — dual runtime (plugin + standalone poller), 70+ slash commands, file sharing both ways, and a bundled AI morning briefing with fitment verdicts
```

## DRAFT 3 — awesome-opencode PR row (Plugins section)

```md
- [gutchapa-opencode-telegram](https://github.com/gutchapa/opencode-telegram) — Telegram bot for opencode with 70+ slash commands, standalone + plugin modes, and a daily AI digest with ✅/⏭️ fitment (2.7k npm/mo, MIT)
```
