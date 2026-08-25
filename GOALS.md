# GOALS — work queue (append-only checklist)

## Standing rules — every fire obeys these, no exceptions
1. Read this file in full, then PROGRESS.md's tail (last 2–3 entries), then ROADMAP.md, then CLAUDE.md and PLAN.md (especially the Rev 2 section) before touching anything.
2. **First command of every fire:** `bash scripts/setup.sh` — `vendor/pvpoke` is gitignored and will NOT exist in a fresh clone. Nothing works without it.
3. **Verification gates:** a checkbox may be checked ONLY after its stated verify command ran clean in THIS run. Code review alone is never verification. Anything you could not actually run gets written in PROGRESS.md as "unverified: <thing>" — a false "done" is the most expensive mistake in this project.
4. `vendor/pvpoke` is read-only. Never edit it. NEVER reimplement pvpoke's battle math — load and execute pvpoke's own code (see src/engine/pvpokeLoader.js for the established pattern). A result produced by hand-rolled damage/battle formulas is wrong by definition here.
5. One bounded, complete chunk per fire (finish the ticket outright if reasonably scoped). Never leave the repo broken, even mid-task: `node --test` on the suites you touched must pass before you commit. Commit and push to `main` directly, then append a PROGRESS.md entry (what you did, current state, what's next, verified vs. not, `date -u` timestamp).
6. Blocked or ambiguous → make a documented judgment call and proceed; skip to the next ticket only if truly blocked, and say why in PROGRESS.md. Queue empty → pull from ROADMAP.md's known gaps. Stay scoped — no unrequested refactors.
7. Tickets marked (seq) depend on earlier unchecked tickets — take the first unchecked ticket unless it's explicitly parallel-safe.
8. **Run verify commands in the FOREGROUND with an explicit generous timeout (`npm run test:full` needs ~300000–600000 ms; the default `npm test` fast subset is much shorter but still deserves a real timeout) — NEVER as a background task you "wait" on.** A scheduled cloud run is NOT re-invoked when a background command finishes: ending your turn while a background test run holds your uncommitted work means the run ends, nothing commits, and the entire fire's work is lost (this exactly happened 2026-08-21 ~19:53Z — a complete T23 implementation died uncommitted). If a long command hits the tool's default 3-minute timeout, re-run it foreground with a longer explicit timeout — do not background it. Added 2026-08-24: `npm test` now runs a fast subset (see CLAUDE.md) — a pre-push or ticket-closing verify still needs `npm run test:full`.
9. **G0 — standing environment gate, EVERY fire (not a queue ticket; never gets checked off):** after `bash scripts/setup.sh`, confirm `vendor/pvpoke` is at pinned commit ea601f0a61c548f9140e4605b94a31fa97fe6aba and the suites you'll rely on pass before starting ticket work. First verified in this sandbox 2026-08-20 (42/42, no fallback needed — see PROGRESS). If the pvpoke clone ever FAILS here (network policy change): fall back to vendoring the needed subset INTO this repo — copy `src/js` + `src/data/gamemaster.json` + `src/data/groups/` + `src/data/rankings/all/overall/rankings-1500.json` + `src/data/training/` from a working clone into `vendor-static/pvpoke/`, un-ignore that path, point setup.sh and the engine's vendorRoot default at it, keep the pin recorded, and say in PROGRESS.md the fallback was taken.


## State hygiene (added 2026-08-24, orchestrator — token-budget protection; these
queue files are re-ingested at full price by every zero-memory fire, so their
size is a fixed per-fire tax)
- GOALS.md holds this header + OPEN tickets only. Checking a box MOVES the whole
  ticket block verbatim to GOALS_ARCHIVE.md in the same commit.
- No inline run narratives inside tickets: a still-open multi-fire ticket carries
  at most one compact STATE block (≤~20 lines: done/open, next chunk, open
  flags), rewritten in place each run; superseded text moves verbatim to
  GOALS_ARCHIVE.md in the same commit. The full run story goes in PROGRESS.md.
