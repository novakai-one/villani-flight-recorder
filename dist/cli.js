#!/usr/bin/env node
import { Command } from "commander";
import { findSessions, chooseLatest } from "./scanners/findSessions.js";
import { parseClaudeSession } from "./providers/claude.js";
import { parseCodexSession } from "./providers/codex.js";
import { parsePiSession } from "./providers/pi.js";
import { parseGeneric } from "./providers/generic.js";
import { renderReplay } from "./render/renderReplay.js";
import { subagentRollup } from "./index/subagents.js";
import { openBrowser } from "./utils/openBrowser.js";
import { buildGitReplay } from "./git/gitReplay.js";
import { installHooks, appendHook } from "./hooks/installHooks.js";
import { scanToIndex } from "./index/sessionIndex.js";
import { readIndex, defaultIndexDir } from "./index/sessionStore.js";
import { renderSessionBrowser } from "./render/sessionBrowser.js";
import { formatTokenCount } from "./providers/helpers/tokens.js";
import { formatUsd, shortModelName } from "./render/pricing.js";
import { analyzeFleet, analyzeSession } from "./analyze/analyze.js";
import { adaptersFor } from "./providers/providerAdapter.js";
import fs from "node:fs/promises";
import path from "node:path";
const program = new Command();
program
    .name("villani-flight-recorder")
    .description("Black box recorder for AI coding agents\n\nCommon workflow:\n  vfr scan\n  vfr browse\n  vfr replay --id <session-id>")
    .version("0.1.0");
