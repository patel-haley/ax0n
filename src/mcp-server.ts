import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CortexDatabase } from "./database";
import { Embedder } from "./embedder";
import { search } from "./search";
import { saveWithDedup } from "./memory";

const EXTENSION_ID = "patel-haley.cortex";

const NATIVE_BINDING = (() => {
  // The better-sqlite3 binary in node_modules may be compiled for Cursor's
  // Electron runtime. Use a Node-specific copy stored in native/node/ when
  // running as a plain Node MCP server process.
  const nodeBinary = path.join(__dirname, "..", "native", "node", "better_sqlite3.node");
  return fs.existsSync(nodeBinary) ? nodeBinary : undefined;
})();

const DB_PATH = (() => {
  if (process.env.CORTEX_DB_PATH) {
    return process.env.CORTEX_DB_PATH;
  }

  const appDirs: Record<string, string> = {
    darwin: path.join(os.homedir(), "Library", "Application Support"),
    linux: path.join(os.homedir(), ".config"),
    win32: process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  };

  const appDir = appDirs[process.platform] ?? appDirs["linux"];

  for (const app of ["Cursor", "Code"]) {
    const candidate = path.join(appDir, app, "User", "globalStorage", EXTENSION_ID);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(appDir, "Cursor", "User", "globalStorage", EXTENSION_ID);
})();

const db = new CortexDatabase(DB_PATH, NATIVE_BINDING);
// MCP uses stdout for JSON-RPC — all logging must go to stderr only
const log = (msg: string) => process.stderr.write(`[cortex] ${msg}\n`);
const embedder = new Embedder(DB_PATH, log);

const server = new Server(
  { name: "cortex", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_memories",
      description:
        "Semantic search over captured code notes. Returns the most relevant memories for a natural-language query — finds matches by meaning, not keywords.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language search query",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "save_memory",
      description:
        "Save a piece of context or knowledge as a memory so it can be retrieved in future chats. Call this after substantive work with a short summary of what was done and why.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The text to save as a memory",
          },
          file_path: {
            type: "string",
            description: "Optional source identifier, e.g. 'cursor-chat' or a file path",
          },
        },
        required: ["content"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "search_memories") {
    const { query } = args as { query: string };

    if (!query?.trim()) {
      throw new Error("query must be a non-empty string");
    }

    const results = await search(query, db, embedder, { topK: 5 });

    const payload = results.map((r) => ({
      content: r.memory.content,
      file_path: r.memory.file_path,
      score: parseFloat(r.finalScore.toFixed(4)),
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  }

  if (name === "save_memory") {
    const { content, file_path = "cursor-chat" } = args as {
      content: string;
      file_path?: string;
    };

    if (!content?.trim()) {
      throw new Error("content must be a non-empty string");
    }

    const { id } = await saveWithDedup(content, file_path, db, embedder);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ id, saved: true }),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Cortex MCP server error:", err);
  process.exit(1);
});
