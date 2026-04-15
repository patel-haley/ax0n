import * as fs from "fs";
import * as path from "path";
import * as childProcess from "child_process";
import * as vscode from "vscode";
import { Ax0nDatabase } from "./database";
import { Embedder } from "./embedder";
import { OllamaSummarizer } from "./summarizer";
import { search } from "./search";
import { saveWithDedup } from "./memory";

class Ax0nSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "ax0n.sidebarView";

  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _db: Ax0nDatabase
  ) {}

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

    webviewView.webview.onDidReceiveMessage(
      async (message: { command: string; id?: string }) => {
        // Webview signals it has loaded and its message listener is live.
        if (message.command === "ready") {
          this._sendMemories("init");
          return;
        }

        if (message.command === "delete" && message.id) {
          this._db.deleteMemory(message.id);
          try {
            this._view?.webview.postMessage({ command: "deleted", id: message.id });
          } catch {
            this._view = undefined;
          }
        }

        if (message.command === "clearAll") {
          const count = this._db.getMemoryListMeta().count;
          if (count === 0) {
            this._view?.webview.postMessage({ command: "cleared" });
            return;
          }

          const confirmed = await vscode.window.showWarningMessage(
            `Permanently delete all ${count} memories? This cannot be undone.`,
            { modal: true },
            "Delete All"
          );

          if (confirmed !== "Delete All") {
            return;
          }

          this._db.clearAllMemories();
          try {
            this._view?.webview.postMessage({ command: "cleared" });
          } catch {
            this._view = undefined;
          }
        }
      }
    );
  }

  /** Reload memories from the database and push a fresh list to the webview. */
  refresh(): void {
    this._sendMemories("refresh");
  }

  private _sendMemories(command: "init" | "refresh"): void {
    if (!this._view) {
      return;
    }
    const memories = this._db.getMemoriesForSidebar();
    try {
      void this._view.webview.postMessage({ command, memories });
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
                 img-src ${webview.cspSource};
                 script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${mediaUri("sidebar.css")}" />
  <title>Ax0n</title>
</head>
<body>
  <div id="header">
    <div id="header-left">
      <img id="ax0n-logo" src="${mediaUri("ax0n-icon.svg")}" alt="" />
      <h2>Saved Memories</h2>
      <span id="memory-count"></span>
    </div>
    <button id="clear-btn" title="Delete all memories">Clear All</button>
  </div>
  <ul id="memory-list"></ul>
  <div id="empty-state">
    <img id="empty-icon" src="${mediaUri("ax0n-icon.svg")}" alt="" />
    <p>No memories yet.<br/>Capture text with <kbd>Cmd+Shift+C</kbd> or let your AI chats save context automatically.</p>
  </div>

  <script nonce="${nonce}" src="${mediaUri("sidebar.js")}"></script>
</body>
</html>`;
  }
}

export const out = vscode.window.createOutputChannel("Ax0n");

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
      "ax0n.setup",
      "Ax0n — Finish Setup",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    SetupPanel._current = this;
    this._panel.webview.html = SetupPanel._buildHtml(this._panel.webview);

    this._panel.webview.onDidReceiveMessage(
      async (message: { command: string }) => {
        if (message.command === "copyMcpConfig") {
          await vscode.commands.executeCommand("ax0n.copyMcpConfig");
          this._panel.webview.postMessage({ command: "configCopied" });
        }
        if (message.command === "copyCodexMcpConfig") {
          await vscode.commands.executeCommand("ax0n.copyCodexMcpConfig");
          this._panel.webview.postMessage({ command: "configCopiedCodex" });
        }
        if (message.command === "done") {
          await context.globalState.update("ax0n.setupComplete", true);
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
  <title>Ax0n Setup</title>
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
    #copy-btn, #copy-codex-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #copy-btn:hover, #copy-codex-btn:hover { background: var(--vscode-button-hoverBackground); }
    #copy-codex-btn { margin-top: 10px; }
    #follow-up, #follow-up-codex {
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
    Ax0n needs to be registered as an MCP server so it can inject context into
    your AI chats. <strong>Cursor:</strong> copy the JSON snippet into
    <code>~/.cursor/mcp.json</code> and restart Cursor.
    <strong>Codex CLI / IDE:</strong> copy the TOML snippet into
    <code>~/.codex/config.toml</code> (or merge into a project
    <code>.codex/config.toml</code> in a trusted project), then restart Codex.
  </p>

  <button id="copy-btn">Copy Cursor MCP Config (JSON)</button>
  <button id="copy-codex-btn">Copy Codex MCP Config (TOML)</button>

  <div id="follow-up">
    ✓ Copied. Paste into <strong>~/.cursor/mcp.json</strong> and restart Cursor.
  </div>
  <div id="follow-up-codex">
    ✓ Copied. Merge into <strong>~/.codex/config.toml</strong> and restart Codex. Run <code>codex mcp list</code> to verify.
  </div>

  <br />
  <button id="done-btn">Done</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('copy-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'copyMcpConfig' });
    });

    document.getElementById('copy-codex-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'copyCodexMcpConfig' });
    });

    document.getElementById('done-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'done' });
    });

    window.addEventListener('message', ({ data }) => {
      if (data.command === 'configCopied') {
        document.getElementById('follow-up').style.display = 'block';
        document.getElementById('follow-up-codex').style.display = 'none';
      }
      if (data.command === 'configCopiedCodex') {
        document.getElementById('follow-up-codex').style.display = 'block';
        document.getElementById('follow-up').style.display = 'none';
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

  let db: Ax0nDatabase;
  try {
    db = new Ax0nDatabase(context.globalStorageUri.fsPath);
    context.subscriptions.push({ dispose: () => db.close() });
  } catch (err) {
    vscode.window.showErrorMessage(`Ax0n: failed to open database — ${err}`);
    return;
  }

  const pruned = db.pruneStaleMemories();
  if (pruned > 0) {
    out.appendLine(`pruned ${pruned} stale memor${pruned === 1 ? "y" : "ies"} (0 accesses, older than 30 days)`);
  }

  const embedder = new Embedder(context.globalStorageUri.fsPath, (msg) => out.appendLine(msg));

  const ollamaModel = vscode.workspace.getConfiguration("ax0n").get<string>("ollamaModel", "llama3").trim();
  const summarizer = new OllamaSummarizer(ollamaModel);
  let ollamaAvailable = false;

  summarizer.isAvailable().then((available) => {
    ollamaAvailable = available;
    out.appendLine(
      !ollamaModel
        ? "Ollama summarization disabled — captures stored as raw text"
        : available
        ? `Ollama available — summarizing captures with model: ${ollamaModel}`
        : `Ollama model "${ollamaModel}" not available — captures stored as raw text`
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

  const provider = new Ax0nSidebarProvider(context.extensionUri, db);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      Ax0nSidebarProvider.viewId,
      provider
    )
  );

  // Poll for changes from the MCP server (separate process). Compare count + max
  // timestamp so dedup updates (same row count, new timestamp) still refresh.
  let lastListMeta = db.getMemoryListMeta();
  const pollInterval = setInterval(() => {
    const meta = db.getMemoryListMeta();
    if (
      meta.count !== lastListMeta.count ||
      meta.maxTimestamp !== lastListMeta.maxTimestamp
    ) {
      lastListMeta = meta;
      provider.refresh();
    }
  }, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(pollInterval) });

  context.subscriptions.push(
    vscode.commands.registerCommand("ax0n.capture", () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        vscode.window.showWarningMessage("Ax0n: No active editor.");
        return;
      }

      const selection = editor.selection;
      const text = editor.document.getText(selection);

      if (!text.trim()) {
        vscode.window.showWarningMessage(
          "Ax0n: Nothing selected — highlight some text first."
        );
        return;
      }

      vscode.commands.executeCommand("workbench.view.extension.ax0n-sidebar");

      void maybeSummarize(text).then((textToSave) =>
        saveWithDedup(textToSave, editor.document.fileName, db, embedder, (msg) => out.appendLine(msg))
      ).then(({ id, deduplicated }) => {
        provider.refresh();
        vscode.window.showInformationMessage(
          deduplicated
            ? `Ax0n: Updated existing memory [${id.slice(0, 8)}]`
            : `Ax0n: Captured ${text.split("\n").length} line(s) from ${path.basename(editor.document.fileName)} [${id.slice(0, 8)}]`
        );
      }).catch((err) => {
        out.appendLine(`capture failed: ${err}`);
        vscode.window.showErrorMessage(`Ax0n: capture failed — ${err}`);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ax0n.search", async () => {
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
        vscode.window.showInformationMessage("Ax0n: no memories found above threshold.");
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
    vscode.commands.registerCommand("ax0n.showTopResult", async () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        vscode.window.showWarningMessage("Ax0n: No active editor.");
        return;
      }

      const currentFilePath = editor.document.fileName;
      const query = path.basename(currentFilePath);
      const results = await search(query, db, embedder, {
        topK: 1,
        currentFilePath,
      });

      if (results.length === 0) {
        vscode.window.showInformationMessage(
          `Ax0n: no memories found for ${query}.`
        );
        return;
      }

      const top = results[0];
      const fileName = path.basename(top.memory.file_path);
      const preview = top.memory.content.replace(/\s+/g, " ").slice(0, 120);

      vscode.window.showInformationMessage(
        `Ax0n: ${fileName} [${top.finalScore.toFixed(3)}] ${preview}`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ax0n.listMemories", () => {
      const memories = db.getMemoriesForSidebar();

      if (memories.length === 0) {
        vscode.window.showInformationMessage("Ax0n: No memories saved yet.");
        return;
      }

      out.clear();
      out.appendLine(`Memories (${memories.length} total)\n`);

      memories.forEach((m, i) => {
        const date = new Date(m.timestamp).toLocaleString();
        const source = path.basename(m.file_path);
        const preview = m.content.replace(/\s+/g, " ").slice(0, 120);
        out.appendLine(`${i + 1}. [${m.id.slice(0, 8)}] ${source}  ·  ${date}`);
        out.appendLine(`   ${preview}`);
        out.appendLine("");
      });

      out.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ax0n.deleteMemory", async () => {
      const memories = db.getMemoriesForSidebar();

      if (memories.length === 0) {
        vscode.window.showInformationMessage("Ax0n: No memories to delete.");
        return;
      }

      const items = memories.map((m) => ({
        label: `[${m.id.slice(0, 8)}] ${path.basename(m.file_path)}`,
        description: new Date(m.timestamp).toLocaleString(),
        detail: m.content.replace(/\s+/g, " ").slice(0, 100),
        id: m.id,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a memory to delete",
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (!picked) {
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete memory [${picked.id.slice(0, 8)}]?`,
        { modal: true },
        "Delete"
      );

      if (confirmed === "Delete") {
        db.deleteMemory(picked.id);
        provider.refresh();
        out.appendLine(`deleted memory [${picked.id.slice(0, 8)}]`);
        vscode.window.showInformationMessage("Ax0n: Memory deleted.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ax0n.clearMemories", async () => {
      const count = db.getMemoryListMeta().count;

      if (count === 0) {
        vscode.window.showInformationMessage("Ax0n: Memory base is already empty.");
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Permanently delete all ${count} memories? This cannot be undone.`,
        { modal: true },
        "Delete All"
      );

      if (confirmed === "Delete All") {
        const deleted = db.clearAllMemories();
        provider.refresh();
        out.appendLine(`cleared all memories (${deleted} deleted)`);
        vscode.window.showInformationMessage(`Ax0n: Cleared ${deleted} memories.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ax0n.copyMcpConfig", async () => {
      const { serverPath, nodeCommand } = await getAx0nMcpPaths(context);

      const config = {
        mcpServers: {
          ax0n: { command: nodeCommand, args: [serverPath] },
        },
      };

      const snippet = JSON.stringify(config, null, 2);

      await vscode.env.clipboard.writeText(snippet);
      out.appendLine(`MCP server path: ${serverPath}`);
      out.appendLine(`Node command: ${nodeCommand}`);

      const choice = await vscode.window.showInformationMessage(
        nodeCommand === "node"
          ? "Ax0n: MCP config copied. If Cursor cannot start it, replace node with the full path from `which node`."
          : "Ax0n: MCP config copied to clipboard.",
        "Copied — how do I use this?",
        "Dismiss"
      );

      if (choice === "Copied — how do I use this?") {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://github.com/patel-haley/ax0n#setup")
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ax0n.copyCodexMcpConfig", async () => {
      const { serverPath, nodeCommand } = await getAx0nMcpPaths(context);

      const snippet = buildCodexMcpToml(nodeCommand, serverPath);

      await vscode.env.clipboard.writeText(snippet);
      out.appendLine(`MCP server path: ${serverPath}`);
      out.appendLine(`Node command: ${nodeCommand}`);

      const choice = await vscode.window.showInformationMessage(
        nodeCommand === "node"
          ? "Ax0n: Codex MCP config copied. If Codex cannot start it, replace `command` with the full path from `which node`."
          : "Ax0n: Codex MCP config copied to clipboard.",
        "Copied — how do I use this?",
        "Dismiss"
      );

      if (choice === "Copied — how do I use this?") {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://github.com/patel-haley/ax0n#setup")
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ax0n.showSetup", () => {
      SetupPanel.show(context);
    })
  );

  if (!context.globalState.get<boolean>("ax0n.setupComplete")) {
    SetupPanel.show(context);
  }

}

export function deactivate(): void {}

async function getAx0nMcpPaths(
  context: vscode.ExtensionContext
): Promise<{ serverPath: string; nodeCommand: string }> {
  const serverPath = vscode.Uri.joinPath(context.extensionUri, "out", "mcp-server.js").fsPath;
  const nodeCommand = await resolveNodeCommand();
  return { serverPath, nodeCommand };
}

/** Escape a string for TOML double-quoted strings. */
function tomlDoubleQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildCodexMcpToml(nodeCommand: string, serverPath: string): string {
  return (
    `[mcp_servers.ax0n]\n` +
    `command = ${tomlDoubleQuoted(nodeCommand)}\n` +
    `args = [${tomlDoubleQuoted(serverPath)}]\n` +
    `enabled = true\n` +
    `startup_timeout_sec = 60\n` +
    `tool_timeout_sec = 120\n`
  );
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join("");
}

async function resolveNodeCommand(): Promise<string> {
  const override = process.env.AX0N_NODE_PATH?.trim();
  if (override) {
    return override;
  }

  if (path.basename(process.execPath).toLowerCase().startsWith("node")) {
    return process.execPath;
  }

  const fromPath = await findExecutable("node");
  return fromPath ?? "node";
}

function findExecutable(name: string): Promise<string | undefined> {
  const command = process.platform === "win32" ? "where" : "which";

  return new Promise((resolve) => {
    childProcess.execFile(command, [name], { timeout: 2000 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }

      const match = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      resolve(match);
    });
  });
}
