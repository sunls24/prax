import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createEditToolDefinition, createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";

function isOutside(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/** Guard file tools against accidental traversal and symlinks; bash remains trusted. */
export async function createWorkspaceFileTools(workspace: string): Promise<ToolDefinition<any, any>[]> {
  const root = await realpath(workspace);
  async function checkedPath(path: string): Promise<string> {
    let suffix = relative(resolve(workspace), path);
    if (isOutside(suffix)) suffix = relative(root, path);
    if (isOutside(suffix)) throw new Error("File changes must stay inside the current workspace");
    let current = root;
    const parts = suffix.split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return join(current, ...parts.slice(index + 1));
      }
      if (info.isSymbolicLink()) {
        current = await realpath(current);
        if (isOutside(relative(root, current))) throw new Error("File changes must stay inside the current workspace");
      }
    }
    return current;
  }
  const write = async (path: string, content: string) => {
    await writeFile(await checkedPath(path), content, "utf8");
  };
  return [
    createWriteToolDefinition(workspace, { operations: {
      mkdir: async (path) => { await mkdir(await checkedPath(path), { recursive: true }); },
      writeFile: write,
    } }),
    createEditToolDefinition(workspace, { operations: {
      access: async (path) => { await access(await checkedPath(path), constants.R_OK | constants.W_OK); },
      readFile: async (path) => readFile(await checkedPath(path)),
      writeFile: write,
    } }),
  ];
}
