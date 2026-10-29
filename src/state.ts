import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionIdentity } from "./session.js";

export interface UnfinishedTask {
  conversationId: string;
  messageId: string;
  state: "queued" | "running";
}

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
        PRIMARY KEY (channel, account_id, peer_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS unfinished_tasks (
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running')),
        PRIMARY KEY (channel, account_id, peer_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS channel_cursors (
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        cursor TEXT NOT NULL,
        PRIMARY KEY (channel, account_id)
      );
    `);
  }

  claimMessage(identity: SessionIdentity, messageId: string, isTask = false): boolean {
    const { channel, accountId, conversationId } = identity;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO processed_messages (channel, account_id, peer_id, message_id)
        VALUES (?, ?, ?, ?)
      `).run(channel, accountId, conversationId, messageId);
      if (result.changes > 0 && isTask) {
        this.database.prepare(`
          INSERT INTO unfinished_tasks (channel, account_id, peer_id, message_id, state)
          VALUES (?, ?, ?, ?, 'queued')
        `).run(channel, accountId, conversationId, messageId);
      }
      this.database.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  startTask(identity: SessionIdentity, messageId: string): void {
    this.database.prepare(`
      UPDATE unfinished_tasks SET state = 'running'
      WHERE channel = ? AND account_id = ? AND peer_id = ? AND message_id = ?
    `).run(identity.channel, identity.accountId, identity.conversationId, messageId);
  }

  finishTask(identity: SessionIdentity, messageId: string): void {
    this.database.prepare(`
      DELETE FROM unfinished_tasks WHERE channel = ? AND account_id = ? AND peer_id = ? AND message_id = ?
    `).run(identity.channel, identity.accountId, identity.conversationId, messageId);
  }

  unfinishedTasks(channel: string, accountId: string): UnfinishedTask[] {
    return this.database.prepare(`
      SELECT peer_id AS conversationId, message_id AS messageId, state
      FROM unfinished_tasks WHERE channel = ? AND account_id = ? ORDER BY rowid
    `).all(channel, accountId) as unknown as UnfinishedTask[];
  }

  getCursor(channel: string, accountId: string): string {
    const row = this.database.prepare("SELECT cursor FROM channel_cursors WHERE channel = ? AND account_id = ?")
      .get(channel, accountId) as { cursor: string } | undefined;
    return row?.cursor ?? "";
  }

  saveCursor(channel: string, accountId: string, cursor: string): void {
    this.database.prepare(`
      INSERT INTO channel_cursors (channel, account_id, cursor) VALUES (?, ?, ?)
      ON CONFLICT (channel, account_id) DO UPDATE SET cursor = excluded.cursor
    `).run(channel, accountId, cursor);
  }

  close(): void {
    this.database.close();
  }
}
