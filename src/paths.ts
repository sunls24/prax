import { resolve } from "node:path";

export function dataDir(): string {
  return resolve(process.env.PRAX_DATA_DIR ?? "./data");
}

export function configPath(): string {
  return resolve(process.env.PRAX_CONFIG ?? resolve(dataDir(), "config.json"));
}
