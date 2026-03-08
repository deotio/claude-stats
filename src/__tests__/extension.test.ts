import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock vscode module before any imports that depend on it
vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: () => ({
      show: vi.fn(),
      dispose: vi.fn(),
      text: "",
      command: "",
      tooltip: "",
    }),
    createWebviewPanel: vi.fn(),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultVal: unknown) => defaultVal,
    }),
  },
  commands: {
    registerCommand: vi.fn(),
  },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Two: 2 },
}));

import { formatTokens } from "../extension/statusBar.js";
import { patchForWebview } from "../extension/panel.js";
import { AutoCollector } from "../extension/collector.js";

// ── formatTokens ──────────────────────────────────────────────────────────────

describe("formatTokens", () => {
  it("returns raw number for values under 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(1_500)).toBe("2k");
    expect(formatTokens(142_000)).toBe("142k");
    expect(formatTokens(999_999)).toBe("1000k");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(4_200_000)).toBe("4.2M");
    expect(formatTokens(12_345_678)).toBe("12.3M");
  });
});

// ── patchForWebview ───────────────────────────────────────────────────────────

describe("patchForWebview", () => {
  const sampleHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Test</title>
</head>
<body>
  <button id="refresh-btn">Auto-refresh: off</button>
  <script>window.__DASHBOARD__ = {};</script>
</body>
</html>`;

  it("injects Content-Security-Policy meta tag", () => {
    const result = patchForWebview(sampleHtml);
    expect(result).toContain('http-equiv="Content-Security-Policy"');
    expect(result).toContain("https://cdn.jsdelivr.net");
    expect(result).toContain("'unsafe-inline'");
  });

  it("injects the VS Code messaging bridge script", () => {
    const result = patchForWebview(sampleHtml);
    expect(result).toContain("acquireVsCodeApi");
    expect(result).toContain("changePeriod");
    expect(result).toContain("postMessage");
  });

  it("overrides the refresh button text and handler", () => {
    const result = patchForWebview(sampleHtml);
    expect(result).toContain("btn.textContent = 'Refresh'");
    expect(result).toContain("btn.onclick");
  });

  it("preserves the original HTML structure", () => {
    const result = patchForWebview(sampleHtml);
    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain("window.__DASHBOARD__");
    expect(result).toContain("</html>");
  });

  it("places CSP before other head content", () => {
    const result = patchForWebview(sampleHtml);
    const cspIdx = result.indexOf("Content-Security-Policy");
    const charsetIdx = result.indexOf('charset="UTF-8"');
    expect(cspIdx).toBeLessThan(charsetIdx);
  });

  it("places bridge script before closing body tag", () => {
    const result = patchForWebview(sampleHtml);
    const bridgeIdx = result.indexOf("acquireVsCodeApi");
    const bodyCloseIdx = result.indexOf("</body>");
    expect(bridgeIdx).toBeLessThan(bodyCloseIdx);
    expect(bridgeIdx).toBeGreaterThan(0);
  });
});

// ── AutoCollector ─────────────────────────────────────────────────────────────

describe("AutoCollector", () => {
  let collector: AutoCollector;

  beforeEach(() => {
    collector = new AutoCollector();
  });

  afterEach(() => {
    collector.dispose();
  });

  it("can be constructed and disposed without errors", () => {
    expect(collector).toBeDefined();
    collector.dispose();
  });

  it("fires onDidCollect callbacks after collectNow()", async () => {
    const cb = vi.fn();
    collector.onDidCollect(cb);
    await collector.collectNow();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("stops firing after callback disposable is disposed", async () => {
    const cb = vi.fn();
    const sub = collector.onDidCollect(cb);
    await collector.collectNow();
    expect(cb).toHaveBeenCalledTimes(1);

    sub.dispose();
    await collector.collectNow();
    expect(cb).toHaveBeenCalledTimes(1); // not called again
  });

  it("handles errors in callbacks without breaking collector", async () => {
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    collector.onDidCollect(bad);
    collector.onDidCollect(good);

    await collector.collectNow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1); // still called despite prior error
  });
});
