import { randomBytes } from "node:crypto";
import { stdout } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { confirm, input } from "@inquirer/prompts";
import qrcode from "qrcode-terminal";
import { parseWeixinAccount, type WeixinAccount } from "./weixin-api.js";

const LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com/";

async function request(url: URL, signal: AbortSignal, existing?: WeixinAccount): Promise<Record<string, unknown>> {
  const creating = url.pathname.endsWith("/get_bot_qrcode");
  const response = await fetch(url, {
    method: creating ? "POST" : "GET",
    headers: {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": "256",
      ...(creating ? {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64"),
      } : {}),
    },
    ...(creating ? { body: JSON.stringify({ local_token_list: existing ? [existing.bot_token] : [] }) } : {}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`微信登录请求失败（HTTP ${response.status}）`);
  let result: unknown;
  try { result = await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("微信登录返回了无效 JSON，已停止登录");
    throw error;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("微信登录响应格式无效");
  const data = result as Record<string, unknown>;
  for (const field of ["ret", "errcode"]) {
    if (data[field] !== undefined && data[field] !== 0) {
      // Do not print server descriptions: they may contain login credentials.
      throw new Error(`微信登录请求被拒绝（${field}：${typeof data[field] === "number" ? data[field] : "无效错误码"}）`);
    }
  }
  return data;
}

export async function loginWeixin(existing?: WeixinAccount): Promise<{
  account: WeixinAccount;
  userId?: string;
  reused: boolean;
}> {
  stdout.write("取消本地保存不会撤销已完成的微信登录。\n");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const deadline = AbortSignal.timeout(8 * 60_000);
  const signal = AbortSignal.any([controller.signal, deadline]);
  try {
    while (true) {
      signal.throwIfAborted();
      const qr = await request(new URL("ilink/bot/get_bot_qrcode?bot_type=3", LOGIN_BASE_URL), signal, existing);
      if (typeof qr.qrcode !== "string" || !qr.qrcode || typeof qr.qrcode_img_content !== "string" || !qr.qrcode_img_content) {
        throw new Error("微信登录未返回有效二维码");
      }
      stdout.write("\n请用微信扫码：\n");
      qrcode.generate(qr.qrcode_img_content, { small: true }, (code) => stdout.write(`${code}\n`));
      stdout.write(`备用链接：${qr.qrcode_img_content}\n`);
      let baseUrl = LOGIN_BASE_URL;
      let verifyCode: string | undefined;
      let scanned = false;
      while (true) {
        const url = new URL("ilink/bot/get_qrcode_status", baseUrl);
        url.searchParams.set("qrcode", qr.qrcode);
        if (verifyCode) url.searchParams.set("verify_code", verifyCode);
        let status: Record<string, unknown>;
        try { status = await request(url, signal); }
        catch (error) {
          if (!signal.aborted && error instanceof Error && error.name === "TimeoutError") {
            stdout.write("微信登录状态请求超时，继续等待。\n");
            continue;
          }
          throw error;
        }
        switch (status.status) {
          case "wait":
            break;
          case "scaned":
            verifyCode = undefined;
            if (!scanned) stdout.write("已扫码，请在微信确认。\n");
            scanned = true;
            break;
          case "need_verifycode":
            verifyCode = (await input({
              message: verifyCode ? "验证码不匹配，请重新输入手机微信显示的数字" : "输入手机微信显示的数字",
              validate: (value) => /^\d+$/.test(value.trim()) || "请输入手机微信显示的数字。",
            }, { signal })).trim();
            continue;
          case "scaned_but_redirect": {
            if (typeof status.redirect_host !== "string" || !status.redirect_host) throw new Error("微信登录缺少重定向地址");
            const redirect = new URL(`https://${status.redirect_host}`);
            if (redirect.host !== status.redirect_host || redirect.username || redirect.password || redirect.pathname !== "/" || redirect.search || redirect.hash) {
              throw new Error("微信登录重定向地址无效");
            }
            baseUrl = redirect.href;
            stdout.write("正在连接微信登录服务。\n");
            break;
          }
          case "confirmed": {
            const account = parseWeixinAccount(status);
            if (status.ilink_user_id !== undefined && (typeof status.ilink_user_id !== "string" || !status.ilink_user_id.trim())) {
              throw new Error("微信登录返回的用户 ID 无效");
            }
            stdout.write("微信登录成功，凭据待保存。\n");
            return { account, reused: false, ...(typeof status.ilink_user_id === "string" ? { userId: status.ilink_user_id.trim() } : {}) };
          }
          case "binded_redirect":
            if (!existing) throw new Error("微信提示已绑定，但本地没有凭据。请检查微信绑定状态后重新登录。");
            stdout.write("已绑定，沿用本地凭据。\n");
            return { account: existing, reused: true };
          case "verify_code_blocked":
            throw new Error("微信验证码尝试次数过多，已停止登录，请稍后重试。");
          case "expired":
            if (!await confirm({ message: "二维码已过期，重新获取？", default: true }, { signal })) {
              const error = new Error("已取消微信登录");
              error.name = "ExitPromptError";
              throw error;
            }
            break;
          default:
            throw new Error("微信返回了无法识别的登录状态，已停止登录");
        }
        if (status.status === "expired") break;
        await delay(1000, undefined, { signal });
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const cancelled = new Error("已取消微信登录");
      cancelled.name = "ExitPromptError";
      throw cancelled;
    }
    if (deadline.aborted) throw new Error("微信登录超时，请重新运行配置命令。");
    throw error;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
