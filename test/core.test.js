const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

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
  } finally {
    db.close();
    cleanup();
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
