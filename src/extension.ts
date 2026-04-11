import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CortexDatabase } from "./database";
import { Embedder } from "./embedder";
import { OllamaSummarizer } from "./summarizer";
import { search } from "./search";
import { saveWithDedup } from "./memory";

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

    webviewView.webview.onDidReceiveMessage((message: { command: string }) => {
      if (message.command === "clear") {
        try {
          this._view?.webview.postMessage({ command: "clear" });
        } catch {
          this._view = undefined;
        }
      }
    });
  }

  addCapture(text: string, source: string): void {
    try {
      this._view?.webview.postMessage({ command: "capture", text, source });
    } catch {
      this._view = undefined;
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const mediaUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "media", file)
      );

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

export const out = vscode.window.createOutputChannel("Cortex");

class SetupPanel {
  private static _current: SetupPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext): void {
    if (SetupPanel._current) {
      SetupPanel._current._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    new SetupPanel(context);
  }

  private constructor(context: vscode.ExtensionContext) {
    this._panel = vscode.window.createWebviewPanel(
      "cortex.setup",
      "Cortex — Finish Setup",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    SetupPanel._current = this;
    this._panel.webview.html = SetupPanel._buildHtml(this._panel.webview);

    this._panel.webview.onDidReceiveMessage(
      async (message: { command: string }) => {
        if (message.command === "copyMcpConfig") {
          await vscode.commands.executeCommand("cortex.copyMcpConfig");
          this._panel.webview.postMessage({ command: "configCopied" });
        }
        if (message.command === "done") {
          await context.globalState.update("cortex.setupComplete", true);
          this._panel.dispose();
        }
      },
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
  }

  private _dispose(): void {
    SetupPanel._current = undefined;
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }

  private static _buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = webview.cspSource;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${csp} 'unsafe-inline';
                 script-src 'nonce-${nonce}';" />
  <title>Cortex Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 48px 40px;
      max-width: 560px;
      margin: 0 auto;
      line-height: 1.6;
    }
    h1 { font-size: 1.35em; margin: 0 0 14px; font-weight: 600; }
    p  { margin: 0 0 28px; color: var(--vscode-descriptionForeground); }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 5px;
      border-radius: 3px;
    }
    button {
      display: inline-block;
      padding: 7px 16px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
    }
    #copy-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #copy-btn:hover { background: var(--vscode-button-hoverBackground); }
    #follow-up {
      display: none;
      margin-top: 16px;
      padding: 12px 14px;
      border-left: 3px solid var(--vscode-activityBarBadge-background, #007acc);
      background: var(--vscode-textBlockQuote-background);
      border-radius: 0 3px 3px 0;
      font-size: 0.9em;
    }
    #done-btn {
      margin-top: 32px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-foreground) 30%, transparent);
      opacity: 0.75;
    }
    #done-btn:hover { opacity: 1; }
  </style>
