import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWorkspacePath } from "../src/tools/workspace-tools.js";

describe("assertWorkspacePath", () => {
  it("allows existing files and new files inside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "prax-workspace-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "existing.txt"), "ok");

    await expect(assertWorkspacePath(workspace, "existing.txt")).resolves.toBeUndefined();
    await expect(assertWorkspacePath(workspace, "nested/new.txt", true)).resolves.toBeUndefined();
  });

  it("blocks paths and symlinks that escape the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "prax-workspace-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(workspace, "outside-link"));

    await expect(assertWorkspacePath(workspace, "../outside/secret.txt")).rejects.toThrow("outside");
    await expect(assertWorkspacePath(workspace, "outside-link/secret.txt")).rejects.toThrow("outside");
    await expect(assertWorkspacePath(workspace, "outside-link/new.txt", true)).rejects.toThrow("outside");
  });
});
