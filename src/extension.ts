import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { minimatch } from "minimatch";
import { CortexDatabase } from "./database";
import { Embedder } from "./embedder";
import { search } from "./search";
import { cosine } from "./utils";

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

const DEDUP_THRESHOLD = 0.92;

async function saveWithDedup(
  text: string,
  filePath: string,
  db: CortexDatabase,
  embedder: Embedder
): Promise<{ id: string; deduplicated: boolean }> {
  const vector = await embedder.embed(text);

  const existing = db.getAllMemoriesWithVectors().filter((m) => m.vector !== null);

  const duplicate = existing.find(
    (m) => cosine(vector, m.vector as Float32Array) >= DEDUP_THRESHOLD
  );

  if (duplicate) {
    db.updateMemory(duplicate.id, text);
    db.saveVector(duplicate.id, vector);
    out.appendLine(`deduplicated [${duplicate.id.slice(0, 8)}]`);
    return { id: duplicate.id, deduplicated: true };
  }

  const memory = db.saveMemory(text, filePath);
  db.saveVector(memory.id, vector);
  return { id: memory.id, deduplicated: false };
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

      saveWithDedup(text, editor.document.fileName, db, embedder).then(({ id, deduplicated }) => {
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

  // .cortexignore support
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const cortexIgnorePath = path.join(workspaceRoot, ".cortexignore");

  let ignorePatterns: string[] = loadIgnorePatterns(cortexIgnorePath);

  const ignoreWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, ".cortexignore")
  );
  ignoreWatcher.onDidChange(() => { ignorePatterns = loadIgnorePatterns(cortexIgnorePath); });
  ignoreWatcher.onDidCreate(() => { ignorePatterns = loadIgnorePatterns(cortexIgnorePath); });
  ignoreWatcher.onDidDelete(() => { ignorePatterns = []; });
  context.subscriptions.push(ignoreWatcher);

  const recentlyAutoCaptured = new Set<string>();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        return;
      }

      const filePath = editor.document.fileName;

      if (
        editor.document.isUntitled ||
        editor.document.uri.scheme !== "file" ||
        recentlyAutoCaptured.has(filePath)
      ) {
        return;
      }

      const relative = workspaceRoot
        ? path.relative(workspaceRoot, filePath)
        : filePath;

      if (ignorePatterns.some((p) => minimatch(relative, p, { dot: true }))) {
        return;
      }

      const text = editor.document.getText().slice(0, 500).trim();

      if (!text) {
        return;
      }

      recentlyAutoCaptured.add(filePath);

      saveWithDedup(text, filePath, db, embedder).then(({ id, deduplicated }) => {
        out.appendLine(
          deduplicated
            ? `auto-capture deduplicated ${path.basename(filePath)} [${id.slice(0, 8)}]`
            : `auto-captured ${path.basename(filePath)} [${id.slice(0, 8)}]`
        );
      });
    })
  );
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
