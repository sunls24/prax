import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class StateStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS processed_messages (
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        processed_at INTEGER NOT NULL,
        PRIMARY KEY (channel, account_id, peer_id, message_id)
      );
    `);
  }

  claimMessage(channel: string, accountId: string, peerId: string, messageId: string): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO processed_messages (channel, account_id, peer_id, message_id, processed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(channel, accountId, peerId, messageId, Date.now());
    return result.changes > 0;
  }

  close(): void {
    this.database.close();
  }
}
