import fs from "node:fs/promises";
import path from "node:path";
import { deriveProjectIdentity } from "./projectIdentity.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adaptersFor } from "../providers/providerAdapter.js";
import { readIndex } from "./sessionStore.js";
import { sumTokenUsage } from "../providers/helpers/tokens.js";
import { estimateCost } from "../render/pricing.js";
import { segmentSession } from "./segmenter.js";
import { writeIndex } from "./sessionStore.js";
const exec = promisify(execFile);
const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const repoId = (r) => "vfr_repo_" + hash(path.resolve(r));
function cleanText(v) {
    const t = (v ?? "").replace(/\s+/g, " ").trim();
    if (!t || /^(unknown|generic|claude|codex|pi)$/i.test(t))
        return undefined;
    return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}
const titleFrom = (events) => {
    const firstPrompt = cleanText(events.find((e) => e.type === "user_message")?.summary);
    if (firstPrompt)
        return firstPrompt;
    const meaningful = events.find((e) => cleanText(e.summary))?.summary;
    if (cleanText(meaningful))
        return cleanText(meaningful);
    const first = events[0];
    if (first?.type === "unknown")
        return `Unknown event: ${first.raw && typeof first.raw === "object" && "type" in first.raw ? String(first.raw.type) : "unrecognized record"}`;
    return cleanText(first?.title) ?? "Untitled session";
};
function failureSummary(events) {
    const failed = events.filter((e) => (e.command && (e.exitCode ?? 0) !== 0) || e.type === "error");
    const first = failed.find((e) => e.command);
    if (first?.command) {
        const code = first.exitCode ?? 1;
        return `${first.command} failed with exit code ${code}`;
    }
    return failed.length
        ? `${failed.length} failed command${failed.length === 1 ? "" : "s"}`
        : undefined;
}
function durationMs(events, startedAt, endedAt) {
    const direct = events
        .map((e) => e.durationMs)
        .filter((n) => typeof n === "number");
    if (direct.length)
        return direct.reduce((a, b) => a + b, 0);
    if (startedAt && endedAt) {
        const ms = Date.parse(endedAt) - Date.parse(startedAt);
        if (Number.isFinite(ms) && ms >= 0)
            return ms;
    }
    return undefined;
}
function changedEventFiles(events) {
    return [
        ...new Set(events
            .filter((e) => ["file_write", "file_edit", "file_delete", "diff"].includes(e.type))
            .map((e) => e.path)
            .filter(Boolean)),
    ];
}
async function fp(file) {
    const st = await fs.stat(file);
    const buf = await fs.readFile(file);
    return {
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
        mtimeMs: st.mtimeMs,
        hash: hash(buf.toString("utf8")),
    };
}
function roots(events, cwd) {
    return [
        ...new Set([cwd, ...events.map((e) => e.cwd)]
            .filter(Boolean)
            .map((r) => path.resolve(r))),
    ];
}
async function gitMeta(root) {
    const run = async (a) => {
        try {
            return (await exec("git", ["-C", root, ...a])).stdout.trim();
        }
        catch {
            return undefined;
        }
    };
    return {
        root: (await run(["rev-parse", "--show-toplevel"])) || root,
        branch: await run(["branch", "--show-current"]),
        remote: await run(["remote", "get-url", "origin"]),
    };
}
export async function scanToIndex(opts) {
    const warnings = [];
    const sessions = [];
    const repos = new Map();
    const tasks = [];
    const counts = {};
    const adapters = adaptersFor(opts.agent, opts.all);
    opts.progress?.({
        stage: "discover",
        message: `Scanning ${opts.agent ?? "Claude/Codex/Pi"} session roots...`,
    });
    for (const ad of adapters)
        counts[ad.label] = 0;
    const discoveredByPath = new Map();
    if (opts.agent) {
        for (const ad of adapters) {
            const found = (await ad.discover({ roots: opts.roots, limit: opts.limit })).slice(0, opts.limit);
            for (const d of found)
                discoveredByPath.set(path.resolve(d.sourcePath), d);
        }
    }
    else {
        // Discover broadly once, then parse each file in provider order. This keeps
        // Generic as a true fallback and prevents provider-specific transcripts from
        // being indexed a second time as generic sessions.
        for (const ad of adapters) {
            const found = await ad.discover({ roots: opts.roots, limit: opts.limit });
            for (const d of found)
                discoveredByPath.set(path.resolve(d.sourcePath), d);
        }
    }
    const previous = await readIndex(opts.indexDir);
    const previousByPath = new Map(previous?.sessions.map((s) => [
        `${s.provider}:${path.resolve(s.sourcePath)}`,
        s,
    ]));
    const previousBySourcePath = new Map(previous?.sessions.map((s) => [path.resolve(s.sourcePath), s]));
    const discovered = [...discoveredByPath.values()].slice(0, opts.limit);
    opts.progress?.({
        stage: "discover",
        message: `Found ${discovered.length} candidate sessions.`,
    });
    opts.progress?.({
        stage: "discover",
        message: `Loaded existing index: ${previous?.sessions.length ?? 0} sessions.`,
    });
    opts.progress?.({
        stage: "metadata-check",
        message: "Checking file metadata...",
    });
    let skippedUnchanged = 0;
    let parsedNew = 0;
    let parsedChanged = 0;
    const discoveredKeys = new Set();
    const toParse = [];
    const reusedIds = new Set();
    for (const base of discovered) {
        const abs = path.resolve(base.sourcePath);
        const key = `${base.provider}:${abs}`;
        discoveredKeys.add(key);
        const prev = previousByPath.get(key) ?? previousBySourcePath.get(abs);
        const st = await fs.stat(abs).catch(() => undefined);
        const unchanged = !opts.rebuild &&
            prev &&
            st &&
            prev.sourceSize === st.size &&
            Math.abs((prev.sourceMtimeMs ?? 0) - st.mtimeMs) < 1;
        if (unchanged) {
            sessions.push({ ...prev, sourcePath: abs });
            reusedIds.add(prev.id);
            counts[prev.providerLabel] = (counts[prev.providerLabel] ?? 0) + 1;
            skippedUnchanged++;
        }
        else {
            toParse.push({ ...base, sourcePath: abs });
            if (prev)
                parsedChanged++;
            else
                parsedNew++;
        }
    }
    const removed = previous
        ? previous.sessions.filter((s) => !discoveredByPath.has(path.resolve(s.sourcePath))).length
        : 0;
    opts.progress?.({
        stage: "metadata-check",
        message: `Skipped ${skippedUnchanged} unchanged sessions.`,
        skipped: skippedUnchanged,
        parsedNew,
        parsedChanged,
        removed,
    });
    opts.progress?.({
        stage: "parse",
        message: `Parsing ${toParse.length} new or changed sessions...`,
        current: 0,
        total: toParse.length,
    });
    let parsedCount = 0;
    for (const base of toParse) {
        let indexed = false;
        const tryAdapters = opts.agent ? adapters : adaptersFor(undefined, true);
        for (const ad of tryAdapters) {
            if (indexed)
                break;
            try {
                const d = { ...base, provider: ad.id, reason: `${ad.id} candidate` };
                const parsed = await ad.parse(d);
                const fingerprint = await fp(d.sourcePath);
                const key = `${ad.id}:${path.resolve(d.sourcePath)}`;
                const sid = previousByPath.get(key)?.id ??
                    "vfr_sess_" +
                        hash(`${ad.id}:${path.resolve(d.sourcePath)}:${fingerprint.hash ?? `${fingerprint.modifiedAt}:${fingerprint.sizeBytes}`}`);
                const rs = roots(parsed.events, parsed.cwd);
                const repoIdsByRoot = new Map();
                for (const r0 of rs) {
                    const gm = await gitMeta(r0);
                    const id = repoId(gm.root);
                    repoIdsByRoot.set(r0, id);
                    const rec = repos.get(id) || {
                        id,
                        root: gm.root,
                        name: path.basename(gm.root),
                        remote: gm.remote,
                        branch: gm.branch,
                        sessionIds: [],
                        taskSegmentIds: [],
                    };
                    if (!rec.sessionIds.includes(sid))
                        rec.sessionIds.push(sid);
                    rec.lastEventAt = [rec.lastEventAt, parsed.events.at(-1)?.timestamp]
                        .filter(Boolean)
                        .sort()
                        .at(-1);
                    repos.set(id, rec);
                }
                const segs = segmentSession(sid, ad.id, parsed.events, repoIdsByRoot);
                for (const s of segs) {
                    tasks.push(s);
                    for (const rid of s.repoIds) {
                        const rr = repos.get(rid);
                        if (rr && !rr.taskSegmentIds.includes(s.id))
                            rr.taskSegmentIds.push(s.id);
                    }
                }
                const failedCommandCount = parsed.events.filter((e) => (e.exitCode ?? 0) !== 0 || e.type === "error").length;
                const changedFiles = changedEventFiles(parsed.events);
                const tokenUsage = sumTokenUsage(parsed.events);
                const costEstimate = estimateCost(parsed.events);
                const firstEventAt = parsed.startedAt ?? parsed.events.find((e) => e.timestamp)?.timestamp;
                const lastEventAt = parsed.endedAt ??
                    [...parsed.events].reverse().find((e) => e.timestamp)?.timestamp;
                const projectIdentity = deriveProjectIdentity({
                    repoRoots: rs,
                    repoIds: [...repoIdsByRoot.values()],
                    cwd: parsed.cwd,
                    events: parsed.events,
                    sourcePath: d.sourcePath,
                });
                sessions.push({
                    id: sid,
                    provider: ad.id,
                    providerLabel: ad.label,
                    sourcePath: d.sourcePath,
                    sourceKind: d.sourceKind,
                    sourceType: d.sourcePath.includes(`${path.sep}hooks${path.sep}`)
                        ? "hook"
                        : "transcript",
                    createdAt: firstEventAt,
                    updatedAt: lastEventAt ?? fingerprint.modifiedAt,
                    indexedAt: new Date().toISOString(),
                    projectPath: projectIdentity.projectPath,
                    projectName: projectIdentity.projectName,
                    projectId: projectIdentity.projectId,
                    projectRoot: projectIdentity.projectRoot,
                    projectDisplayName: projectIdentity.projectDisplayName,
                    title: titleFrom(parsed.events),
                    firstPrompt: parsed.events.find((e) => e.type === "user_message")
                        ?.summary,
                    outcome: failedCommandCount > 0
                        ? "failed"
                        : parsed.events.length
                            ? "success"
                            : "unknown",
                    changedFileCount: changedFiles.length,
                    changedFiles,
                    model: parsed.model,
                    durationMs: durationMs(parsed.events, firstEventAt, lastEventAt),
                    failureSummary: failureSummary(parsed.events),
                    tokenCount: tokenUsage?.totalTokens,
                    inputTokenCount: tokenUsage?.inputTokens,
                    outputTokenCount: tokenUsage?.outputTokens,
                    cacheTokenCount: tokenUsage &&
                        (tokenUsage.cacheCreationTokens !== undefined ||
                            tokenUsage.cacheReadTokens !== undefined ||
                            tokenUsage.cachedTokens !== undefined)
                        ? (tokenUsage.cacheCreationTokens ?? 0) +
                            (tokenUsage.cacheReadTokens ?? 0) +
                            (tokenUsage.cachedTokens ?? 0)
                        : undefined,
                    cacheCreationTokenCount: tokenUsage?.cacheCreationTokens,
                    cacheReadTokenCount: tokenUsage?.cacheReadTokens,
                    reasoningTokenCount: tokenUsage?.reasoningTokens,
                    costUsd: costEstimate.perModel.length
                        ? costEstimate.totalUsd
                        : undefined,
                    sourceHash: fingerprint.hash,
                    sourceSize: fingerprint.sizeBytes,
                    sourceMtimeMs: fingerprint.mtimeMs,
                    firstEventAt,
                    lastEventAt,
                    eventCount: parsed.events.length,
                    repoRoots: rs,
                    repoIds: [...repoIdsByRoot.values()],
                    taskSegmentIds: segs.map((s) => s.id),
                    commandCount: parsed.events.filter((e) => e.command).length,
                    failedCommandCount,
                    fileEventCount: parsed.events.filter((e) => e.path || e.type.startsWith("file_")).length,
                    warningCount: parsed.warnings.length,
                    fingerprint,
                    confidence: d.confidence,
                    warnings: parsed.warnings,
                });
                counts[ad.label] = (counts[ad.label] ?? 0) + 1;
                indexed = true;
            }
            catch (e) {
                if (opts.agent)
                    warnings.push(`${base.sourcePath}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        parsedCount++;
        if (parsedCount === toParse.length || parsedCount % 100 === 0)
            opts.progress?.({
                stage: "parse",
                current: parsedCount,
                total: toParse.length,
            });
    }
    if (previous && reusedIds.size) {
        for (const t of previous.taskSegments)
            if (reusedIds.has(t.sessionId))
                tasks.push(t);
        for (const r of previous.repos) {
            const sessionIds = r.sessionIds.filter((id) => reusedIds.has(id) || sessions.some((s) => s.id === id));
            if (sessionIds.length && !repos.has(r.id))
                repos.set(r.id, { ...r, sessionIds });
        }
    }
    opts.progress?.({
        stage: "summary",
        message: `Parsed ${parsedNew} new sessions. Parsed ${parsedChanged} changed sessions. Removed or missing sessions: ${removed}.`,
        skipped: skippedUnchanged,
        parsedNew,
        parsedChanged,
        removed,
    });
    opts.progress?.({ stage: "write-index", message: "Writing index..." });
    const index = {
        version: 1,
        generatedAt: new Date().toISOString(),
        sessions,
        taskSegments: tasks,
        repos: [...repos.values()],
        warnings,
    };
    const indexPath = await writeIndex(index, opts.indexDir);
    opts.progress?.({ stage: "write-index", message: "Scan complete." });
    return {
        index,
        indexPath,
        counts,
        skippedUnchanged,
        parsedNew,
        parsedChanged,
        removed,
    };
}
