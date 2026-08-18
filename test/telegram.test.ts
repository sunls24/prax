import { describe, expect, it } from "vitest";
import { splitTelegramText, telegramReplyParameters } from "../src/channels/telegram.js";

describe("splitTelegramText", () => {
  it("keeps short messages intact", () => {
    expect(splitTelegramText("hello")).toEqual(["hello"]);
  });

  it("splits long messages without exceeding Telegram limits", () => {
    const chunks = splitTelegramText(`${"word ".repeat(2000)}done`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toContain("done");
  });
});

describe("telegramReplyParameters", () => {
  it("maps a valid inbound message id to Telegram reply parameters", () => {
    expect(telegramReplyParameters({ messageId: 42 })).toEqual({ message_id: 42 });
  });

  it("ignores invalid reply context", () => {
    expect(telegramReplyParameters({ messageId: "42" })).toBeUndefined();
  });
});
