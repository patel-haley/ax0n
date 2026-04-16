# Ax0n

Every time you start a new AI chat, you re-explain everything. Ax0n fixes that.

Like the axons in your brain that carry signals between neurons, Ax0n carries context between your sessions. It runs silently in the background, captures what you work on, and automatically surfaces relevant context the next time you prompt your AI assistant with a related topic. No copy-pasting, no manual notes, no setup per project.

**Why Ax0n:** Most AI assistants start from zero every chat. You re-explain your stack, repeat past decisions and tradeoffs, and recap work you did last week. Ax0n remembers what you've already established and surfaces it when it's relevant, so you stop paying for the same context twice. Saving time AND tokens.

---

## How it works

**Manual capture:** Select any text from a file and press `Cmd+Shift+C` to save it as a memory. All memories appear in the Ax0n sidebar in your activity bar.

**Local embeddings:** Each capture is embedded using `all-MiniLM-L6-v2` (via `@xenova/transformers`) and stored in a local SQLite database. Nothing leaves your machine.

**MCP server:** Ax0n exposes a `search_memories` tool and a `save_memory` tool over the [Model Context Protocol](https://modelcontextprotocol.io). Any MCP-compatible client can call them.

**Automatic context injection:** The repo ships with rules that tell the AI what to do automatically. No prompt engineering required on your end.

At the start of every conversation, the AI calls `search_memories` based on what you ask and anything relevant comes back as context before it responds. After every substantive response (a fix, implementation, diagnosis), it calls `save_memory` with a 2-3 sentence summary of what it did and why. Over time, context accumulates across sessions.

Ax0n works in both Cursor (via `.cursor/rules/ax0n-memory.mdc`) and Codex (via `AGENTS.md`). Both files ship with the repo and are already active when you clone it.

---

## Setup

**1. Install the extension**

In VS Code or Cursor, open the Extensions view and search for **Ax0n** (publisher **patel-haley**), then install.  

Alternatively, download a `.vsix` from [Releases](https://github.com/patel-haley/ax0n/releases) and run **Extensions: Install from VSIX** in the Command Palette.

**2. Register the MCP server (pre-filled snippets)**

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run the command for the client you use. Each command copies a **ready-to-paste** config that already points at **`mcp-server.js` inside your installed Ax0n extension** (and picks a sensible `node` command). Merge into existing MCP config if you already have other servers.

| Client | Command | Paste into |
|--------|---------|------------|
| **Cursor** | **`Ax0n: Copy Cursor MCP Config`** | `~/.cursor/mcp.json` |
| **Codex** | **`Ax0n: Copy Codex MCP Config`** | `~/.codex/config.toml` |

After pasting, restart Cursor or Codex. For Codex, run `codex mcp list` and use `/mcp` in the chat to confirm **`ax0n`** is listed.

**If the MCP server won’t start:** The copied config often uses plain `node` as the command. Cursor and Codex launch that process with a **minimal environment** (not the same as your terminal) so they sometimes **can’t find `node` on your PATH**. That’s especially common if you use **nvm**, **fnm**, or **asdf**, because those tools usually add Node only when a shell starts up.

**Fix:** In a normal terminal, run `which node` and copy the full path it prints (for example `/Users/you/.nvm/versions/node/v22.0.0/bin/node`). Edit your pasted config and replace the `command` value with that full path instead of `node`. Save, restart Cursor or Codex, and try again.

**3. Optional — Ollama summarization**

By default, Ax0n embeds your raw captured text. With Ollama, it first summarizes the text into a concise description before embedding, which means the semantic search finds more relevant memories and filters out noise. **Recommended** if you're capturing long functions or dense code blocks where raw text would produce noisy embeddings.

Install Ollama and pull the default model:

```bash
brew install ollama
ollama pull llama3
ollama serve
```

To use a different model, set `ax0n.ollamaModel` in VS Code settings (default: `llama3`). Set it to an empty string to disable summarization even if Ollama is running.

---

## What it captures

- Manual selections via `Cmd+Shift+C` or **Ax0n: Capture Selection**
- AI chat summaries written by the MCP `save_memory` tool after substantive responses

---

## Managing memories

The **Ax0n sidebar** (activity bar icon) shows all saved memories with their source and timestamp. Memories saved via MCP from AI chats appear automatically.

**Available commands** (open Command Palette with `Cmd+Shift+P`):
- `Ax0n: Search Memories` — semantic search across all memories
- `Ax0n: List Memories` — view all memories in the output panel
- `Ax0n: Delete Memory` — select and delete a specific memory
- `Ax0n: Clear All Memories` — delete all memories (requires confirmation)
- `Ax0n: Show Top Result for Current File` — quick relevance check for the active file

Memories are automatically pruned after 30 days if they've never been accessed.

---
## Architecture

Ax0n implements a RAG (Retrieval-Augmented Generation) pipeline entirely locally. No cloud, no API keys, no data leaving your machine.

**Embeddings.** Every capture is converted into a 384-dimensional float vector using `all-MiniLM-L6-v2`, a sentence embedding model that runs entirely in-process via `@xenova/transformers`. The model downloads once (~23MB) and runs offline on CPU, there are no network calls. Similar meaning produces similar vectors, which, for example, is what makes "auth bug" retrieve a memory about "login issue" even though the two phrases share no words.

**Semantic search.** At query time Ax0n embeds the query using the same model and computes cosine similarity against every stored vector, implemented from scratch, no libraries. Results below a 0.4 threshold are discarded. Cosine similarity measures the angle between two vectors rather than straight-line distance, making it robust to magnitude differences and the standard approach for semantic retrieval.

**Importance scoring.** Raw similarity alone doesn't rank results well. Ax0n re-ranks candidates using a weighted formula that combines four signals:
```
    finalScore = relevance × 0.4 + recency × 0.3 + frequency × 0.2 + proximity × 0.1
```
Recency uses exponential decay with a 10-day half-life so recent memories naturally surface over stale ones. Frequency normalises access count against the most-accessed memory in the database. Proximity scores 1.0 for the same file, 0.5 for the same file extension, 0 otherwise.

**Deduplication.** Before every save, Ax0n embeds the new content and compares it against all stored vectors. Anything scoring above 0.92 cosine similarity updates the existing memory rather than creating a duplicate, which keeping the database clean without discarding meaningfully different captures.

**Memory decay.** Two mechanisms handle forgetting. Hard pruning deletes memories with zero accesses older than 30 days on activation. Soft decay operates through the recency component of the importance scorer, thus older memories rank progressively lower even when they survive pruning. Accessed memories are never deleted.

## Built with

| | |
|---|---|
| Embeddings | [`@xenova/transformers`](https://github.com/xenova/transformers.js) — `all-MiniLM-L6-v2`, runs fully in-process |
| Storage | [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — local WAL-mode database |
| MCP | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) |
| Language | TypeScript |


