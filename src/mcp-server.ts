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

const DB_PATH =
  process.env.CORTEX_DB_PATH ??
  path.join(
    os.homedir(),
    "Library/Application Support/Cursor/User/globalStorage/haleypatel.cortex"
  );

const db = new CortexDatabase(DB_PATH);
const embedder = new Embedder(DB_PATH);

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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "search_memories") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const query = (request.params.arguments as { query: string }).query;

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
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Cortex MCP server error:", err);
  process.exit(1);
});
