import { CortexDatabase, MemoryWithVector } from "./database";
import { Embedder } from "./embedder";

export interface SearchResult {
  memory: MemoryWithVector;
  score: number;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export async function search(
  query: string,
  db: CortexDatabase,
  embedder: Embedder,
  options: { topK?: number; threshold?: number } = {}
): Promise<SearchResult[]> {
  const { topK = 5, threshold = 0.4 } = options;

  const queryVector = await embedder.embed(query);

  const candidates = db
    .getAllMemoriesWithVectors()
    .filter((m) => m.vector !== null);

  return candidates
    .map((memory) => ({
      memory,
      score: cosine(queryVector, memory.vector as Float32Array),
    }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
