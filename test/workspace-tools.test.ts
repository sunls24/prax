import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { createWorkspaceFileTools } from "../src/workspace-tools.js";

let root: string;
let workspace: string;
let tools: Awaited<ReturnType<typeof createWorkspaceFileTools>>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prax-file-tools-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  tools = await createWorkspaceFileTools(workspace);
  onTestFinished(() => rm(root, { recursive: true, force: true }));
});

function execute(name: string, args: object) {
  return tools.find((tool) => tool.name === name)!.execute("test", args, undefined, undefined, { cwd: workspace } as any);
}

describe("workspace file tools", () => {
  it("creates nested files and edits them through an in-workspace symlink", async () => {
    await execute("write", { path: "notes/note.txt", content: "first\n" });
    await symlink(join(workspace, "notes"), join(workspace, "notes-link"));
    await execute("edit", { path: "notes-link/note.txt", edits: [{ oldText: "first", newText: "second" }] });
    expect(await readFile(join(workspace, "notes/note.txt"), "utf8")).toBe("second\n");
  });

  it.each(["write", "edit"])("rejects traversal and absolute paths outside the workspace for %s", async (name) => {
    const outside = join(root, "outside.txt");
    await writeFile(outside, "keep");
    for (const path of ["../outside.txt", outside, join(root, "workspace-other", "note.txt")]) {
      await expect(execute(name, { path, content: "changed", edits: [{ oldText: "keep", newText: "changed" }] }))
        .rejects.toThrow("inside the current workspace");
    }
    expect(await readFile(outside, "utf8")).toBe("keep");
    await expect(access(join(root, "workspace-other"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["write", "edit"])("rejects file and directory symlinks escaping the workspace for %s", async (name) => {
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside/note.txt"), "keep");
    await symlink(join(root, "outside/note.txt"), join(workspace, "file-link"));
    await symlink(join(root, "outside"), join(workspace, "dir-link"));
    for (const path of ["file-link", "dir-link/note.txt", "dir-link/new/note.txt"]) {
      await expect(execute(name, { path, content: "changed", edits: [{ oldText: "keep", newText: "changed" }] }))
        .rejects.toThrow("inside the current workspace");
    }
    expect(await readFile(join(root, "outside/note.txt"), "utf8")).toBe("keep");
    await expect(access(join(root, "outside/new"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects dangling symlinks without creating their target", async () => {
    const target = join(root, "missing.txt");
    await symlink(target, join(workspace, "dangling"));
    await expect(execute("write", { path: "dangling", content: "changed" })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

});
