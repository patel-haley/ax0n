import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import * as path from "path";

export interface Memory {
  id: string;
  content: string;
  file_path: string;
  timestamp: number;
  access_count: number;
  last_accessed: number | null;
  used: number;
  vector: string | null;
}

export interface MemoryWithVector extends Omit<Memory, "vector"> {
  vector: Float32Array | null;
}

function serializeVector(v: Float32Array): string {
  return JSON.stringify(Array.from(v));
}

function deserializeVector(s: string | null): Float32Array | null {
  if (s === null) {
    return null;
  }
  return new Float32Array(JSON.parse(s));
}

export class CortexDatabase {
  private db: Database.Database;

  constructor(storagePath: string, nativeBinding?: string) {
    const dbPath = path.join(storagePath, "cortex.db");
    this.db = nativeBinding
      ? new Database(dbPath, { nativeBinding } as Database.Options)
      : new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY,
        content       TEXT,
        file_path     TEXT,
        timestamp     INTEGER,
        access_count  INTEGER DEFAULT 0,
        last_accessed INTEGER,
        used          INTEGER DEFAULT 0,
        vector        TEXT
      );
    `);
  }

  saveMemory(content: string, filePath: string): Memory {
    const row: Memory = {
      id: randomUUID(),
      content,
      file_path: filePath,
      timestamp: Date.now(),
      access_count: 0,
      last_accessed: null,
      used: 0,
      vector: null,
    };

    this.db
      .prepare(
        `INSERT INTO memories
           (id, content, file_path, timestamp, access_count, last_accessed, used, vector)
         VALUES
           (@id, @content, @file_path, @timestamp, @access_count, @last_accessed, @used, @vector)`
      )
      .run(row);

    return row;
  }

  updateMemory(id: string, content: string): void {
    this.db
      .prepare("UPDATE memories SET content = ?, timestamp = ? WHERE id = ?")
      .run(content, Date.now(), id);
  }

  saveVector(id: string, vector: Float32Array): void {
    this.db
      .prepare("UPDATE memories SET vector = ? WHERE id = ?")
      .run(serializeVector(vector), id);
  }

  getMemory(id: string): Memory | undefined {
    return this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as Memory | undefined;
  }

  getMemoryWithVector(id: string): MemoryWithVector | undefined {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as Memory | undefined;

    if (!row) {
      return undefined;
    }

    return { ...row, vector: deserializeVector(row.vector) };
  }

  getAllMemories(): Memory[] {
    return this.db
      .prepare("SELECT * FROM memories ORDER BY timestamp DESC")
      .all() as Memory[];
  }

  getAllMemoriesWithVectors(): MemoryWithVector[] {
    const rows = this.db
      .prepare("SELECT * FROM memories ORDER BY timestamp DESC")
      .all() as Memory[];

    return rows.map((row) => ({ ...row, vector: deserializeVector(row.vector) }));
  }

  pruneStaleMemories(): number {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return this.db
      .prepare("DELETE FROM memories WHERE access_count = 0 AND timestamp < ?")
      .run(cutoff).changes;
  }

  close(): void {
    this.db.close();
  }
}
