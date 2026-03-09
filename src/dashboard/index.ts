/**
 * Dashboard — builds pre-aggregated JSON for visualization tools.
 * See plans/11-dashboard-export.md for design.
 */
import type { Store, SessionRow } from "../store/index.js";
import type { ReportOptions } from "../reporter/index.js";
import { periodStart } from "../reporter/index.js";
import { estimateCost } from "../pricing.js";

export interface DashboardSummary {
  sessions: number;
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheEfficiency: number;
  estimatedCost: number;
  totalDurationMs: number;
}

export interface DashboardData {
  generated: string;          // ISO timestamp
  period: string;
  timezone: string;
  summary: DashboardSummary;
  byDay: Array<{
    date: string;             // YYYY-MM-DD
    sessions: number;
    prompts: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estimatedCost: number;
  }>;
  byProject: Array<{
    projectPath: string;
    sessions: number;
    prompts: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  }>;
  byModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  }>;
  byEntrypoint: Array<{
    entrypoint: string;
    sessions: number;
  }>;
  stopReasons: Array<{
    reason: string;
    count: number;
  }>;
}

export function buildDashboard(store: Store, opts: ReportOptions): DashboardData {
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const since = periodStart(opts.period, tz);

  const rows = store.getSessions({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    entrypoint: opts.entrypoint,
    since: since > 0 ? since : undefined,
    includeCI: opts.includeCI ?? false,
  });

  // ── Summary aggregation ──────────────────────────────────────────────────
  let totalPrompts = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let totalDurationMs = 0;

  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // Accumulators for grouping
  const dayMap = new Map<string, { sessions: number; prompts: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }>();
  const projectMap = new Map<string, { sessions: number; prompts: number; inputTokens: number; outputTokens: number }>();
  const entrypointMap = new Map<string, number>();

  for (const row of rows) {
    totalPrompts += row.prompt_count;
    totalInput += row.input_tokens;
    totalOutput += row.output_tokens;
    totalCacheRead += row.cache_read_tokens;
    totalCacheCreate += row.cache_creation_tokens;
    if (row.first_timestamp != null && row.last_timestamp != null) {
      totalDurationMs += row.last_timestamp - row.first_timestamp;
    }

    // byDay
    const dateStr = row.first_timestamp != null
      ? dayFmt.format(new Date(row.first_timestamp))
      : "unknown";
    const dayEntry = dayMap.get(dateStr) ?? { sessions: 0, prompts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    dayEntry.sessions++;
    dayEntry.prompts += row.prompt_count;
    dayEntry.inputTokens += row.input_tokens;
    dayEntry.outputTokens += row.output_tokens;
    dayEntry.cacheReadTokens += row.cache_read_tokens;
    dayEntry.cacheCreationTokens += row.cache_creation_tokens;
    dayMap.set(dateStr, dayEntry);

    // byProject
    const projEntry = projectMap.get(row.project_path) ?? { sessions: 0, prompts: 0, inputTokens: 0, outputTokens: 0 };
    projEntry.sessions++;
    projEntry.prompts += row.prompt_count;
    projEntry.inputTokens += row.input_tokens;
    projEntry.outputTokens += row.output_tokens;
    projectMap.set(row.project_path, projEntry);

    // byEntrypoint
    const ep = row.entrypoint ?? "unknown";
    entrypointMap.set(ep, (entrypointMap.get(ep) ?? 0) + 1);
  }

  // ── Cost from per-message model data ─────────────────────────────────────
  const messageTotals = store.getMessageTotals({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    since: since > 0 ? since : undefined,
  });

  let totalCost = 0;
  const byModel: DashboardData["byModel"] = [];
  for (const mt of messageTotals) {
    const result = estimateCost(
      mt.model,
      mt.input_tokens,
      mt.output_tokens,
      mt.cache_read_tokens,
      mt.cache_creation_tokens,
    );
    totalCost += result.cost;
    byModel.push({
      model: mt.model,
      inputTokens: mt.input_tokens,
      outputTokens: mt.output_tokens,
      estimatedCost: Math.round(result.cost * 100) / 100,
    });
  }

  // ── Compute per-day cost from byModel is impractical without per-day messages,
  //    so we distribute total cost proportionally by output tokens per day ────
  const totalOutputForCost = totalOutput || 1; // avoid division by zero
  const byDay: DashboardData["byDay"] = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      sessions: d.sessions,
      prompts: d.prompts,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens,
      cacheCreationTokens: d.cacheCreationTokens,
      estimatedCost: Math.round((d.outputTokens / totalOutputForCost) * totalCost * 100) / 100,
    }));

  // ── Per-project cost: distribute proportionally by output tokens ──────────
  const byProject: DashboardData["byProject"] = Array.from(projectMap.entries())
    .sort(([, a], [, b]) => b.inputTokens - a.inputTokens)
    .map(([projectPath, p]) => ({
      projectPath,
      sessions: p.sessions,
      prompts: p.prompts,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      estimatedCost: Math.round((p.outputTokens / totalOutputForCost) * totalCost * 100) / 100,
    }));

  // ── Cache efficiency ─────────────────────────────────────────────────────
  // Total logical input = non-cached input + cache creation + cache read
  const totalLogicalInput = totalInput + totalCacheCreate + totalCacheRead;
  const cacheEfficiency = totalLogicalInput > 0
    ? Math.round(((totalCacheRead / totalLogicalInput) * 100) * 10) / 10
    : 0;

  // ── Stop reasons ─────────────────────────────────────────────────────────
  const sessionIds = rows.map(r => r.session_id);
  const stopReasonMap = store.getStopReasonCounts(sessionIds);
  const stopReasons: DashboardData["stopReasons"] = Array.from(stopReasonMap.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({ reason, count }));

  // ── Entrypoints ──────────────────────────────────────────────────────────
  const byEntrypoint: DashboardData["byEntrypoint"] = Array.from(entrypointMap.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([entrypoint, sessions]) => ({ entrypoint, sessions }));

  return {
    generated: new Date().toISOString(),
    period: opts.period ?? "all",
    timezone: tz,
    summary: {
      sessions: rows.length,
      prompts: totalPrompts,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreate,
      cacheEfficiency,
      estimatedCost: Math.round(totalCost * 100) / 100,
      totalDurationMs,
    },
    byDay,
    byProject,
    byModel,
    byEntrypoint,
    stopReasons,
  };
}
