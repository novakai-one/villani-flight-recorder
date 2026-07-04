import { estimateCost, matchModelRates } from "../render/pricing.js";
import { isSubagentTranscript } from "../index/subagents.js";
// ponytail: eyeballed thresholds, tune from real fleets
export const CACHE_HIT_FLOOR_TOKENS = 1_000_000;
export const CACHE_HIT_MIN_RATIO = 0.8;
export const OUTPUT_COST_SHARE_MAX = 0.4;
export const CONCENTRATION_TOP_N = 5;
export const CONCENTRATION_MAX_SHARE = 0.5;
export const SUBAGENT_MAX_SHARE = 0.3;
export const CONTEXT_TAIL_TOKENS = 120_000;
export const TOOL_OUTPUT_CHAR_FLAG = 30_000;
/** cacheRead / (cacheRead + cacheCreation + input), undefined without a split. */
function recordCacheHitRatio(s) {
    if (s.cacheReadTokenCount === undefined &&
        s.cacheCreationTokenCount === undefined)
        return undefined;
    const denom = (s.cacheReadTokenCount ?? 0) +
        (s.cacheCreationTokenCount ?? 0) +
        (s.inputTokenCount ?? 0);
    return denom > 0 ? (s.cacheReadTokenCount ?? 0) / denom : undefined;
}
/** Approx per-class USD from list rates on the record's model and stored counts. */
function classUsd(s) {
    const m = s.model ? matchModelRates(s.model) : undefined;
    if (!m)
        return undefined;
    return {
        inputUsd: ((s.inputTokenCount ?? 0) * m.rates.input) / 1_000_000,
        outputUsd: ((s.outputTokenCount ?? 0) * m.rates.output) / 1_000_000,
        cacheWriteUsd: ((s.cacheCreationTokenCount ?? 0) * m.rates.cacheWrite) / 1_000_000,
        cacheReadUsd: ((s.cacheReadTokenCount ?? 0) * m.rates.cacheRead) / 1_000_000,
    };
}
const projectOf = (s) => s.projectDisplayName ?? s.projectName ?? "-";
const pct = (r) => `${Math.round(r * 100)}%`;
export function analyzeFleet(sessions, opts) {
    const top = opts?.top ?? 10;
    const priced = sessions.filter((s) => typeof s.costUsd === "number");
    const unpriced = sessions.filter((s) => typeof s.costUsd !== "number");
    const totalCostUsd = priced.reduce((a, s) => a + (s.costUsd ?? 0), 0);
    const tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    let missingCacheSplit = 0;
    for (const s of sessions) {
        tokens.input += s.inputTokenCount ?? 0;
        tokens.output += s.outputTokenCount ?? 0;
        tokens.cacheCreation += s.cacheCreationTokenCount ?? 0;
        tokens.cacheRead += s.cacheReadTokenCount ?? 0;
        if (s.cacheTokenCount !== undefined &&
            s.cacheCreationTokenCount === undefined &&
            s.cacheReadTokenCount === undefined)
            missingCacheSplit++;
    }
    let costByClass;
    const flags = [];
    for (const s of sessions) {
        const c = classUsd(s);
        if (c) {
            costByClass ??= {
                inputUsd: 0,
                outputUsd: 0,
                cacheWriteUsd: 0,
                cacheReadUsd: 0,
                coveredSessions: 0,
            };
            costByClass.inputUsd += c.inputUsd;
            costByClass.outputUsd += c.outputUsd;
            costByClass.cacheWriteUsd += c.cacheWriteUsd;
            costByClass.cacheReadUsd += c.cacheReadUsd;
            costByClass.coveredSessions++;
            const sessionClassUsd = c.inputUsd + c.outputUsd + c.cacheWriteUsd + c.cacheReadUsd;
            const share = sessionClassUsd > 0 ? c.outputUsd / sessionClassUsd : 0;
            if (share > OUTPUT_COST_SHARE_MAX)
                flags.push({
                    kind: "output-cost-share",
                    sessionId: s.id,
                    message: `session ${s.id}: output tokens are ${pct(share)} of estimated cost`,
                    value: share,
                });
        }
        const contextTokens = (s.cacheReadTokenCount ?? 0) +
            (s.cacheCreationTokenCount ?? 0) +
            (s.inputTokenCount ?? 0);
        const ratio = recordCacheHitRatio(s);
        if (ratio !== undefined &&
            ratio < CACHE_HIT_MIN_RATIO &&
            contextTokens >= CACHE_HIT_FLOOR_TOKENS)
            flags.push({
                kind: "low-cache-hit",
                sessionId: s.id,
                message: `session ${s.id}: cache hit ratio ${pct(ratio)} over ${Math.round(contextTokens / 1_000_000)}M+ context tokens`,
                value: ratio,
            });
    }
    const byCost = [...sessions].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
    const topSessions = byCost.slice(0, top).map((s) => ({
        id: s.id,
        project: projectOf(s),
        title: s.title ?? s.firstPrompt,
        model: s.model,
        costUsd: s.costUsd,
        tokenCount: s.tokenCount,
        cacheHitRatio: recordCacheHitRatio(s),
        unpriced: typeof s.costUsd !== "number",
    }));
    const projects = new Map();
    for (const s of sessions) {
        const key = projectOf(s);
        const cur = projects.get(key) ?? {
            project: key,
            sessions: 0,
            costUsd: 0,
            tokenCount: 0,
        };
        cur.sessions++;
        cur.costUsd += s.costUsd ?? 0;
        cur.tokenCount += s.tokenCount ?? 0;
        projects.set(key, cur);
    }
    const topProjects = [...projects.values()]
        .sort((a, b) => b.costUsd - a.costUsd)
        .slice(0, top);
    const topNCost = byCost
        .slice(0, CONCENTRATION_TOP_N)
        .reduce((a, s) => a + (s.costUsd ?? 0), 0);
    const concentration = {
        topN: CONCENTRATION_TOP_N,
        shareOfTotal: totalCostUsd > 0 ? topNCost / totalCostUsd : 0,
    };
    if (concentration.shareOfTotal > CONCENTRATION_MAX_SHARE)
        flags.push({
            kind: "cost-concentration",
            message: `top ${CONCENTRATION_TOP_N} sessions carry ${pct(concentration.shareOfTotal)} of fleet cost`,
            value: concentration.shareOfTotal,
        });
    const subs = sessions.filter((s) => isSubagentTranscript(s.sourcePath));
    const subCost = subs.reduce((a, s) => a + (s.costUsd ?? 0), 0);
    const subagents = {
        sessionCount: subs.length,
        costUsd: subCost,
        shareOfTotal: totalCostUsd > 0 ? subCost / totalCostUsd : 0,
    };
    if (subagents.shareOfTotal > SUBAGENT_MAX_SHARE)
        flags.push({
            kind: "subagent-share",
            message: `subagent sessions carry ${pct(subagents.shareOfTotal)} of fleet cost`,
            value: subagents.shareOfTotal,
        });
    return {
        totals: {
            sessions: sessions.length,
            pricedSessions: priced.length,
            unpricedSessions: unpriced.length,
            unpricedTokenCount: unpriced.reduce((a, s) => a + (s.tokenCount ?? 0), 0),
            totalCostUsd,
            tokens,
            missingCacheSplit,
        },
        costByClass,
        topSessions,
        topProjects,
        concentration,
        subagents,
        flags,
    };
}
const TOOLISH = new Set(["tool_call", "tool_result", "bash_command", "test_run"]);
export function analyzeSession(rec, events) {
    const cost = estimateCost(events);
    let input = 0, cacheCreation = 0, cacheRead = 0;
    const contexts = [];
    for (const e of events) {
        const u = e.tokenUsage;
        if (!u)
            continue;
        input += u.inputTokens ?? 0;
        cacheCreation += u.cacheCreationTokens ?? 0;
        cacheRead += u.cacheReadTokens ?? 0;
        contexts.push((u.inputTokens ?? 0) +
            (u.cacheReadTokens ?? 0) +
            (u.cacheCreationTokens ?? 0));
    }
    const denom = cacheRead + cacheCreation + input;
    const cacheHitRatio = denom > 0 ? cacheRead / denom : undefined;
    const contextCurve = {
        turns: contexts.length,
        firstTokens: contexts[0],
        peakTokens: contexts.length ? Math.max(...contexts) : 0,
        finalTokens: contexts.at(-1),
    };
    const topToolOutputs = events
        .map((e, i) => ({
        eventIndex: i,
        type: e.type,
        title: e.title,
        chars: (e.stdout?.length ?? 0) + (e.summary?.length ?? 0),
        approxTokens: 0,
    }))
        .filter((x) => x.chars > 0 && TOOLISH.has(x.type))
        .sort((a, b) => b.chars - a.chars)
        .slice(0, 5)
        .map((x) => ({ ...x, approxTokens: Math.round(x.chars / 4) }));
    const flags = [];
    if ((contextCurve.finalTokens ?? 0) > CONTEXT_TAIL_TOKENS)
        flags.push({
            kind: "long-tail-context",
            sessionId: rec.id,
            message: "long-tail context; consider a fresh session",
            value: contextCurve.finalTokens,
        });
    if (cacheHitRatio !== undefined && cacheHitRatio < CACHE_HIT_MIN_RATIO)
        flags.push({
            kind: "low-cache-hit",
            sessionId: rec.id,
            message: `cache hit ratio ${pct(cacheHitRatio)}`,
            value: cacheHitRatio,
        });
    for (const t of topToolOutputs)
        if (t.chars > TOOL_OUTPUT_CHAR_FLAG)
            flags.push({
                kind: "large-tool-output",
                sessionId: rec.id,
                message: `event #${t.eventIndex} (${t.title}) returned ${t.chars} chars (~${t.approxTokens} tokens)`,
                value: t.chars,
            });
    return { id: rec.id, cost, cacheHitRatio, contextCurve, topToolOutputs, flags };
}
