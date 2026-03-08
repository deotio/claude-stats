/**
 * Webview panel that displays the Claude Stats dashboard inside VS Code.
 * Reuses buildDashboard() and renderDashboard() from the core library,
 * with HTML patched for webview CSP and message-based navigation.
 *
 * The panel does not own a Store or refresh timer — the AutoCollector
 * calls refreshIfVisible() after each collection run.
 */
import * as vscode from "vscode";
import { Store } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import { renderDashboard } from "../server/template.js";
import type { ReportOptions } from "../reporter/index.js";

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private period: ReportOptions["period"] = "all";

  /**
   * Refresh the currently visible dashboard panel (if any).
   * Called by the AutoCollector after each successful collection.
   */
  static refreshIfVisible(): void {
    DashboardPanel.instance?.refresh();
  }

  static createOrShow(context: vscode.ExtensionContext): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "claudeStatsDashboard",
      "Claude Stats",
      vscode.ViewColumn.Two,
      { enableScripts: true },
    );

    DashboardPanel.instance = new DashboardPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, _context: vscode.ExtensionContext) {
    this.panel = panel;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg: { command: string; period?: string }) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.refresh();
  }

  private refresh(): void {
    // Open and close the store on each refresh so we always read
    // the latest committed data (safe with WAL + busy_timeout)
    const store = new Store();
    try {
      const data = buildDashboard(store, { period: this.period });
      const html = renderDashboard(data);
      this.panel.webview.html = patchForWebview(html);
    } finally {
      store.close();
    }
  }

  private handleMessage(msg: { command: string; period?: string }): void {
    if (msg.command === "changePeriod" && msg.period) {
      this.period = msg.period as ReportOptions["period"];
      this.refresh();
    } else if (msg.command === "refresh") {
      this.refresh();
    }
  }

  private dispose(): void {
    DashboardPanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * Patch the HTML produced by renderDashboard() for use inside a VS Code webview:
 * 1. Inject a Content-Security-Policy allowing Chart.js from CDN and inline scripts/styles.
 * 2. Override changePeriod() and toggleRefresh() to use postMessage back to the extension.
 */
export function patchForWebview(html: string): string {
  // 1. Inject CSP meta tag
  const csp = [
    "default-src 'none'",
    "script-src https://cdn.jsdelivr.net 'unsafe-inline'",
    "style-src 'unsafe-inline'",
  ].join("; ");
  html = html.replace(
    "<head>",
    `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );

  // 2. Inject script that overrides navigation functions to use VS Code messaging
  const bridgeScript = `<script>
(function() {
  var vscode = acquireVsCodeApi();
  window.changePeriod = function(val) {
    vscode.postMessage({ command: 'changePeriod', period: val });
  };
  var btn = document.getElementById('refresh-btn');
  if (btn) {
    btn.textContent = 'Refresh';
    btn.onclick = function() {
      vscode.postMessage({ command: 'refresh' });
    };
  }
  window.toggleRefresh = function() {
    vscode.postMessage({ command: 'refresh' });
  };
})();
</script>`;
  html = html.replace("</body>", `${bridgeScript}\n</body>`);

  return html;
}