</head>
<body>
  <h1>One step to finish setup</h1>
  <p>
    Cortex needs to be registered as an MCP server in Cursor so it can inject
    context into your AI chats automatically. Copy the config snippet below,
    then paste it into <code>~/.cursor/mcp.json</code>.
  </p>

  <button id="copy-btn">Copy Cursor MCP Config</button>

  <div id="follow-up">
    ✓ Copied. Paste into <strong>~/.cursor/mcp.json</strong> and restart Cursor.
  </div>

  <br />
  <button id="done-btn">Done</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('copy-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'copyMcpConfig' });
    });

    document.getElementById('done-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'done' });
    });

    window.addEventListener('message', ({ data }) => {
      if (data.command === 'configCopied') {
        document.getElementById('follow-up').style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(out);

  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  let db: CortexDatabase;
  try {
    db = new CortexDatabase(context.globalStorageUri.fsPath);
    context.subscriptions.push({ dispose: () => db.close() });
  } catch (err) {
    vscode.window.showErrorMessage(`Cortex: failed to open database — ${err}`);
    return;
  }

  const pruned = db.pruneStaleMemories();
  if (pruned > 0) {
    out.appendLine(`pruned ${pruned} stale memor${pruned === 1 ? "y" : "ies"} (0 accesses, older than 30 days)`);
  }

  const embedder = new Embedder(context.globalStorageUri.fsPath, (msg) => out.appendLine(msg));

  const ollamaModel = vscode.workspace.getConfiguration("cortex").get<string>("ollamaModel", "llama3");
  const summarizer = new OllamaSummarizer(ollamaModel);
  let ollamaAvailable = false;

  summarizer.isAvailable().then((available) => {
    ollamaAvailable = available;
    out.appendLine(
      available
        ? `Ollama available — summarizing captures with model: ${ollamaModel}`
        : "Ollama not available — captures stored as raw text"
    );
  });

  async function maybeSummarize(text: string): Promise<string> {
    if (!ollamaAvailable) {
      return text;
    }
    try {
      const summary = await summarizer.summarize(text);
      out.appendLine(`summarized → ${summary.slice(0, 100)}${summary.length > 100 ? "…" : ""}`);
      return summary;
    } catch (err) {
      out.appendLine(`Ollama summarize failed, using raw text: ${err}`);
      return text;
    }
  }

  const provider = new CortexSidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CortexSidebarProvider.viewId,
      provider
    )
  );

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

      const source = `${path.basename(editor.document.fileName)} · L${
        selection.start.line + 1
      }–${selection.end.line + 1}`;

      provider.addCapture(text, source);
      vscode.commands.executeCommand("workbench.view.extension.cortex-sidebar");

      maybeSummarize(text).then((textToSave) =>
        saveWithDedup(textToSave, editor.document.fileName, db, embedder, (msg) => out.appendLine(msg))
      ).then(({ id, deduplicated }) => {
        vscode.window.showInformationMessage(
          deduplicated
            ? `Cortex: Updated existing memory [${id.slice(0, 8)}]`
            : `Cortex: Captured ${text.split("\n").length} line(s) from ${path.basename(editor.document.fileName)} [${id.slice(0, 8)}]`
        );
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cortex.search", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search your captured memories…",
        placeHolder: "e.g. authentication bug fix",
      });

      if (!query) {
        return;
      }

      const currentFilePath = vscode.window.activeTextEditor?.document.fileName ?? "";
      const results = await search(query, db, embedder, { currentFilePath });

      if (results.length === 0) {
        vscode.window.showInformationMessage("Cortex: no memories found above threshold.");
        return;
      }

      out.clear();
      out.appendLine(`Search: "${query}"  (${results.length} result${results.length === 1 ? "" : "s"})\n`);

      results.forEach((r, i) => {
        const fileName = path.basename(r.memory.file_path);
        const preview = r.memory.content.replace(/\s+/g, " ").slice(0, 120);
        const { relevance, recency, frequency, proximity } = r.components;
        out.appendLine(`${i + 1}. [${r.finalScore.toFixed(3)}] ${fileName}`);
        out.appendLine(`   ${preview}`);
        out.appendLine(`   rel=${relevance.toFixed(2)} rec=${recency.toFixed(2)} freq=${frequency.toFixed(2)} prox=${proximity.toFixed(2)}`);
        out.appendLine("");
      });

      out.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cortex.copyMcpConfig", async () => {
      const serverPath = vscode.Uri.joinPath(context.extensionUri, "out", "mcp-server.js").fsPath;

      const config = {
        mcpServers: {
          cortex: { command: "node", args: [serverPath] },
        },
      };

      const snippet = JSON.stringify(config, null, 2);

      await vscode.env.clipboard.writeText(snippet);
      out.appendLine(`MCP server path: ${serverPath}`);

      const choice = await vscode.window.showInformationMessage(
        "Cortex: MCP config copied to clipboard.",
        "Copied — how do I use this?",
        "Dismiss"
      );

      if (choice === "Copied — how do I use this?") {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://github.com/patel-haley/cortex#setup")
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cortex.showSetup", () => {
      SetupPanel.show(context);
    })
  );

  if (!context.globalState.get<boolean>("cortex.setupComplete")) {
    SetupPanel.show(context);
  }

}

export function deactivate(): void {}

function loadIgnorePatterns(filePath: string): string[] {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join("");
}
