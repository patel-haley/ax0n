import * as path from "path";
import { CortexDatabase, MemoryWithVector } from "./database";
import { Embedder } from "./embedder";

export interface SearchResult {
  memory: MemoryWithVector;
  score: number;
  finalScore: number;
  components: {
    relevance: number;
    recency: number;
    frequency: number;
    proximity: number;
  };
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

export function scoreResult(
  result: Pick<SearchResult, "score" | "memory">,
  currentFilePath: string,
  maxAccessCount: number
): SearchResult["components"] & { finalScore: number } {
  const relevance = result.score;

  // Exponential decay: half-life of ~10 days, asymptotes to 0 after 30+ days
  const ageMs = Date.now() - result.memory.timestamp;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recency = Math.exp(-ageDays / 10);

  const frequency =
    maxAccessCount > 0 ? result.memory.access_count / maxAccessCount : 0;

  let proximity = 0;
  if (result.memory.file_path === currentFilePath) {
    proximity = 1.0;
  } else if (
    path.extname(result.memory.file_path) === path.extname(currentFilePath)
  ) {
    proximity = 0.5;
  }

  const finalScore =
    relevance * 0.4 +
    recency * 0.3 +
    frequency * 0.2 +
    proximity * 0.1;

  return { relevance, recency, frequency, proximity, finalScore };
}

export async function search(
  query: string,
  db: CortexDatabase,
  embedder: Embedder,
  options: { topK?: number; threshold?: number; currentFilePath?: string } = {}
): Promise<SearchResult[]> {
  const { topK = 5, threshold = 0.4, currentFilePath = "" } = options;

  const queryVector = await embedder.embed(query);

  const candidates = db
    .getAllMemoriesWithVectors()
    .filter((m) => m.vector !== null);

  const maxAccessCount = Math.max(...candidates.map((m) => m.access_count), 1);

  const results: SearchResult[] = candidates
    .map((memory) => {
      const score = cosine(queryVector, memory.vector as Float32Array);
      return { memory, score, finalScore: 0, components: { relevance: 0, recency: 0, frequency: 0, proximity: 0 } };
    })
    .filter((r) => r.score >= threshold)
    .map((r) => {
      const { finalScore, ...components } = scoreResult(r, currentFilePath, maxAccessCount);
      return { ...r, finalScore, components };
    });

  return results
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, topK);
}
