import * as vscode from "vscode";
import { CortexDatabase } from "./database";
import { Embedder } from "./embedder";
import { search } from "./search";

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
        this._view?.webview.postMessage({ command: "clear" });
      }
    });
  }

  addCapture(text: string, source: string): void {
    this._view?.webview.postMessage({ command: "capture", text, source });
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

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(out);
  out.show(true);

  const { mkdirSync } = require("fs") as typeof import("fs");
  mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  let db: CortexDatabase;
  try {
    db = new CortexDatabase(context.globalStorageUri.fsPath);
    context.subscriptions.push({ dispose: () => db.close() });
  } catch (err) {
    vscode.window.showErrorMessage(`Cortex: failed to open database — ${err}`);
    return;
  }

  const embedder = new Embedder(context.globalStorageUri.fsPath, (msg) => out.appendLine(msg));

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

      const source = `${editor.document.fileName.split("/").pop()} · L${
        selection.start.line + 1
      }–${selection.end.line + 1}`;

      const memory = db.saveMemory(text, editor.document.fileName);

      embedder.embed(text).then((vector) => {
        db.saveVector(memory.id, vector);
      });

      provider.addCapture(text, source);

      vscode.commands.executeCommand("workbench.view.extension.cortex-sidebar");

      vscode.window.showInformationMessage(
        `Cortex: Captured ${text.split("\n").length} line(s) from ${
          editor.document.fileName.split("/").pop()
        } [${memory.id.slice(0, 8)}]`
      );
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
        const fileName = r.memory.file_path.split("/").pop();
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

  runEmbedderTests(embedder, db);
}

export function deactivate(): void {}

async function runEmbedderTests(
  embedder: Embedder,
  db: CortexDatabase
): Promise<void> {
  out.appendLine("starting embedder tests…");

  try {
    const v1 = await embedder.embed("hello world");

    out.appendLine(`T2 output length: ${v1.length}${v1.length !== 384 ? " ← FAIL expected 384" : " ✓"}`);

    const probe = db.saveMemory("__test__", "__test__");
    db.saveVector(probe.id, v1);
    const loaded = db.getMemoryWithVector(probe.id);
    const rtLen = loaded?.vector?.length ?? 0;
    out.appendLine(`T3 round-trip length: ${rtLen}${rtLen !== 384 ? " ← FAIL expected 384" : " ✓"}`);

    const vA = await embedder.embed("I fixed the authentication bug");
    const vB = await embedder.embed("resolved the login issue");
    const t4ok = vA.length === 384 && vB.length === 384;
    out.appendLine(`T4 sentence-A: ${vA.length}, sentence-B: ${vB.length}${t4ok ? " ✓" : " ← FAIL"}`);

    await embedder.embed("first repeat call");
    await embedder.embed("second repeat call");
    await embedder.embed("third repeat call");
    out.appendLine("T5 done — 'model loaded' should appear exactly once above ✓");

    out.appendLine("all embedder tests complete");
  } catch (err) {
    out.appendLine(`embedder test error: ${err}`);
  }
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join("");
}
