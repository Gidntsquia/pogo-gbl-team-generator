# ROADMAP — the why

**North star:** Jaxon feeds in a CSV of their actual Pokemon; the tool tells them the best Great League (CP ≤ 1500) teams of 3 they can field, validated by pvpoke's real battle engine running full **3v3 team battles** against the current meta — not eyeballed rankings, not hand-waved coverage scores.

**Definition of done (MVP):** `node src/cli.js their-export.csv` produces a ranked report of teams with team-battle win rates vs meta teams, best leads, and hardest matchups — end-to-end green tests, README a stranger could follow.

## Known gaps / backlog (pull from here when GOALS.md empties) — dated 2026-08-20
- **Best Buddy detection**: Poke Genie exports carry no Best Buddy column, so level-51 eligibility is invisible; importer recognizes a `Best Buddy` column opportunistically. Gap: document a manual override (e.g. generic-CSV bestbuddy column or a flags file).
- **Current-moves mode**: rank using each mon's actual TM state instead of recommended movesets (Poke Genie has move columns; reliability was the reason this was deferred).
- **Shield-scenario weighting review**: 0.25/0.50/0.25 for the 1v1 matrix was a judgment call; revisit once 3v3 results exist to compare against.
- ~~**HTML report** (nicer than out/report.md)~~ — done (GOALS T16, 2026-08-21): `out/report.html` written by default alongside `out/report.md`. A published status/report page (hosting it somewhere, auto-refresh, etc.) is still open if wanted later.
- **--cp 2500 / Ultra League flag** (engine already parameterizes the cap internally; expose it end-to-end).
- **Usage-weighted meta**: absorbed into the sampling initiative (GOALS T9–T12, 2026-08-21) — usage weights now power both opponent- and candidate-team sampling.
- **Safe-swap analysis**: per recommended team, which member is the safest first switch.
- **TrainingAI variance study**: if T2 pinned RNG, quantify how much AI randomness moves team rankings (repeat-run confidence intervals).
- **Vendor refresh discipline**: bump the pvpoke pin on a cadence (meta shifts each season); re-run T0 validation after any bump.
