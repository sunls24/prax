import { readFile } from "node:fs/promises";

export function redactTelegramToken(text: string): string {
  return text.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot[REDACTED]");
}

export function readSecret(name: string | undefined, required: true, defaultFilePath?: string): Promise<string>;
export function readSecret(name: string | undefined, required: false, defaultFilePath?: string): Promise<string | undefined>;
export async function readSecret(name: string | undefined, required: boolean, defaultFilePath?: string): Promise<string | undefined> {
  const filePath = name ? process.env[`${name}_FILE`] : undefined;
  const directValue = name ? process.env[name] : undefined;
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
    throw new Error(name ? `Missing secret: set ${name}_FILE or ${name}` : `Missing secret: ${defaultFilePath}`);
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
