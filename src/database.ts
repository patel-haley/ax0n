import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import * as path from "path";

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class CortexDatabase {
  private db: Database.Database;

  constructor(storagePath: string) {
    const dbPath = path.join(storagePath, "cortex.db");
    this.db = new Database(dbPath);

    // WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");

    this._migrate();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id           TEXT PRIMARY KEY,
        content      TEXT,
        file_path    TEXT,
        timestamp    INTEGER,
        access_count INTEGER DEFAULT 0,
        last_accessed INTEGER,
        used         INTEGER DEFAULT 0,
        vector       TEXT
      );
    `);
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  getMemory(id: string): Memory | undefined {
    return this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as Memory | undefined;
  }

  getAllMemories(): Memory[] {
    return this.db
      .prepare("SELECT * FROM memories ORDER BY timestamp DESC")
      .all() as Memory[];
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
