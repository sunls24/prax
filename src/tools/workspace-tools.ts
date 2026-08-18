import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

function isInside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

async function nearestExistingPath(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function assertWorkspacePath(workspaceDir: string, inputPath: string, allowMissing = false): Promise<void> {
  const workspaceRoot = await realpath(workspaceDir);
  const resolvedPath = resolve(workspaceRoot, inputPath);
  if (!isInside(workspaceRoot, resolvedPath)) throw new Error("Path is outside the workspace");

  const existingPath = allowMissing ? await nearestExistingPath(resolvedPath) : resolvedPath;
  const realExistingPath = await realpath(existingPath);
  if (!isInside(workspaceRoot, realExistingPath)) throw new Error("Path resolves outside the workspace");
}

function guardPathTool(
  definition: ToolDefinition<any, any, any>,
  workspaceDir: string,
  allowMissing: boolean,
): ToolDefinition<any, any, any> {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const input = params as { path?: unknown };
      if (typeof input.path !== "string") throw new Error("Tool path must be a string");
      await assertWorkspacePath(workspaceDir, input.path, allowMissing);
      return definition.execute(toolCallId, params, signal, onUpdate, context);
    },
  };
}

export function createWorkspaceToolDefinitions(workspaceDir: string): ToolDefinition<any, any, any>[] {
  return [
    guardPathTool(createReadToolDefinition(workspaceDir), workspaceDir, false),
    guardPathTool(createEditToolDefinition(workspaceDir), workspaceDir, false),
    guardPathTool(createWriteToolDefinition(workspaceDir), workspaceDir, true),
  ];
}
