# pogo-gbl-team-generator — conventions

Node ≥ 18, ESM (`"type": "module"`), plain modern JavaScript, no TypeScript, no build step. 2-space indent, small focused modules, JSDoc on exported functions.

- Tests: `node --test test/<file>.test.js` for one packet; `npm test` for everything. Test only with node's built-in `node:test` + `node:assert`.
- Dependencies: avoid adding npm deps unless clearly necessary; record any addition and why in your report.
- `vendor/pvpoke` is a pinned read-only sparse clone (gitignored). Load/execute its code and data; never edit it, never reimplement its battle math. Need a path not checked out? `git -C vendor/pvpoke sparse-checkout add <path>`.
- Interfaces between modules are defined in PLAN.md — follow them exactly; if one proves wrong, say so in your report rather than silently changing it.
- Workers: do NOT `git commit` (the orchestrator commits); keep your diff inside the files your packet owns.
- Output artifacts (reports, caches) go in `out/` (gitignored).
