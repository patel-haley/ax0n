import { CortexDatabase } from "./database";
import { TextEmbedder } from "./embedder";
import { cosine } from "./utils";

export const DEDUP_THRESHOLD = 0.92;

export async function saveWithDedup(
  text: string,
  filePath: string,
  db: CortexDatabase,
  embedder: TextEmbedder,
  log?: (msg: string) => void
): Promise<{ id: string; deduplicated: boolean }> {
  const vector = await embedder.embed(text);

  const existing = db.getAllMemoriesWithVectors().filter((m) => m.vector !== null);

  const duplicate = existing.find(
    (m) => cosine(vector, m.vector as Float32Array) >= DEDUP_THRESHOLD
  );

  if (duplicate) {
    db.updateMemory(duplicate.id, text, filePath);
    db.saveVector(duplicate.id, vector);
    log?.(`deduplicated [${duplicate.id.slice(0, 8)}]`);
    return { id: duplicate.id, deduplicated: true };
  }

  const memory = db.saveMemory(text, filePath);
  db.saveVector(memory.id, vector);
  return { id: memory.id, deduplicated: false };
}
