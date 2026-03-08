/**
 * Status bar item showing today's token count and estimated cost.
 * Click opens the dashboard panel.
 *
 * The status bar does not poll on its own — the AutoCollector
 * calls refresh() after each collection run.
 */
import * as vscode from "vscode";
import { Store } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "claude-stats.openDashboard";
    this.item.tooltip = "Open Claude Stats Dashboard";
    this.item.text = "$(graph) Claude Stats";
    this.item.show();
  }

  refresh(): void {
    try {
      const store = new Store();
      try {
        const data = buildDashboard(store, { period: "day" });
        const tokens = data.summary.inputTokens + data.summary.outputTokens;
        const cost = data.summary.estimatedCost;
        this.item.text = `$(graph) ${formatTokens(tokens)} tokens · ~$${cost.toFixed(2)}`;
      } finally {
        store.close();
      }
    } catch {
      this.item.text = "$(graph) Claude Stats";
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Format a token count with k/M suffix. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
