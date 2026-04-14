const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Database = require("better-sqlite3");
const { CortexDatabase } = require("../out/database");
const { saveWithDedup } = require("../out/memory");
const { search } = require("../out/search");
const { OllamaSummarizer } = require("../out/summarizer");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

const nativeBindingPath = path.join(
  __dirname,
  "..",
  "native",
  "node",
  "better_sqlite3.node"
);
const nativeBinding = fs.existsSync(nativeBindingPath)
  ? nativeBindingPath
  : undefined;

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-test-"));
  return {
    dir,
    db: new CortexDatabase(dir, nativeBinding),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function vector(values) {
  return new Float32Array(values);
}

test("search ranks matching memories and records access", async () => {
  const { db, cleanup } = makeDb();
  try {
    const alpha = db.saveMemory("alpha memory", "/repo/src/alpha.ts");
    db.saveVector(alpha.id, vector([1, 0]));
    const beta = db.saveMemory("beta memory", "/repo/src/beta.ts");
    db.saveVector(beta.id, vector([0, 1]));

    const embedder = {
      embed: async () => vector([1, 0]),
    };

    const results = await search("alpha", db, embedder, {
      threshold: 0.1,
      currentFilePath: "/repo/src/alpha.ts",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].memory.id, alpha.id);
    assert.equal(db.getMemory(alpha.id).access_count, 1);
    assert.equal(db.getMemory(alpha.id).used, 1);
    assert.equal(db.getMemory(beta.id).access_count, 0);
  } finally {
    db.close();
    cleanup();
  }
});

test("saveWithDedup updates an existing close match instead of inserting", async () => {
  const { db, cleanup } = makeDb();
  try {
    const embedder = {
      embed: async () => vector([1, 0]),
    };

    const first = await saveWithDedup("first content", "/repo/a.ts", db, embedder);
    const second = await saveWithDedup("updated content", "/repo/b.ts", db, embedder);
    const memories = db.getAllMemories();

    assert.equal(second.id, first.id);
    assert.equal(second.deduplicated, true);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].content, "updated content");
    assert.equal(memories[0].file_path, "/repo/b.ts");
  } finally {
    db.close();
    cleanup();
  }
});

test("CortexDatabase creates the storage directory if needed", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-parent-"));
  const dir = path.join(parent, "nested", "storage");
  const db = new CortexDatabase(dir, nativeBinding);

  try {
    assert.equal(fs.existsSync(path.join(dir, "cortex.db")), true);
  } finally {
    db.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("empty Ollama model disables availability checks", async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error("fetch should not be called");
  };

  try {
    const summarizer = new OllamaSummarizer("");
    assert.equal(await summarizer.isAvailable(), false);
    assert.equal(called, false);
    await assert.rejects(
      () => summarizer.summarize("content"),
      /disabled/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("MCP server starts and lists memory tools", async () => {
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-test-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "out", "mcp-server.js")],
    env: { ...process.env, CORTEX_DB_PATH: dbPath },
  });
  const client = new Client(
    { name: "cortex-test", version: "0.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, ["save_memory", "search_memories"]);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
});

test("deleteMemory and clearAllMemories", () => {
  const { db, cleanup } = makeDb();
  try {
    const a = db.saveMemory("a", "/a.ts");
    const b = db.saveMemory("b", "/b.ts");
    assert.equal(db.getMemoriesForSidebar().length, 2);

    assert.equal(db.deleteMemory(a.id), true);
    assert.equal(db.getMemoriesForSidebar().length, 1);
    assert.equal(db.deleteMemory("nonexistent"), false);

    assert.equal(db.clearAllMemories(), 1);
    assert.equal(db.getMemoryListMeta().count, 0);
  } finally {
    db.close();
    cleanup();
  }
});

test("getMemoriesForSidebar omits vectors; getMemoryListMeta tracks changes", () => {
  const { db, cleanup } = makeDb();
  try {
    const m = db.saveMemory("hello", "/x.ts");
    db.saveVector(m.id, vector([0.1, 0.2, 0.3]));

    const rows = db.getMemoriesForSidebar();
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "content",
      "file_path",
      "id",
      "timestamp",
    ]);

    let meta = db.getMemoryListMeta();
    assert.equal(meta.count, 1);
    const ts = meta.maxTimestamp;

    db.updateMemory(m.id, "updated");
    meta = db.getMemoryListMeta();
    assert.equal(meta.count, 1);
    assert.ok(meta.maxTimestamp >= ts);
  } finally {
    db.close();
    cleanup();
  }
});

test("pruneStaleMemories removes old unaccessed rows", () => {
  const { db, dir, cleanup } = makeDb();
  try {
    const old = db.saveMemory("stale", "/s.ts");
    db.saveVector(old.id, vector([1, 0]));
    const ancient = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const raw = nativeBinding
      ? new Database(path.join(dir, "cortex.db"), { nativeBinding })
      : new Database(path.join(dir, "cortex.db"));
    raw
      .prepare("UPDATE memories SET timestamp = ? WHERE id = ?")
      .run(ancient, old.id);
    raw.close();

    const fresh = db.saveMemory("fresh", "/f.ts");
    db.saveVector(fresh.id, vector([0, 1]));

    const pruned = db.pruneStaleMemories();
    assert.equal(pruned, 1);
    assert.equal(db.getMemoriesForSidebar().length, 1);
    assert.equal(db.getMemoriesForSidebar()[0].id, fresh.id);
  } finally {
    db.close();
    cleanup();
  }
});

test(
  "MCP save_memory persists via saveWithDedup path",
  { timeout: 180_000 },
  async () => {
    const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-save-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, "..", "out", "mcp-server.js")],
      env: {
        ...process.env,
        CORTEX_DB_PATH: dbPath,
        CORTEX_TEST_EMBEDDER: "deterministic",
      },
    });
    const client = new Client(
      { name: "cortex-test", version: "0.0.0" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "save_memory",
        arguments: {
          content: "integration test memory",
          file_path: "cursor-chat",
        },
      });
      const text = result.content[0].text;
      const parsed = JSON.parse(text);
      assert.equal(parsed.saved, true);
      assert.ok(typeof parsed.id === "string");

      const db = new CortexDatabase(dbPath, nativeBinding);
      try {
        const rows = db.getMemoriesForSidebar();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].content, "integration test memory");
        assert.equal(rows[0].file_path, "cursor-chat");
      } finally {
        db.close();
      }
    } finally {
      await client.close().catch(() => {});
      fs.rmSync(dbPath, { recursive: true, force: true });
    }
  }
);
