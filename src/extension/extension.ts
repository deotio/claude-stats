/**
 * VS Code extension entry point for claude-stats.
 *
 * Starts an AutoCollector that watches ~/.claude/projects/ for changes,
 * runs incremental collection, and refreshes the status bar and dashboard.
 */
import * as vscode from "vscode";
import { DashboardPanel } from "./panel.js";
import { StatusBarManager } from "./statusBar.js";
import { AutoCollector } from "./collector.js";

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  const collector = new AutoCollector();
  context.subscriptions.push(collector);

  // After each collection, refresh the status bar and any open dashboard panel
  context.subscriptions.push(
    collector.onDidCollect(() => {
      statusBar.refresh();
      DashboardPanel.refreshIfVisible();
    }),
  );

  const openDashboard = vscode.commands.registerCommand(
    "claude-stats.openDashboard",
    () => {
      try {
        DashboardPanel.createOrShow(context);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("sqlite") || msg.includes("SQLite")) {
          void vscode.window.showErrorMessage(
            `Claude Stats requires Node.js 22.5+ with node:sqlite support. ${msg}`,
          );
        } else {
          void vscode.window.showErrorMessage(`Claude Stats: ${msg}`);
        }
      }
    },
  );
  context.subscriptions.push(openDashboard);

  // Start watching and run initial collection
  collector.start();
}

export function deactivate(): void {
  // Disposables registered via context.subscriptions handle cleanup
}