const RENDERER_VERSION = "0.1.0-index-stats-v3";
async function readManifest(replayDir) {
    try {
        return JSON.parse(await fs.readFile(path.join(replayDir, "manifest.json"), "utf8"));
    }
    catch {
        return { version: 1, entries: [] };
    }
}
async function writeManifest(replayDir, manifest) {
    await fs.writeFile(path.join(replayDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}
function indexStatsFor(rec, sessions) {
    return {
        tokenCount: rec.tokenCount,
        inputTokenCount: rec.inputTokenCount,
        outputTokenCount: rec.outputTokenCount,
        cacheTokenCount: rec.cacheTokenCount,
        reasoningTokenCount: rec.reasoningTokenCount,
        costUsd: rec.costUsd,
        model: rec.model,
        subagents: subagentRollup(rec, sessions),
    };
}
async function prepareReplayCache(idx, opts) {
    const replayDir = path.join(opts.base, "replays");
    await fs.mkdir(replayDir, { recursive: true });
    const manifest = await readManifest(replayDir);
    const byId = new Map(manifest.entries.map((e) => [e.sessionId, e]));
    let reused = 0, generated = 0, skipped = 0;
    const next = [];
    const returnHref = path.relative(replayDir, opts.out) || path.basename(opts.out);
    opts.progress?.("Preparing replay cache...");
    for (const s of idx.sessions) {
        const replayPath = path.join(replayDir, `${s.id}.html`);
        const old = byId.get(s.id);
        const reusable = !opts.rebuild &&
            old &&
            old.sourceHash === s.sourceHash &&
            old.rendererVersion === RENDERER_VERSION &&
            (await fs
                .stat(replayPath)
                .then(() => true)
                .catch(() => false));
        if (reusable) {
            reused++;
            next.push(old);
            continue;
        }
        const ad = adaptersFor(String(s.provider))[0];
        if (!ad) {
            skipped++;
            continue;
        }
        try {
            const parsed = await ad.parse({
                provider: s.provider,
                sourcePath: s.sourcePath,
                sourceKind: "file",
                confidence: s.confidence,
                reason: "browser replay",
            });
            await renderReplay(parsed, {
                out: replayPath,
                returnHref,
                returnLabel: "Back to sessions",
                indexStats: indexStatsFor(s, idx.sessions),
            });
            generated++;
            next.push({
                sessionId: s.id,
                sourcePath: s.sourcePath,
                sourceHash: s.sourceHash ?? "",
                replayPath,
                generatedAt: new Date().toISOString(),
                rendererVersion: RENDERER_VERSION,
            });
        }
        catch {
            skipped++;
        }
    }
    await writeManifest(replayDir, { version: 1, entries: next });
    return { replayDir, reused, generated, skipped };
}
function scanProgress(json, quiet) {
    return json || quiet ? undefined : (m) => console.error(m);
}
async function openFile(file) {
    openBrowser(file);
}
program
    .command("scan")
    .description("Scans known Claude, Codex, and Pi session directories by default. Use --root to scan a custom directory.")
    .option("--all")
    .option("--agent <agent>")
    .option("--provider <provider>")
    .option("--root <path>", "session root", (v, p) => [...(p ?? []), v], [])
    .option("--since <date>")
    .option("--limit <n>")
    .option("--json")
    .option("--index-dir <path>")
    .option("--verbose")
    .option("--quiet")
    .option("--rebuild")
    .action(async (o) => {
    const progress = scanProgress(o.json, o.quiet);
    progress?.("Scanning local sessions...");
    const result = await scanToIndex({
        agent: o.agent ?? o.provider,
        all: o.all,
        roots: o.root?.length ? o.root : undefined,
        limit: o.limit ? Number(o.limit) : undefined,
        indexDir: o.indexDir,
        rebuild: o.rebuild,
        progress: (e) => {
            if (e.stage === "discover")
                progress?.(e.message);
            else if (e.stage === "metadata-check" || e.stage === "summary")
                progress?.(e.message);
            else if (e.stage === "parse") {
                if (e.message)
                    progress?.(e.message);
                else
                    progress?.(`Parsed ${e.current} / ${e.total}`);
            }
            else if (e.stage === "write-index")
                progress?.(e.message);
        },
    });
    const failedCommands = result.index.sessions.reduce((n, s) => n + s.failedCommandCount, 0);
    const summary = {
        sessions: result.index.sessions.length,
        taskSegments: result.index.taskSegments.length,
        repos: result.index.repos.length,
        failedCommands,
        warnings: result.index.warnings.length +
            result.index.sessions.reduce((n, s) => n + s.warningCount, 0),
        indexPath: result.indexPath,
    };
    if (o.json)
        return console.log(JSON.stringify(summary, null, 2));
    console.log("Villani Flight Recorder scan complete\n");
    console.log("Providers scanned:");
    for (const [k, v] of Object.entries(result.counts))
        console.log(`- ${k}: ${v} sessions`);
    console.log("\nIndexed:");
    console.log(`- ${summary.sessions} sessions`);
    console.log(`- ${summary.taskSegments} likely task segments`);
    console.log(`- ${summary.repos} repos`);
    console.log(`- ${summary.failedCommands} failed commands`);
    console.log(`- ${summary.warnings} recorder warnings`);
    console.log("\nNext:\n  vfr sessions\n  vfr browse\n  vfr replay --id <session-id>");
});
async function parse(provider, file) {
    if (provider === "claude")
        return parseClaudeSession(file);
    if (provider === "codex")
        return parseCodexSession(file);
    if (provider === "pi")
        return parsePiSession(file);
    return parseGeneric("unknown", file);
}
function projectMatches(s, q) {
    if (!q)
        return true;
    const vals = [
        s.projectDisplayName,
        s.projectName,
        s.projectPath,
        s.projectRoot,
        s.projectId,
        ...(s.repoRoots ?? []),
        ...(s.repoIds ?? []),
    ].filter(Boolean);
    return vals.some((v) => v.toLowerCase().includes(String(q).toLowerCase()));
}
function repoMatches(values, q) {
    if (!q)
        return true;
    const r = path.resolve(q);
    return values.some((v) => v === q || path.resolve(v) === r || v.includes(q));
}
async function requireIndex(dir) {
    const idx = await readIndex(dir);
    if (!idx) {
        console.log("No session index found. Run: vfr scan --all");
        return null;
    }
    return idx;
}
program
    .command("sessions")
    .option("--agent <agent>")
    .option("--provider <provider>")
    .option("--repo <repo>")
    .option("--project <name>")
    .option("--failed")
    .option("--limit <n>")
    .option("--json")
    .option("--index-dir <path>")
    .action(async (o) => {
    const idx = await requireIndex(o.indexDir);
    if (!idx)
        return;
    let rows = idx.sessions
        .filter((s) => (!o.agent || s.provider === o.agent) &&
        (!o.provider || s.provider === o.provider) &&
        (!o.failed || s.outcome === "failed" || s.failedCommandCount > 0) &&
        (!o.project || projectMatches(s, o.project)) &&
        repoMatches([...s.repoRoots, ...s.repoIds], o.repo))
        .sort((a, b) => String(b.updatedAt ?? b.lastEventAt ?? "").localeCompare(String(a.updatedAt ?? a.lastEventAt ?? "")))
        .slice(0, o.limit ? Number(o.limit) : 20);
    if (o.json)
        return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length)
        return console.log("No sessions indexed yet. Run `vfr scan` to index local agent sessions.");
    console.log("ID                 Agent   Outcome  Project              Updated               Events  Failed  Tokens   Title / First Prompt");
    for (const s of rows) {
        const project = (s.projectDisplayName ??
            s.projectName ??
            idx.repos.find((r) => s.repoIds.includes(r.id))?.name ??
            "-").slice(0, 20);
        const title = (s.title ?? s.firstPrompt ?? "-")
            .replace(/\s+/g, " ")
            .slice(0, 60);
        console.log(`${s.id.padEnd(18)} ${String(s.provider).padEnd(7)} ${String(s.outcome ?? "unknown").padEnd(8)} ${project.padEnd(20)} ${String(s.updatedAt ?? s.lastEventAt ?? "-").padEnd(20)} ${String(s.eventCount).padEnd(7)} ${String(s.failedCommandCount).padEnd(7)} ${formatTokenCount(s.tokenCount).padEnd(8)} ${title}`);
    }
});
program
    .command("tasks")
    .option("--session <session>")
    .option("--agent <agent>")
    .option("--provider <provider>")
    .option("--repo <repo>")
    .option("--project <name>")
    .option("--failed")
    .option("--limit <n>")
    .option("--json")
    .option("--index-dir <path>")
    .action(async (o) => {
    const idx = await requireIndex(o.indexDir);
    if (!idx)
        return;
    let rows = idx.taskSegments
        .filter((t) => (!o.session || t.sessionId === o.session) &&
        (!o.agent || t.provider === o.agent) &&
        repoMatches([...t.repoRoots, ...t.repoIds], o.repo))
        .sort((a, b) => String(b.lastEventAt ?? "").localeCompare(String(a.lastEventAt ?? "")))
        .slice(0, o.limit ? Number(o.limit) : 20);
    if (o.json)
        return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length)
        return console.log("No task segments found. Run: vfr scan --all");
    console.log("Likely task segments\n");
    rows.forEach((t, i) => {
        const repo = idx.repos.find((r) => t.repoIds.includes(r.id));
        console.log(`${i + 1}. ${t.id}\n   Title: ${t.title}\n   Agent: ${t.provider}\n   Repo: ${repo?.name ?? "Task unavailable"}\n   Events: ${t.eventCount}\n   Failed commands: ${t.failedCommandCount}\n   Boundary: ${t.boundaryReason}\n   Time: ${t.firstEventAt ?? "Duration unavailable"} to ${t.lastEventAt ?? "Duration unavailable"}\n`);
    });
});
program
    .command("analyze")
    .description("Fleet cost drivers from the session index, or a per-session inefficiency report with --id.")
    .option("--id <session-id>")
    .option("--project <name>")
    .option("--limit <n>")
    .option("--json")
    .option("--index-dir <path>")
    .action(async (o) => {
    const idx = await requireIndex(o.indexDir);
    if (!idx)
        return;
    const pct = (r) => r === undefined ? "—" : `${Math.round(r * 100)}%`;
    if (o.id) {
        const rec = idx.sessions.find((s) => s.id === o.id);
        if (!rec)
            throw new Error("analyze --id did not match any indexed session. Run: vfr sessions");
        const ad = adaptersFor(String(rec.provider))[0];
        const parsed = await ad.parse({
            provider: rec.provider,
            sourcePath: rec.sourcePath,
            sourceKind: "file",
            confidence: rec.confidence,
            reason: "session analysis",
        });
        const r = analyzeSession(rec, parsed.events);
        if (o.json)
            return console.log(JSON.stringify(r, null, 2));
        console.log(`Session ${r.id}\n`);
        console.log("Model             Input    Output   CacheW   CacheR   Cost");
        for (const m of r.cost.perModel)
            console.log(`${shortModelName(m.model).padEnd(17)} ${formatTokenCount(m.tokens.inputTokens).padEnd(8)} ${formatTokenCount(m.tokens.outputTokens).padEnd(8)} ${formatTokenCount(m.tokens.cacheCreationTokens).padEnd(8)} ${formatTokenCount(m.tokens.cacheReadTokens).padEnd(8)} ${formatUsd(m.usd)}`);
        console.log(`Total estimated cost: ${formatUsd(r.cost.totalUsd)}`);
        if (r.cost.unknownModels.length)
            console.log(`Unpriced models: ${r.cost.unknownModels.join(", ")}`);
        console.log(`Cache hit ratio: ${pct(r.cacheHitRatio)}`);
        console.log(`Context curve: ${r.contextCurve.turns} turns · first ${formatTokenCount(r.contextCurve.firstTokens)} · peak ${formatTokenCount(r.contextCurve.peakTokens)} · final ${formatTokenCount(r.contextCurve.finalTokens)}`);
        if (r.topToolOutputs.length) {
            console.log("\nTop tool outputs:");
            for (const t of r.topToolOutputs)
                console.log(`- #${t.eventIndex} ${t.type} ${t.title.replace(/\s+/g, " ").slice(0, 60)} — ${t.chars} chars (~${formatTokenCount(t.approxTokens)} tokens)`);
        }
        if (r.flags.length) {
            console.log("\nFlags:");
            for (const f of r.flags)
                console.log(`- ${f.message}`);
        }
        return;
    }
    const rows = idx.sessions.filter((s) => projectMatches(s, o.project));
    const r = analyzeFleet(rows, {
        top: o.limit ? Number(o.limit) : undefined,
    });
    if (o.json)
        return console.log(JSON.stringify(r, null, 2));
    if (!rows.length)
        return console.log("No sessions indexed yet. Run `vfr scan` to index local agent sessions.");
    console.log("Fleet cost analysis\n");
    console.log(`Sessions: ${r.totals.sessions} (${r.totals.pricedSessions} priced, ${r.totals.unpricedSessions} unpriced)`);
    console.log(`Total estimated cost: ${formatUsd(r.totals.totalCostUsd)}`);
    console.log(`Tokens: input ${formatTokenCount(r.totals.tokens.input)} · output ${formatTokenCount(r.totals.tokens.output)} · cache write ${formatTokenCount(r.totals.tokens.cacheCreation)} · cache read ${formatTokenCount(r.totals.tokens.cacheRead)}`);
    if (r.costByClass)
        console.log(`Cost by class (approx, ${r.costByClass.coveredSessions} sessions): input ${formatUsd(r.costByClass.inputUsd)} · output ${formatUsd(r.costByClass.outputUsd)} · cache write ${formatUsd(r.costByClass.cacheWriteUsd)} · cache read ${formatUsd(r.costByClass.cacheReadUsd)}`);
    console.log("\nTop sessions by cost");
    console.log("ID                 Project              Cost     CacheHit  Tokens   Model");
    for (const s of r.topSessions)
        console.log(`${s.id.padEnd(18)} ${s.project.slice(0, 20).padEnd(20)} ${(s.unpriced ? "—" : formatUsd(s.costUsd ?? 0)).padEnd(8)} ${pct(s.cacheHitRatio).padEnd(9)} ${formatTokenCount(s.tokenCount).padEnd(8)} ${s.model ? shortModelName(s.model) : "-"}`);
    console.log("\nTop projects by cost");
    console.log("Project              Sessions  Cost     Tokens");
    for (const p of r.topProjects)
        console.log(`${p.project.slice(0, 20).padEnd(20)} ${String(p.sessions).padEnd(9)} ${formatUsd(p.costUsd).padEnd(8)} ${formatTokenCount(p.tokenCount)}`);
    console.log(`\nTop ${r.concentration.topN} sessions carry ${pct(r.concentration.shareOfTotal)} of fleet cost.`);
    console.log(`Subagents: ${r.subagents.sessionCount} sessions, ${formatUsd(r.subagents.costUsd)} (${pct(r.subagents.shareOfTotal)} of fleet cost).`);
    if (r.flags.length) {
        console.log("\nFlags:");
        for (const f of r.flags)
            console.log(`- ${f.message}`);
    }
    if (r.totals.missingCacheSplit > 0)
        console.log(`\n${r.totals.missingCacheSplit} sessions lack a cache read/write split. Run: vfr scan --rebuild`);
    if (r.totals.unpricedSessions > 0)
        console.log(`${r.totals.unpricedSessions} sessions (codex/pi/unknown) unpriced: ${formatTokenCount(r.totals.unpricedTokenCount)} tokens.`);
});
program
    .command("browse")
    .description("Generates a local HTML session browser from the indexed sessions.")
    .option("--out <path>")
    .option("--index-dir <path>")
    .option("--open")
    .option("--rebuild")
    .option("--quiet")
    .action(async (o) => {
    const idx = await requireIndex(o.indexDir);
    if (!idx)
        return;
    const base = o.indexDir ?? defaultIndexDir();
    const out = o.out ?? path.join(base, "session-browser.html");
    const progress = o.quiet ? undefined : (m) => console.error(m);
    progress?.(`Reading index: ${idx.sessions.length} sessions.`);
    const cache = await prepareReplayCache(idx, {
        base,
        out,
        rebuild: o.rebuild,
        progress,
    });
    progress?.(`Reused ${cache.reused} replay files.`);
    progress?.(`Generated ${cache.generated} replay files.`);
    progress?.(`Skipped ${cache.skipped} failed replay generations.`);
    progress?.("Writing session browser...");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, renderSessionBrowser(idx, {
        replayDir: cache.replayDir,
        browserOut: out,
    }));
    console.log(`Session browser written to ${out}`);
    console.log("Open it in your browser.");
    if (o.open)
        openBrowser(out);
});
program
    .command("launch")
    .description("Scan sessions, refresh replay cache, generate the session browser, and open it.")
    .option("--provider <provider>")
    .option("--agent <agent>")
    .option("--all")
    .option("--root <path>", "session root", (v, p) => [...(p ?? []), v], [])
    .option("--index-dir <path>")
    .option("--out <path>")
    .option("--no-open")
    .option("--rebuild")
    .action(async (o) => {
    console.error("Villani Flight Recorder launch\n");
    console.error("Scanning local sessions...");
    const result = await scanToIndex({
        agent: o.agent ?? o.provider,
        all: o.all,
        roots: o.root?.length ? o.root : undefined,
        indexDir: o.indexDir,
        rebuild: o.rebuild,
        progress: (e) => {
            if (e.stage === "discover")
                console.error(e.message);
            else if (e.stage === "metadata-check" || e.stage === "summary")
                console.error(e.message);
            else if (e.stage === "parse") {
                if (e.message)
                    console.error(e.message);
                else
                    console.error(`Parsed ${e.current} / ${e.total}`);
            }
            else if (e.stage === "write-index")
                console.error(e.message);
        },
    });
    console.error(`Skipped ${result.skippedUnchanged} unchanged sessions.`);
    console.error(`Parsed ${result.parsedNew + result.parsedChanged} new or changed sessions.`);
    console.error(`Indexed ${result.index.sessions.length} sessions.`);
    const base = o.indexDir ?? defaultIndexDir();
    const out = o.out ?? path.join(base, "session-browser.html");
    console.error("\nPreparing session browser...");
    const cache = await prepareReplayCache(result.index, {
        base,
        out,
        rebuild: o.rebuild,
        progress: (m) => console.error(m),
    });
    console.error(`Reused ${cache.reused} replay files.`);
    console.error(`Generated ${cache.generated} replay files.`);
    if (cache.skipped)
        console.error(`Skipped ${cache.skipped} failed replay generations.`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, renderSessionBrowser(result.index, {
        replayDir: cache.replayDir,
        browserOut: out,
    }));
    console.log(`Session browser written to ${out}`);
    if (o.open) {
        console.error("Opening browser...");
        await openFile(out);
    }
});
program
    .command("open")
    .option("--out <path>")
    .option("--index-dir <path>")
    .action(async (o) => {
    const idx = await requireIndex(o.indexDir);
    if (!idx)
        return;
    const out = o.out ?? path.resolve("villani-flight-recorder-index.html");
    const html = `<!doctype html><meta charset="utf-8"><title>Villani Flight Recorder Index</title><style>body{font-family:system-ui;margin:2rem;line-height:1.45}code{background:#eef;padding:.15rem .3rem;border-radius:4px}</style><h1>Villani Flight Recorder</h1><p>${idx.sessions.length} sessions · ${idx.taskSegments.length} task segments · ${idx.repos.length} repos · ${idx.sessions.reduce((n, s) => n + s.failedCommandCount, 0)} failed commands</p><h2>Recent sessions</h2><ul>${idx.sessions.map((s) => `<li><b>${s.id}</b> ${s.providerLabel} <code>vfr replay --session ${s.id}</code></li>`).join("")}</ul><h2>Likely task segments</h2><ul>${idx.taskSegments.map((t) => `<li><b>${t.title}</b> ${t.id} <code>vfr replay --segment ${t.id}</code></li>`).join("")}</ul><h2>Repos</h2><ul>${idx.repos.map((r) => `<li><b>${r.name}</b> ${r.root} <code>vfr replay --repo ${r.root}</code></li>`).join("")}</ul>`;
    await fs.writeFile(out, html);
    console.log(`Session browser generated:\n${out}\n\nOpen this file in your browser.`);
});
program
    .command("replay")
    .option("--latest")
    .option("--open")
    .option("--provider <provider>")
    .option("--session <path>")
    .option("--id <session-id>")
    .option("--segment <segment>")
    .option("--repo <repo>")
    .option("--index-dir <path>")
    .option("--root <path>")
    .option("--out <path>")
    .option("--no-redact")
    .option("--redact")
    .action(async (o) => {
    if (!o.latest && !o.session && !o.id && !o.segment && !o.repo)
        throw new Error("replay requires --latest, --id <session-id>, --session <path-or-id>, --segment <id>, or --repo <path-or-id>");
    let session;
    let selectedSessionId;
    let selectedSegmentId;
    let indexStats;
    if (o.id ||
        o.segment ||
        o.repo ||
        (o.latest && !o.root) ||
        (o.session &&
            !o.session.includes(path.sep) &&
            !o.session.endsWith(".jsonl") &&
            !o.session.endsWith(".json"))) {
        const idx = await readIndex(o.indexDir);
        if (!idx) {
            console.log("No session index found. Run: vfr scan --all");
            return;
        }
        let seg = o.segment
            ? idx.taskSegments.find((t) => t.id === o.segment)
            : undefined;
        if (!seg && o.repo)
            seg = idx.taskSegments
                .filter((t) => repoMatches([...t.repoRoots, ...t.repoIds], o.repo))
                .sort((a, b) => String(b.lastEventAt ?? "").localeCompare(String(a.lastEventAt ?? "")))[0];
        if (!seg && o.latest)
            seg = idx.taskSegments
                .filter((t) => (!o.provider || t.provider === o.provider) &&
                repoMatches([...t.repoRoots, ...t.repoIds], o.repo))
                .sort((a, b) => String(b.lastEventAt ?? "").localeCompare(String(a.lastEventAt ?? "")))[0];
        const rec = o.id
            ? idx.sessions.find((s) => s.id === o.id)
            : o.session
                ? idx.sessions.find((s) => s.id === o.session)
                : idx.sessions.find((s) => s.id === seg?.sessionId);
        if (!rec && !seg)
            throw new Error("Replay selector did not match any indexed session or segment. Run: vfr sessions or vfr tasks");
        const srec = rec ?? idx.sessions.find((s) => s.id === seg.sessionId);
        const ad = adaptersFor(String(srec.provider))[0];
        session = (await ad.parse({
            provider: srec.provider,
            sourcePath: srec.sourcePath,
            sourceKind: "file",
            confidence: srec.confidence,
            reason: "indexed replay",
        }));
        selectedSessionId = srec.id;
        selectedSegmentId = seg?.id;
        if (seg)
            session.events = session.events.slice(seg.startEventIndex, seg.endEventIndex + 1);
        // Stored index totals cover the whole session, so only use them when
        // replaying the full session, not a task-segment slice.
        else
            indexStats = indexStatsFor(srec, idx.sessions);
    }
    else if (o.session) {
        if (!o.provider) {
            for (const pr of ["claude", "codex", "pi"]) {
                try {
                    session = await parse(pr, o.session);
                    break;
                }
                catch { }
            }
            if (!session)
                console.warn("Warning: Provider could not be confidently detected. Re-run with --provider claude, --provider codex, or --provider pi for best results.");
        }
        session =
            session ??
                (await parse((o.provider ?? "unknown"), o.session));
    }
    else {
        const roots = o.root ? [o.root] : undefined;
        const picked = chooseLatest(await findSessions({ provider: o.provider, roots }));
        if (!picked.candidate)
            throw new Error(`No ${o.provider ?? "supported"} sessions found under ${o.root ?? "default session roots"}.`);
        if (picked.uncertain)
            console.warn("Warning: repo matching was uncertain; selected most recently modified session.");
        session = await parse(picked.candidate.provider, picked.candidate.path);
    }
    const file = await renderReplay(session, {
        redact: o.redact !== false,
        indexStats,
        out: o.out ??
            (selectedSessionId && !selectedSegmentId
                ? path.join(o.indexDir ?? defaultIndexDir(), "replays", `${selectedSessionId}.html`)
                : undefined),
        returnHref: selectedSessionId
            ? path.relative(path.dirname(o.out ??
                path.join(o.indexDir ?? defaultIndexDir(), "replays", `${selectedSessionId}.html`)), path.join(o.indexDir ?? defaultIndexDir(), "session-browser.html"))
            : undefined,
        returnLabel: selectedSessionId ? "Back to sessions" : undefined,
    });
    if (o.latest) {
        console.log(`Provider: ${session.provider}`);
        console.log(`Root searched: ${o.root ?? "default session roots"}`);
        console.log(`Selected session: ${session.path ?? session.sessionPath ?? "unknown"}`);
        console.log(`Replay written: ${file}`);
    }
    else {
        if (selectedSessionId || selectedSegmentId)
            console.log(`Replay written to ${file}\nOpen it in your browser.`);
        else
            console.log(file);
    }
    if (o.open)
        openBrowser(file);
});
async function assertGitRepo(repo) {
    const stat = await fs.stat(repo).catch(() => null);
    if (!stat?.isDirectory())
        throw new Error(`git-replay --repo path is not a directory: ${repo}`);
    const gitDir = await fs.stat(path.join(repo, ".git")).catch(() => null);
    if (!gitDir)
        throw new Error(`git-replay --repo path is not a git repository: ${repo}`);
}
program
    .command("git-replay")
    .requiredOption("--from <ref>")
    .requiredOption("--to <ref>")
    .option("--repo <path>")
    .option("--open")
    .option("--out <path>")
    .option("--no-redact")
    .action(async (o) => {
    const repo = path.resolve(o.repo ?? process.cwd());
    await assertGitRepo(repo);
    const file = await renderReplay(await buildGitReplay(o.from, o.to, repo), {
        cwd: repo,
        redact: o.redact !== false,
        out: o.out,
    });
    console.log(file);
    if (o.open)
        openBrowser(file);
});
program
    .command("install-hooks")
    .action(async () => console.log(`Hook snippets written. Manual installation is required. No Claude, Codex, or Pi config files were modified.\nSnippet file: ${await installHooks()}`));
program
    .command("hook")
    .argument("<provider>")
    .action(async (provider) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    for await (const c of process.stdin)
        data += c;
    console.log(await appendHook(provider, data));
});
program.parseAsync().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});
