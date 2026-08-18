import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults and resolves dataDir relative to the config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prax-config-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      dataDir: "runtime",
      agent: { provider: "anthropic", model: "claude-sonnet-4-6" },
      telegram: { allowedUserIds: ["42"] },
    }));

    const config = await loadConfig(path);

    expect(config.dataDir).toBe(join(directory, "runtime"));
    expect(config.workspaceDir).toBe(join(directory, "runtime", "workspace"));
    expect(config.agent.timeoutSeconds).toBe(300);
    expect(config.webSearch.provider).toBe("tavily");
  });

  it("rejects an empty owner allowlist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prax-config-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      agent: { provider: "anthropic", model: "claude-sonnet-4-6" },
      telegram: { allowedUserIds: [] },
    }));

    await expect(loadConfig(path)).rejects.toThrow("allowedUserIds");
  });
});
