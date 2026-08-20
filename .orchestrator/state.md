# Orchestrator state — pogo-gbl-team-generator

Phase: 3 (execute). Resume: reconcile with ListAgents/git status; integrate any landed packets (P1/P2 first), then dispatch P3 (needs P1) and P4 (can use fixture matrix), then P5, P6.

## Packet board
| id | status | agent | attempts | note |
|----|--------|-------|----------|------|
| P1 | running | sonnet worker (bg) | 1 | engine harness — critical path; fallback if headless load fails: Playwright vs local pvpoke page |
| P2 | running | sonnet worker (bg, relaunch) | 1 | importer — first run killed by session limit @94%; partial src/importer/{csv,gamemaster,util}.js kept for relaunched worker to review+finish (limit deaths don't count as attempts) |
| P3 | ready (blocked by P1) | — | 0 | scoring matrix |
| P4 | ready (blocked by P3 shape; fixture ok) | — | 0 | team search |
| P5 | ready (blocked by P2,P3,P4) | — | 0 | CLI + report |
| P6 | ready (blocked by all) | — | 0 | e2e + README |

## Decisions log
- "Great Ball League" read as GO Battle League **Great League, CP ≤ 1500** (dir name `pogo-gbl-team-generator`; 1500 is the standard cap; cap kept tunable). 
- Use pvpoke **recommended movesets** (assumes TMs); current-moves mode is stretch. Why: matches pvpoke ranking defaults; move columns in exports are unreliable.
- Support **both** Poke Genie CSV and a generic CSV, auto-detected — cheaper to build both than to ask; user drops their export in at delivery.
- Vendor pvpoke as pinned sparse shallow clone `ea601f0a61c548f9140e4605b94a31fa97fe6aba` (only src/js, src/data; 149MB), gitignored, `scripts/setup.sh` restores. Why: not our code, too big to commit.
- Scoring weights 0.25/0.50/0.25 over 0v0/1v1/2v2 shields; coverage threshold rating ≥ 500 at 1v1. Documented in PLAN.md, tunable.
- Zero kickoff questions: location/stack/scope all inferable.

## Watchdog
One background `sleep 1800 && echo WATCHDOG_TICK` armed after each dispatch wave (see /orchestrate skill playbook). On tick: ListAgents + git status reconcile; all healthy → re-arm + noop board; dead worker → resume protocol (probe with ONE re-dispatch; on limit error arm RESUME_PRIMARY/BACKUP timers past the stated reset time). Duplicate ticks are harmless noops.

## Event log
- 2026-08-20: scaffold created (PLAN, CLAUDE, state, package.json, .gitignore), pvpoke vendored @ ea601f0, initial commit. P1+P2 dispatched (sonnet, background).
- 2026-08-20 ~12:30pm ET: session usage limit hit (94%→cap). P2 worker killed mid-run (partial importer left on disk); P1 worker SURVIVED and kept running. Limit reset 12:30pm; next window resets 5:30pm ET.
- 2026-08-20 post-reset: user directive — self-resume without manual /orchestrate. Skill playbook rewritten: standing watchdog + reset-timed resume timer pairs. P2 relaunched (review+finish partial work). Watchdog armed.