- PROGRESS.md entries: ≤~25 lines, never paste passing test output (name the
  command, say clean; paste failures only). Past ~600 lines, rotate all but the
  newest ~10 entries verbatim to PROGRESS_ARCHIVE.md in the same commit.
- Read PROGRESS.md's tail via offset/tail, never the whole file. The archives
  are history, not context — read them only when investigating something
  specific.

## Queue

- [ ] **T32 — DPS-race shield hold.** `src/engine/teamBattle.js`'s
  `wrapShieldBanking` (around L714-766) currently declines a shield only
  when `canTankAndAnswer` is true. Jaxon raised a distinct point in the same
  session as the endgame-gate fix (PROGRESS.md's "follow-up 4"), noted but
  not implemented: "actively holding a shield to protect a DPS-race
  advantage when the opponent is low and being farmed down." This ticket's
  spec is the orchestrator's judgment call on what that means mechanically
  (document your interpretation in your PROGRESS.md entry so it can be
  corrected if wrong): a shield can ALSO be declined — independent of
  `canTankAndAnswer` — when the DEFENDER doesn't need to answer with its
  OWN charged move to win this exchange, because the ATTACKER is already
  losing the DPS race. Concretely, OR a second condition into the existing
  `canTankAndAnswer(...)` check inside `ai.decideShield`:
  1. `incoming.damage <= defender.stats.hp * MAX_TANKABLE_HP_FRACTION` —
     same ceiling `canTankAndAnswer` already enforces; a >50%-bar hit is
     never held for this reason either.
  2. `defender.hp - incoming.damage > 0` — must actually survive this hit.
  3. `beingFarmedDown(attacker, defender)` is true. The exported
     `beingFarmedDown` helper (L455) already answers "does `poke` faint
     from `opponent`'s fast-move chip before `poke` can throw its own
     charged move again." Called as `beingFarmedDown(attacker, defender)`
     it answers whether the ATTACKER is the one about to be farmed down by
     the DEFENDER's own fast move — i.e. the defender is winning the DPS
     race and doesn't need this particular charged move blocked to win the
     exchange, so the shield is worth more held for later.
  Suggested shape: a small new helper (e.g. `winningDpsRace(defender,
  attacker, incoming)`) returning the AND of those three, exported next to
  `canTankAndAnswer` with this file's existing doc-comment style (why, not
  what); `wrapShieldBanking`'s decline test becomes `canTankAndAnswer(...)
  || winningDpsRace(...)`.
  **Tests (`test/teamBattle.test.js`):** new cases for the helper —
  attacker being farmed down + defender survives + under the ceiling ->
  holds; attacker healthy (not farmed down) -> no change from today's
  behavior; incoming damage over the ceiling even with attacker farmed
  down -> still shields; defender would NOT survive the hit -> still
  shields (this reason never turns a fatal hit into a decline). Plus at
  least one `wrapShieldBanking`-level integration test exercising the new
  OR branch end-to-end (mirrors the existing last-Pokemon / behind-on-
  bodies tests already in that describe block).
  **Verify:** `node --test test/teamBattle.test.js` clean, then
  `npm run test:full` clean (ticket-closing verify per standing rule 8) —
  both FOREGROUND with an explicit generous timeout. Append a PROGRESS.md
  entry: what was built, the interpretation call made, verify results, and
  — only if fire budget allows, not required to check the box — a small
  before/after decline-count sample. Commit + push to main; check this box
  and move the ticket block to GOALS_ARCHIVE.md in the same commit.

(Revived 2026-08-25 by Jaxon for T32, after the queue emptied 2026-08-24.
Trigger cadence stays `43 */4 * * *`; raise toward hourly only for a
genuinely full queue. If T32 lands cleanly with fire budget left over, pull
the next item from ROADMAP.md's known-gaps list rather than idling.)
