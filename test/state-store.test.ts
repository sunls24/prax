import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/storage/state-store.js";

describe("StateStore", () => {
  it("claims a channel message only once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prax-state-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    expect(store.claimMessage("telegram", "default", "chat-a", "1")).toBe(true);
    expect(store.claimMessage("telegram", "default", "chat-a", "1")).toBe(false);
    expect(store.claimMessage("telegram", "default", "chat-b", "1")).toBe(true);
    store.close();
  });
});
