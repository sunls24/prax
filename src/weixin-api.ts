import { randomBytes, randomUUID } from "node:crypto";
import { readJsonFile } from "./config.js";

export interface WeixinAccount {
  bot_token: string;
  ilink_bot_id: string;
  baseurl: string;
}

export async function loadWeixinAccount(path: string): Promise<WeixinAccount> {
  const value = await readJsonFile(path);
  if (value === undefined) throw new Error(`Missing Weixin account: ${path}`);
  return parseWeixinAccount(value);
}

export function parseWeixinAccount(value: unknown): WeixinAccount {
  if (!value || typeof value !== "object") throw new Error("Invalid Weixin account");
  const account = value as Record<string, unknown>;
  for (const key of ["bot_token", "ilink_bot_id", "baseurl"]) {
    if (typeof account[key] !== "string" || !account[key].trim()) {
      throw new Error(`Invalid Weixin account field: ${key}`);
    }
  }
  const url = new URL(account.baseurl as string);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Weixin baseurl must be an HTTPS API address without credentials, query or fragment");
  }
  return {
    bot_token: (account.bot_token as string).trim(),
    ilink_bot_id: (account.ilink_bot_id as string).trim(),
    baseurl: url.href,
  };
}

export class WeixinApiError extends Error {
  constructor(operation: string, readonly code: number, description: string) {
    super(`Weixin ${operation} failed (${code}): ${description}`);
    this.name = "WeixinApiError";
  }

  get credentialsRejected(): boolean {
    return this.code === -14 || this.code === 401 || this.code === 403;
  }
}

export class WeixinApi {
  constructor(private readonly account: WeixinAccount) {}

  private async request(operation: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal,
    contextToken?: string): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(new URL(`ilink/bot/${operation}`, `${this.account.baseurl.replace(/\/$/, "")}/`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${this.account.bot_token}`,
        "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64"),
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": "256", // Prax 0.1.0, encoded as 0x00MMNNPP.
      },
      body: JSON.stringify({ ...body, base_info: { channel_version: "0.1.0", bot_agent: "Prax/0.1.0" } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new WeixinApiError(operation, response.status, response.statusText);
    // Node 24 exposes the original numeric token, before Number loses uint64 precision.
    const value: unknown = JSON.parse(await response.text(), (key: string, value: unknown, context?: { source?: string }) =>
      key === "message_id" && typeof value === "number" ? context!.source! : value);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid Weixin ${operation} response`);
    }
    const result = value as Record<string, unknown>;
    for (const key of ["ret", "errcode"]) {
      const code = result[key];
      if (code !== undefined && (typeof code !== "number" || !Number.isFinite(code))) {
        throw new Error(`Invalid Weixin ${operation} ${key}`);
      }
    }
    const code = result.ret === -14 || result.errcode === -14 ? -14 : (result.errcode || result.ret || 0) as number;
    if (code !== 0) {
      let description = typeof result.errmsg === "string" ? result.errmsg : "request rejected";
      for (const secret of [this.account.bot_token, contextToken]) {
        if (secret) description = description.replaceAll(secret, "[REDACTED]");
      }
      throw new WeixinApiError(operation, code, description);
    }
    return result;
  }

  async getUpdates(cursor: string, timeoutMs: number, signal: AbortSignal): Promise<{
    messages: unknown[];
    cursor?: string;
    timeoutMs?: number;
  }> {
    const result = await this.request("getupdates", { get_updates_buf: cursor }, timeoutMs + 5000, signal);
    if (result.msgs !== undefined && !Array.isArray(result.msgs)) throw new Error("Invalid Weixin message list");
    if (result.get_updates_buf !== undefined && typeof result.get_updates_buf !== "string") {
      throw new Error("Invalid Weixin update cursor");
    }
    const timeout = result.longpolling_timeout_ms;
    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0
      || timeout > 2 ** 31 - 5001)) throw new Error("Invalid Weixin long-poll timeout");
    return {
      messages: (result.msgs ?? []) as unknown[],
      ...(result.get_updates_buf ? { cursor: result.get_updates_buf as string } : {}),
      ...(timeout !== undefined ? { timeoutMs: timeout as number } : {}),
    };
  }

  async sendText(to: string, text: string, contextToken: string): Promise<void> {
    await this.request("sendmessage", { msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: `prax-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    } }, 15_000, undefined, contextToken);
  }
}
