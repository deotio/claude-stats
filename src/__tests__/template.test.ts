import { describe, it, expect } from "vitest";
import { renderDashboard } from "../server/template.js";
import type { DashboardData } from "../dashboard/index.js";

const mockData: DashboardData = {
  generated: "2026-01-15T10:00:00.000Z",
  period: "week",
  timezone: "UTC",
  summary: {
    sessions: 42,
    prompts: 150,
    inputTokens: 500000,
    outputTokens: 80000,
    cacheReadTokens: 200000,
    cacheCreationTokens: 50000,
    cacheEfficiency: 28.6,
    estimatedCost: 3.75,
    totalDurationMs: 7200000,
  },
  byDay: [
    {
      date: "2026-01-14",
      sessions: 5,
      prompts: 20,
      inputTokens: 100000,
      outputTokens: 15000,
      cacheReadTokens: 80000,
      cacheCreationTokens: 20000,
      estimatedCost: 0.75,
    },
    {
      date: "2026-01-15",
      sessions: 8,
      prompts: 30,
      inputTokens: 150000,
      outputTokens: 25000,
      cacheReadTokens: 120000,
      cacheCreationTokens: 30000,
      estimatedCost: 1.10,
    },
  ],
  byProject: [
    {
      projectPath: "/home/user/myproject",
      sessions: 10,
      prompts: 50,
      inputTokens: 200000,
      outputTokens: 30000,
      estimatedCost: 1.50,
    },
  ],
  byModel: [
    {
      model: "claude-opus-4-5",
      inputTokens: 300000,
      outputTokens: 50000,
      estimatedCost: 2.50,
    },
    {
      model: "claude-sonnet-4-5",
      inputTokens: 200000,
      outputTokens: 30000,
      estimatedCost: 1.25,
    },
  ],
  byEntrypoint: [
    { entrypoint: "claude", sessions: 35 },
    { entrypoint: "claude-vscode", sessions: 7 },
  ],
  stopReasons: [
    { reason: "end_turn", count: 120 },
    { reason: "tool_use", count: 28 },
    { reason: "max_tokens", count: 2 },
  ],
};

describe("renderDashboard", () => {
  it("returns a string starting with <!DOCTYPE html", () => {
    const html = renderDashboard(mockData);
    expect(typeof html).toBe("string");
    expect(html).toContain("<!DOCTYPE html");
  });

  it("contains session count from summary bar", () => {
    const html = renderDashboard(mockData);
    // The sessions value is 42 — it must appear in the rendered output
    expect(html).toContain("42");
  });

  it("contains window.__DASHBOARD__ assignment with valid JSON", () => {
    const html = renderDashboard(mockData);
    expect(html).toContain("window.__DASHBOARD__");

    // Extract the JSON payload between the assignment and semicolon
    const match = html.match(/window\.__DASHBOARD__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    expect(match).not.toBeNull();

    const parsed = JSON.parse(match![1]!);
    expect(parsed.period).toBe("week");
    expect(parsed.summary.sessions).toBe(42);
    expect(parsed.byModel).toHaveLength(2);
  });

  it("contains all 6 canvas IDs", () => {
    const html = renderDashboard(mockData);
    expect(html).toContain('id="chart-daily"');
    expect(html).toContain('id="chart-model"');
    expect(html).toContain('id="chart-project"');
    expect(html).toContain('id="chart-entrypoint"');
    expect(html).toContain('id="chart-stops"');
    expect(html).toContain('id="chart-cache"');
  });

  it("handles empty byDay array without crashing", () => {
    const emptyDay: DashboardData = {
      ...mockData,
      byDay: [],
    };
    let html: string;
    expect(() => {
      html = renderDashboard(emptyDay);
    }).not.toThrow();
    expect(html!).toContain("<!DOCTYPE html");
    expect(html!).toContain("window.__DASHBOARD__");
  });

  it("is pure — same input produces identical output on repeated calls", () => {
    const first = renderDashboard(mockData);
    const second = renderDashboard(mockData);
    expect(first).toBe(second);
  });

  it("includes the generated timestamp in the <title>", () => {
    const html = renderDashboard(mockData);
    // generated is "2026-01-15T10:00:00.000Z" — the date portion should appear in title
    expect(html).toContain("<title>");
    expect(html).toContain("2026-01-15");
  });

  it("pre-selects the correct period option", () => {
    const html = renderDashboard(mockData);
    // The period is "week" so that option should have selected attribute
    expect(html).toContain('<option value="week" selected>');
  });

  it("includes Chart.js CDN script tag", () => {
    const html = renderDashboard(mockData);
    expect(html).toContain("https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js");
  });

  it("includes period selector element", () => {
    const html = renderDashboard(mockData);
    expect(html).toContain('id="period-select"');
    expect(html).toContain('<option value="day"');
    expect(html).toContain('<option value="week"');
    expect(html).toContain('<option value="month"');
    expect(html).toContain('<option value="all"');
  });

  it("includes auto-refresh toggle button", () => {
    const html = renderDashboard(mockData);
    expect(html).toContain('id="refresh-btn"');
  });

  it("includes auto-refresh script logic with setTimeout", () => {
    const html = renderDashboard(mockData);
    expect(html).toContain("setTimeout");
    expect(html).toContain("location.reload");
    expect(html).toContain("refresh");
  });

  it("window.__DASHBOARD__ JSON contains full data structure", () => {
    const html = renderDashboard(mockData);
    const match = html.match(/window\.__DASHBOARD__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!) as DashboardData;

    expect(parsed.generated).toBe("2026-01-15T10:00:00.000Z");
    expect(parsed.timezone).toBe("UTC");
    expect(parsed.byDay).toHaveLength(2);
    expect(parsed.byProject).toHaveLength(1);
    expect(parsed.byEntrypoint).toHaveLength(2);
    expect(parsed.stopReasons).toHaveLength(3);
  });
});
