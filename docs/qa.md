# QA

An automated suite plus a QA subagent that drives it.

## Run it yourself
```bash
npm run qa:install   # once: downloads Chromium for Playwright
npm run qa           # boots isolated demo instances (ports 5273/8887, temp data dir), runs every spec
```
Results: `qa/findings/latest.md` (human-readable), `qa/results/` (JSON, screenshots, traces).
Open a failing trace with `npx playwright show-trace qa/results/artifacts/<test>/trace.zip`.
Use `QA_CHROMIUM=/path/to/chrome` to point at an existing browser, `QA_VERBOSE=1` to see the app's output.

The suite never touches your real data, your running demo (5173/8787), the OS keychain or any real account.

## What it covers (`qa/tests`)
| File | Covers |
|---|---|
| `01-core-flow` | The full scenario from the brief, through the UI: email -> ticket + reply -> Slack -> 1Password -> resolve -> close |
| `02-navigation` | Settings round trip, deep links/history, filters, new streams, chat, auto-reload when the server restarts |
| `03-concurrency-and-errors` | Simultaneous approvals, clean 4xx errors, finished drafts can't be re-used, bad bodies |
| `04-reject-path` | Rejecting a prerequisite fails its dependent safely, and Claude is told |
| `05-security` | Host/Origin guard, no secret leakage, headers, traversal |
| `06-ui-quality` | Console errors, axe accessibility, layout at small sizes, draft editing, keyboard |

## The agent
`.claude/agents/qa-tester.md` is a Claude Code subagent that runs the suite, adds exploratory testing, writes a structured findings report, and in *verify mode* re-runs everything against the previous report.
`/qa` (`.claude/commands/qa.md`) runs the whole loop: test -> report -> fix -> full re-test, until clean.
