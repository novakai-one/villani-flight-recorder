# Agent Handover Notes

Status notes for whoever (human or agent) works on this repo next.
Last updated: 2026-07-04.

## Current state

- Fork: `novakai-one/villani-flight-recorder` (origin). Upstream: `mmprotest/villani-flight-recorder`.
- PR #1 (cost estimation + subagent rollup in the session browser) — merged 2026-07-03.
- PR #2 (replay/browser stat reconciliation — the commit adding this file) — merged 2026-07-04.
- PR #3 (`vfr analyze` — fleet cost-driver report + per-session inefficiency deep dive, `src/analyze/analyze.ts`) — this commit. Fleet view is index-only; `--id` re-parses one transcript. Verified against the real index: fleet totals reconcile exactly with summed session records, and `--id` cost matches the stored `costUsd` to the digit. Heuristic thresholds are named constants at the top of `analyze.ts`, eyeballed — tune from real fleets.
- Test suite: vitest, 81 tests across 20 files, all green as of this commit. Gates: `npm run typecheck`, `npm test`, `npm run build`.
- `dist/` is committed. Always run `npm run build` before committing; the `vfr` CLI executes `dist/cli.js`, not `src/`.

## Token/cost architecture — single source of truth

The scan pipeline is authoritative for token/cost numbers:

- `vfr scan` parses transcripts and stores `tokenCount` / `inputTokenCount` / `outputTokenCount` / `cacheTokenCount` / `costUsd` on each index record (`src/index/sessionIndex.ts`).
- `SessionRecord` also stores the cache split as `cacheCreationTokenCount` / `cacheReadTokenCount` (used by `vfr analyze`); pre-existing index entries need `vfr scan --rebuild` to backfill them.
- The session browser reads those stored fields and adds a subagent roll-up via `subagentRollup()` in `src/index/subagents.ts`.
- The replay renderer receives the same stored stats as `IndexSessionStats`, threaded `cli.ts → renderReplay → renderDashboard → deriveReplayViewModel → deriveMetrics`. The live `sumTokenUsage`/`estimateCost` recompute is a **fallback only** (used when index fields are undefined, and for `--segment`/sliced replays where whole-session totals would misreport).

Do not reintroduce independent recomputation in a render path. That was the original bug: browser and replay computed the same numbers from different sources and contradicted each other.

## Gotchas that have already burned time

1. **Replay HTML cache.** Generated replays under `~/.villani-flight-recorder/replays/` are reused when `sourceHash` + `RENDERER_VERSION` match (`src/cli.ts`). If you change parser, pricing, or metrics logic, **bump `RENDERER_VERSION`** or users keep seeing stale numbers. Check `replays/manifest.json` → `entries[].rendererVersion` to confirm regeneration.
2. **Index entry reuse.** `vfr scan` reuses a session's prior index entry when the source file's size/mtime are unchanged (`src/index/sessionIndex.ts`). After parser changes, stored numbers can come from an older parser version — `vfr scan --rebuild` forces a full re-index.
3. **Claude streamed transcripts re-emit the same `message.id` once per content block**, each record carrying that API call's full usage. Summing naively inflates tokens/cost ~2×. The dedupe (keep last record per id) lives in `parseClaudeSession` (`src/providers/claude.ts`) — both scan and replay go through it. Keep it there.
4. **The replay "Git diff" tab shows the working tree's diff at render time**, not anything from the recorded session. Two consequences: (a) it's misleading to users; (b) when debugging, grepping generated replay HTML for old code strings matches your own uncommitted diff being _displayed_, not live code. This behavior is an open follow-up (below).
5. **`vfr replay --id` takes the internal `vfr_sess_*` id**, not the Claude session UUID.
6. There is (or was) a **second clone of this repo** inside an iCloud Obsidian folder (`.../plugin-sandbox/.obsidian/plugins/villani-flight-recorder`). The shell prompt shows the same folder name for both. Verify `pwd` / `git remote -v` before editing. The global `vfr` is npm-linked to **this** clone (`~/Programming/villani-flight-recorder`).

## Open follow-ups

- Replace the render-time git diff in replays with a session-scoped diff (or label it honestly as "current working tree", or drop the tab). See gotcha 4.
- Segment replays deliberately skip index stats and recompute live; if segment-level accuracy matters, consider per-segment token attribution at scan time.
- The scan reports ~120k "recorder warnings" across 315 sessions — never triaged.
- `vfr analyze` cuts made for scope (add only if asked): per-segment cost attribution, tool-output→next-turn cache-write correlation, Codex/Pi pricing (their parsers don't set per-event `model`; sessions show tokens but are flagged unpriced), any HTML/browser surface for the analysis.
