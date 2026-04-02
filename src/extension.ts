import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Sidebar webview provider
// ---------------------------------------------------------------------------

class CortexSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "cortex.sidebarView";

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    // Handle messages sent from the webview back to the extension
    webviewView.webview.onDidReceiveMessage((message: { command: string }) => {
      if (message.command === "clear") {
        this._view?.webview.postMessage({ command: "clear" });
      }
    });
  }

  /** Push a captured snippet into the sidebar. */
  addCapture(text: string, source: string): void {
    this._view?.webview.postMessage({ command: "capture", text, source });
  }

  private _buildHtml(webview: vscode.Webview): string {
    const mediaUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "media", file)
      );

    // Content-Security-Policy: only allow scripts/styles from our own media dir
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${mediaUri("sidebar.css")}" />
  <title>Cortex</title>
</head>
<body>
  <div id="header">
    <h2>Cortex Captures</h2>
    <button id="clear-btn" title="Clear all captures">Clear</button>
  </div>
  <ul id="capture-list"></ul>
  <p id="empty-state">No captures yet.<br/>Select text and run <kbd>Cortex: Capture Selection</kbd>.</p>

  <script nonce="${nonce}" src="${mediaUri("sidebar.js")}"></script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Extension entry points
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CortexSidebarProvider(context.extensionUri);

  // Register the sidebar webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CortexSidebarProvider.viewId,
      provider
    )
  );

  // Register the cortex.capture command
  context.subscriptions.push(
    vscode.commands.registerCommand("cortex.capture", () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        vscode.window.showWarningMessage("Cortex: No active editor.");
        return;
      }

      const selection = editor.selection;
      const text = editor.document.getText(selection);

      if (!text.trim()) {
        vscode.window.showWarningMessage(
          "Cortex: Nothing selected — highlight some text first."
        );
        return;
      }

      const source = `${editor.document.fileName.split("/").pop()} · L${
        selection.start.line + 1
      }–${selection.end.line + 1}`;

      provider.addCapture(text, source);

      // Reveal the sidebar so the user sees the capture land
      vscode.commands.executeCommand(
        "workbench.view.extension.cortex-sidebar"
      );

      vscode.window.showInformationMessage(
        `Cortex: Captured ${text.split("\n").length} line(s) from ${
          editor.document.fileName.split("/").pop()
        }`
      );
    })
  );
}

export function deactivate(): void {
  // nothing to clean up beyond the disposables registered above
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join("");
}
