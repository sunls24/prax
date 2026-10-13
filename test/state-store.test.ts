import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { StateStore } from "../src/state.js";

describe("StateStore", () => {
  it("persists message claims across restarts without mixing peers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prax-state-"));
    const path = join(directory, "state.sqlite");
    let store = new StateStore(path);
    onTestFinished(async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    });
    expect(store.claimMessage("telegram", "default", "chat-a", "1")).toBe(true);
    store.close();
    store = new StateStore(path);
    expect(store.claimMessage("telegram", "default", "chat-a", "1")).toBe(false);
    expect(store.claimMessage("telegram", "default", "chat-b", "1")).toBe(true);
  });
});
