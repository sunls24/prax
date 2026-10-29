import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { StateStore } from "../src/state.js";
import { DatabaseSync } from "node:sqlite";

describe("StateStore", () => {
  it("persists task states and message claims across restarts without mixing sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prax-task-state-"));
    const path = join(directory, "state.sqlite");
    let store = new StateStore(path);
    onTestFinished(async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    });
    const identity = { channel: "telegram", accountId: "bot-a", conversationId: "42" };
    expect(store.claimMessage(identity, "1", true)).toBe(true);
    expect(store.claimMessage(identity, "2", true)).toBe(true);
    store.startTask(identity, "2");
    store.claimMessage({ ...identity, accountId: "bot-b" }, "1", true);
    store.claimMessage({ ...identity, channel: "web" }, "1", true);
    store.claimMessage(identity, "3");
    expect(store.getCursor("weixin", "bot-a")).toBe("");
    store.saveCursor("weixin", "bot-a", "first-cursor");
    store.saveCursor("weixin", "bot-a", "second-cursor");
    store.saveCursor("weixin", "bot-b", "other-account");
    store.saveCursor("telegram", "bot-a", "other-channel");
    const otherPeer = { ...identity, conversationId: "43" };
    expect(store.claimMessage(otherPeer, "1")).toBe(true);
    store.close();
    store = new StateStore(path);
    expect(store.getCursor("weixin", "bot-a")).toBe("second-cursor");
    expect(store.getCursor("weixin", "bot-b")).toBe("other-account");
    expect(store.getCursor("telegram", "bot-a")).toBe("other-channel");
    expect(store.unfinishedTasks("telegram", "bot-a")).toEqual([
      { conversationId: "42", messageId: "1", state: "queued" },
      { conversationId: "42", messageId: "2", state: "running" },
    ]);
    expect(store.unfinishedTasks("telegram", "bot-b")).toHaveLength(1);
    expect(store.unfinishedTasks("web", "bot-a")).toHaveLength(1);
    store.finishTask(identity, "1");
    store.finishTask(identity, "2");
    expect(store.unfinishedTasks("telegram", "bot-a")).toEqual([]);
    expect(store.claimMessage(identity, "1", true)).toBe(false);
    expect(store.claimMessage(identity, "3")).toBe(false);
    expect(store.claimMessage(otherPeer, "1")).toBe(false);
  });

  it("rolls back a message claim if the task record cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prax-task-claim-"));
    const path = join(directory, "state.sqlite");
    const store = new StateStore(path);
    const database = new DatabaseSync(path);
    onTestFinished(async () => {
      database.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });
    database.exec("CREATE TRIGGER fail_task BEFORE INSERT ON unfinished_tasks BEGIN SELECT RAISE(ABORT, 'task insert failed'); END");
    const identity = { channel: "telegram", accountId: "default", conversationId: "42" };
    expect(() => store.claimMessage(identity, "1", true)).toThrow("task insert failed");
    database.exec("DROP TRIGGER fail_task");
    expect(store.claimMessage(identity, "1", true)).toBe(true);
    expect(store.unfinishedTasks("telegram", "default")).toHaveLength(1);
  });
});
