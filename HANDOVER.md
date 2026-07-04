# Agent Handover Notes

Status notes for whoever (human or agent) works on this repo next.
Last updated: 2026-07-04.

## Current state

- Fork: `novakai-one/villani-flight-recorder` (origin). Upstream: `mmprotest/villani-flight-recorder`.
- PR #1 (cost estimation + subagent rollup in the session browser) — merged 2026-07-03.
- PR #2 (replay/browser stat reconciliation — the commit adding this file) — merged 2026-07-04.
- `vfr analyze` (fleet cost-driver report + per-session inefficiency deep dive, `src/analyze/analyze.ts`) — merged directly to main 2026-07-04, no PR (a PR was mistakenly opened against upstream as mmprotest#27 and closed unmerged). Fleet view is index-only; `--id` re-parses one transcript. Verified against the real index: fleet totals reconcile exactly with summed session records, and `--id` cost matches the stored `costUsd` to the digit. Heuristic thresholds are named constants at the top of `analyze.ts`, eyeballed — tune from real fleets.
- Context-contribution attribution in `vfr analyze --id` (see section below) — committed to main 2026-07-04, same day, after user feedback that the fleet report wasn't actionable. Same commit gates the fleet output-cost-share flag behind `OUTPUT_COST_FLAG_MIN_USD` ($5): it previously fired on ~50 cheap sessions and was pure noise.
- Test suite: vitest, 83 tests across 20 files, all green as of this commit. Gates: `npm run typecheck`, `npm test`, `npm run build`.
- `dist/` is committed. Always run `npm run build` before committing; the `vfr` CLI executes `dist/cli.js`, not `src/`.

## Token/cost architecture — single source of truth

The scan pipeline is authoritative for token/cost numbers:

- `vfr scan` parses transcripts and stores `tokenCount` / `inputTokenCount` / `outputTokenCount` / `cacheTokenCount` / `costUsd` on each index record (`src/index/sessionIndex.ts`).
- `SessionRecord` also stores the cache split as `cacheCreationTokenCount` / `cacheReadTokenCount` (used by `vfr analyze`); pre-existing index entries need `vfr scan --rebuild` to backfill them.
- The session browser reads those stored fields and adds a subagent roll-up via `subagentRollup()` in `src/index/subagents.ts`.
- The replay renderer receives the same stored stats as `IndexSessionStats`, threaded `cli.ts → renderReplay → renderDashboard → deriveReplayViewModel → deriveMetrics`. The live `sumTokenUsage`/`estimateCost` recompute is a **fallback only** (used when index fields are undefined, and for `--segment`/sliced replays where whole-session totals would misreport).

Do not reintroduce independent recomputation in a render path. That was the original bug: browser and replay computed the same numbers from different sources and contradicted each other.

## Context-contribution attribution (`vfr analyze --id`)

The user's actual question was "that early call pulled in 50k tokens — what did
it cost over the life of the session?" `contextContributions()` in
`src/analyze/analyze.ts` answers it:

- **Model.** Each API call's `inputTokens + cacheCreationTokens` is context that
  is new at that call. Its lifetime cost = ingest (input/cache-write at list
  rates) + carry (those tokens cache-read by every subsequent call). Attribution
  is per-session by design: context never crosses sessions, so a project's
  number is just the sum of its sessions.
- **Carry is scaled, not naive.** The naive full-carry model over-attributed
  152% on a real 296-call session: the prompt cache's 5-min TTL means idle gaps
  expire and re-write the same tokens (Σ written 593k vs peak context 419k), so
  "added tokens" double-count. The carry term is therefore scaled so total
  modeled reads equal the session's **actual** cache-read spend. One global
  scale per session (`ponytail:` comment marks per-model scaling as the upgrade
  if mixed-model drift ever matters).
- **Self-auditing.** After scaling, Σ lifetime over ALL contributions equals
  actual context cost (input + cacheWrite + cacheRead) exactly; the CLI prints a
  reconciliation line — `contributions $X vs actual context cost $X (100%
  reconciled); output $Y → session total $Z` — on every `--id` run. Verified on
  vfr_sess_d8d94dc2df53: $84.22 + $9.59 = $93.81, matching stored `costUsd`.
- **Labels are best-effort, tokens are exact.** A contribution is labeled with
  the largest tool-output event since the previous API call; token counts come
  straight from usage records. Top `TOP_CONTRIBUTIONS` (10) shown.

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
- `vfr analyze` cuts made for scope (add only if asked): Codex/Pi pricing (their parsers don't set per-event `model`; sessions show tokens but are flagged unpriced), any HTML/browser surface for the analysis, cross-session rollup of contributions per project ("this file re-ingested in N sessions cost $X total" — needs re-parsing every transcript in the project).
