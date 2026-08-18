import { readFile } from "node:fs/promises";

export async function readSecret(name: string, required = true, defaultFilePath?: string): Promise<string | undefined> {
  const filePath = process.env[`${name}_FILE`];
  const directValue = process.env[name];
  let value = directValue;
  if (filePath) value = await readFile(filePath, "utf8");
  else if (!value && defaultFilePath) {
    value = await readFile(defaultFilePath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
  }
  const trimmed = value?.trim();

  if (!trimmed && required) {
    throw new Error(`Missing secret: set ${name}_FILE or ${name}`);
  }

  return trimmed || undefined;
}

const SAFE_ENV_NAMES = ["PATH", "LANG", "LC_ALL", "TERM", "TZ"] as const;

export function createSafeCommandEnv(workspaceDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: workspaceDir,
    PWD: workspaceDir,
    TMPDIR: "/tmp",
  };
  for (const name of SAFE_ENV_NAMES) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}
