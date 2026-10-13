import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

let directory: string;
beforeEach(async () => {
  vi.stubEnv("PRAX_DATA_DIR", undefined);
  directory = await mkdtemp(join(tmpdir(), "prax-config-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("applies defaults and resolves dataDir relative to the config file", async () => {
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
    expect(config.webSearch.enabled).toBe(false);
  });

  it("rejects an empty owner allowlist", async () => {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      agent: { provider: "anthropic", model: "claude-sonnet-4-6" },
      telegram: { allowedUserIds: [] },
    }));

    await expect(loadConfig(path)).rejects.toThrow("allowedUserIds");
  });

  it("reports missing config and malformed JSON instead of silently using defaults", async () => {
    const path = join(directory, "config.json");
    await expect(loadConfig(path)).rejects.toThrow("Run the config command first");
    await writeFile(path, "{broken");
    await expect(loadConfig(path)).rejects.toThrow("Unable to load JSON");
  });
});
