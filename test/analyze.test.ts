import { describe, expect, it } from "vitest";
import { analyzeFleet, analyzeSession } from "../src/analyze/analyze.js";
import { estimateCost } from "../src/render/pricing.js";
import { SessionRecord } from "../src/index/sessionTypes.js";
import { FlightEvent, TokenUsage } from "../src/providers/types.js";

const MILLION = 1_000_000;

function rec(over: Partial<SessionRecord>): SessionRecord {
  return {
    id: "s0",
    provider: "claude",
    providerLabel: "Claude Code",
    sourcePath: "/home/u/.claude/projects/p/s0.jsonl",
    sourceKind: "file",
    eventCount: 1,
    repoRoots: [],
    repoIds: [],
    taskSegmentIds: [],
    commandCount: 0,
    failedCommandCount: 0,
    fileEventCount: 0,
    warningCount: 0,
    fingerprint: {},
    confidence: "high",
    warnings: [],
    ...over,
  };
}

let n = 0;
const ev = (over: Partial<FlightEvent>): FlightEvent => ({
  id: `e${++n}`,
  provider: "claude",
  type: "assistant_message",
  title: "t",
  ...over,
});

describe("analyzeFleet", () => {
  it("ranks sessions by cost and tracks unpriced sessions and missing cache splits", () => {
    const sessions = [
      rec({
        id: "cheap",
        model: "claude-sonnet-5",
        costUsd: 1,
        tokenCount: 100_000,
        inputTokenCount: 10_000,
        outputTokenCount: 5_000,
        cacheCreationTokenCount: 20_000,
        cacheReadTokenCount: 65_000,
        projectName: "alpha",
      }),
      rec({
        id: "pricey",
        model: "claude-sonnet-5",
        costUsd: 5,
        tokenCount: 500_000,
        inputTokenCount: 50_000,
        outputTokenCount: 25_000,
        cacheCreationTokenCount: 100_000,
        cacheReadTokenCount: 325_000,
        projectName: "alpha",
      }),
      rec({
        id: "mid",
        model: "claude-sonnet-5",
        costUsd: 3,
        tokenCount: 300_000,
        inputTokenCount: 30_000,
        outputTokenCount: 15_000,
        cacheCreationTokenCount: 60_000,
        cacheReadTokenCount: 195_000,
        projectName: "beta",
      }),
      rec({
        id: "codex",
        provider: "codex",
        tokenCount: 42_000,
        inputTokenCount: 40_000,
        outputTokenCount: 2_000,
        cacheTokenCount: 30_000, // collapsed only: no split fields
        projectName: "beta",
      }),
    ];
    const r = analyzeFleet(sessions);
    expect(r.topSessions.map((s) => s.id)).toEqual([
      "pricey",
      "mid",
      "cheap",
      "codex",
    ]);
    expect(r.topSessions[3].unpriced).toBe(true);
    expect(r.totals.totalCostUsd).toBeCloseTo(9, 6);
    expect(r.totals.pricedSessions).toBe(3);
    expect(r.totals.unpricedSessions).toBe(1);
    expect(r.totals.unpricedTokenCount).toBe(42_000);
    expect(r.totals.missingCacheSplit).toBe(1);
    // 4 sessions, so the top-5 slice covers all of the cost.
    expect(r.concentration.shareOfTotal).toBeCloseTo(1, 6);
    expect(r.costByClass?.coveredSessions).toBe(3);
    expect(r.topProjects[0].project).toBe("alpha");
    expect(r.topProjects[0].costUsd).toBeCloseTo(6, 6);
  });

  it("flags low cache-hit ratio only above the context-token floor", () => {
    const big = rec({
      id: "big",
      inputTokenCount: 100_000,
      cacheCreationTokenCount: 900_000,
      cacheReadTokenCount: MILLION, // ratio 0.5 over 2M context tokens
    });
    const small = rec({
      id: "small",
      inputTokenCount: 500,
      cacheCreationTokenCount: 4_500,
      cacheReadTokenCount: 5_000, // ratio 0.5 over 10k context tokens
    });
    const r = analyzeFleet([big, small]);
    const cacheFlags = r.flags.filter((f) => f.kind === "low-cache-hit");
    expect(cacheFlags).toHaveLength(1);
    expect(cacheFlags[0].sessionId).toBe("big");
    expect(cacheFlags[0].value).toBeCloseTo(0.5, 6);
  });
});

describe("analyzeSession", () => {
  it("reports cost, context curve, and oversized tool outputs", () => {
    const usage = (u: TokenUsage) => ({
      model: "claude-sonnet-5",
      tokenUsage: u,
    });
    const events: FlightEvent[] = [
      ev(usage({ inputTokens: 1_000, outputTokens: 200 })),
      ev({
        type: "tool_result",
        title: "Read big file",
        stdout: "x".repeat(40_000),
      }),
      ev(usage({ inputTokens: 500, cacheReadTokens: 10_000, outputTokens: 300 })),
      ev({ type: "tool_result", title: "small", stdout: "ok" }),
      ev(usage({ inputTokens: 500, cacheReadTokens: 25_000, outputTokens: 100 })),
    ];
    const r = analyzeSession(rec({ id: "s1" }), events);
    expect(r.cost.totalUsd).toBeCloseTo(estimateCost(events).totalUsd, 10);
    expect(r.cost.perModel[0].model).toBe("claude-sonnet-5");
    expect(r.contextCurve.turns).toBe(3);
    expect(r.contextCurve.firstTokens).toBe(1_000);
    expect(r.contextCurve.peakTokens).toBe(25_500);
    expect(r.contextCurve.finalTokens).toBe(25_500);
    expect(r.topToolOutputs[0]).toMatchObject({
      eventIndex: 1,
      type: "tool_result",
      chars: 40_000,
      approxTokens: 10_000,
    });
    expect(
      r.flags.some((f) => f.kind === "large-tool-output" && f.value === 40_000),
    ).toBe(true);
  });
});
