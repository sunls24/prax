import { access, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentStoppedError, AgentTimeoutError, PraxAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { sessionPath } from "../src/session.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const identity = { channel: "test", accountId: "default", conversationId: "123" };

vi.mock("node:fs/promises", { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function streamReply(response: ServerResponse, delta: object, finishReason = "stop"): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (value: object) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: "test-model", ...value })}\n\n`;
  response.end(
    chunk({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }) + "data: [DONE]\n\n",
  );
}

async function fixture(reply: (response: ServerResponse, requestNumber: number) => void, timeoutSeconds = 300) {
  const root = await mkdtemp(join(tmpdir(), "prax-agent-"));
  const requests: Array<{ messages: Array<{ role: string; content?: unknown }>; tools: Array<{ function: { name: string } }> }> = [];
  const agents: PraxAgent[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    reply(response, requests.length);
  });
  onTestFinished(async () => {
    for (const agent of agents) await agent.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("PRAX_DATA_DIR", undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "unrelated-pi"));
  await writeFile(join(root, "config.json"), JSON.stringify({
    dataDir: ".",
    agent: { provider: "custom-api", model: "test-model", timeoutSeconds },
    telegram: { allowedUserIds: ["42"] },
    webSearch: { enabled: false },
    webFetch: { enabled: true },
  }));
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { "custom-api": {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: [{ id: "test-model", reasoning: false, contextWindow: 64000, maxTokens: 4096 }],
  } } }));
  const config = await loadConfig(join(root, "config.json"));
  const createAgent = async () => {
    const agent = await PraxAgent.create({ config, modelApiKey: "fake-test-key", logger: pino({ enabled: false }) });
    agents.push(agent);
    return {
      agent,
      prompt: (text: string) => agent.prompt(identity, text),
      stop: () => agent.stop(identity),
      reset: () => agent.reset(identity),
      status: () => agent.status(identity),
      dispose: () => agent.dispose(),
    };
  };
  return { root, requests, config, createAgent };
}

describe("PraxAgent with the Pi SDK", () => {
  it("executes a file tool, restores history, resets the conversation, and keeps auth inside app data", async () => {
    const { root, requests, config, createAgent } = await fixture((response, requestNumber) => {
      if (requestNumber === 1) {
        streamReply(response, { tool_calls: [{ index: 0, id: "write-note", type: "function", function: {
          name: "write", arguments: JSON.stringify({ path: "note.txt", content: "hello" }),
        } }] }, "tool_calls");
      } else streamReply(response, { content: "done" });
    });
    await mkdir(config.agentDir, { recursive: true });
    await writeFile(join(config.agentDir, "SYSTEM.md"), "unexpected-system-prompt");
    const agent = await createAgent();
    expect(await agent.prompt("write a note")).toBe("done");
    const systemPrompt = JSON.stringify(requests[0]?.messages.filter((message) => message.role === "system"));
    expect(systemPrompt).toContain("You are an expert coding assistant operating inside pi");
    expect(systemPrompt).toContain("Use edit for precise changes");
    expect(systemPrompt).toContain("你是 Prax，通过 Telegram");
    expect(systemPrompt).not.toContain("unexpected-system-prompt");
    expect(requests[0]?.tools.map((tool) => tool.function.name).sort()).toEqual(["bash", "edit", "read", "web_fetch", "write"]);
    const workspacePath = agent.agent.getWorkspacePath(identity);
    expect(await readFile(join(workspacePath, "note.txt"), "utf8")).toBe("hello");
    expect(requests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
    await agent.dispose();

    const restored = await createAgent();
    expect((await restored.status()).hasHistory).toBe(true);
    expect(requests).toHaveLength(2);
    expect(await restored.prompt("continue the conversation")).toBe("done");
    expect(JSON.stringify(requests[2]?.messages)).toContain("write a note");
    const sessionsPath = sessionPath(config.sessionsDir, identity);
    const [currentFile] = await readdir(sessionsPath);
    await writeFile(join(sessionsPath, "older-session.jsonl"), await readFile(join(sessionsPath, currentFile!)));
    await writeFile(join(sessionsPath, "keep.txt"), "not a session");
    await restored.reset();
    expect((await restored.status()).hasHistory).toBe(false);
    expect(await readdir(sessionsPath)).toEqual(["keep.txt"]);
    await restored.dispose();

    const fresh = await createAgent();
    await fresh.prompt("fresh conversation");
    expect(JSON.stringify(requests[3]?.messages)).not.toContain("write a note");
    expect(await readFile(join(workspacePath, "note.txt"), "utf8")).toBe("hello");
    await expect(access(join(config.agentDir, "auth.json"))).resolves.toBeUndefined();
    await expect(access(join(root, "unrelated-pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["reading", "deleting"] as const)("preserves the current conversation when %s history fails", async (operation) => {
    const { requests, config, createAgent } = await fixture((response) => streamReply(response, { content: "done" }));
    const agent = await createAgent();
    await agent.prompt("old conversation");
    const sessionsPath = sessionPath(config.sessionsDir, identity);
    const [currentFile] = await readdir(sessionsPath);
    const history = await readFile(join(sessionsPath, currentFile!), "utf8");
    const olderFile = join(sessionsPath, "older-session.jsonl");
    await writeFile(olderFile, history);
    const error = Object.assign(new Error("cannot clear history"), { code: "EACCES" });
    if (operation === "reading") vi.mocked(readdir).mockRejectedValueOnce(error);
    else vi.mocked(unlink).mockRejectedValueOnce(error);

    await expect(agent.reset()).rejects.toBe(error);
    expect((await agent.status()).hasHistory).toBe(true);
    expect(await readFile(join(sessionsPath, currentFile!), "utf8")).toBe(history);
    await agent.prompt("continue after failed reset");
    expect(JSON.stringify(requests[1]?.messages)).toContain("old conversation");
  });

  it("reports a provider failure instead of returning task success", async () => {
    const { createAgent } = await fixture((response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid API protocol", type: "invalid_request_error" } }));
    });
    const agent = await createAgent();
    await expect(agent.prompt("work")).rejects.toThrow("invalid API protocol");
    expect((await agent.status()).running).toBe(false);
  });

  it("keeps bash home per session without exposing service credentials", async () => {
    vi.stubEnv("PRAX_MODEL_API_KEY", "synthetic-service-key");
    const { config, createAgent } = await fixture((response, requestNumber) => {
      if (requestNumber === 1 || requestNumber === 3) {
        streamReply(response, { tool_calls: [{ index: 0, id: "write-home-note", type: "function", function: {
          name: "bash", arguments: JSON.stringify({ command: requestNumber === 1
            ? "test -z \"$PRAX_MODEL_API_KEY\" && cd && printf first > home-note.txt"
            : "test -z \"$PRAX_MODEL_API_KEY\" && cd ~ && printf second > home-note.txt" }),
        } }] }, "tool_calls");
      } else streamReply(response, { content: "done" });
    });
    const { agent } = await createAgent();
    await agent.prompt(identity, "write the first note");
    await agent.prompt({ ...identity, conversationId: "456" }, "write the second note");

    expect(await readFile(join(agent.getWorkspacePath(identity), "home-note.txt"), "utf8")).toBe("first");
    expect(await readFile(join(agent.getWorkspacePath({ ...identity, conversationId: "456" }), "home-note.txt"), "utf8")).toBe("second");
    await expect(access(join(config.workspaceDir, "home-note.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors cancellation during prompt preflight before making a model request", async () => {
    const { createAgent, requests } = await fixture((response) => streamReply(response, { content: "done" }));
    const agent = await createAgent();
    const result = expect(agent.prompt("cancel immediately")).rejects.toBeInstanceOf(AgentStoppedError);
    expect(await agent.stop()).toBe(true);
    await result;
    expect(requests).toHaveLength(0);
  });

  it("aborts a request at the configured task deadline", async () => {
    const { createAgent } = await fixture((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": waiting\n\n");
    }, 1);
    const agent = await createAgent();
    await expect(agent.prompt("wait")).rejects.toBeInstanceOf(AgentTimeoutError);
    expect((await agent.status()).running).toBe(false);
  });

  it("initializes one session when status and the first prompt arrive together", async () => {
    const { createAgent, requests } = await fixture((response) => streamReply(response, { content: "done" }));
    const recent = vi.spyOn(SessionManager, "continueRecent");
    const agent = await createAgent();
    await Promise.all([agent.status(), agent.prompt("first message"), agent.status()]);
    expect(recent).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect((await agent.status()).hasHistory).toBe(true);
  });

  it("isolates files and history across accounts and channels on case-insensitive filesystems", async () => {
    const { createAgent, requests } = await fixture((response) => streamReply(response, { content: "done" }));
    const { agent } = await createAgent();
    const first = { ...identity, accountId: "aaN" };
    const second = { ...identity, accountId: "aah" };
    const otherChannel = { ...first, channel: "web" };
    const firstWorkspace = agent.getWorkspacePath(first);
    const secondWorkspace = agent.getWorkspacePath(second);
    expect(new Set([first, second, otherChannel].map((id) => agent.getWorkspacePath(id).toLowerCase())).size).toBe(3);
    await agent.prompt(first, "history for first account");
    await agent.prompt(second, "history for second account");
    await agent.prompt(otherChannel, "history for other channel");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("history for first account");
    expect(JSON.stringify(requests[2]?.messages)).not.toContain("history for first account");
    expect(JSON.stringify(requests[2]?.messages)).not.toContain("history for second account");
    await writeFile(join(firstWorkspace, "note.txt"), "first account file");
    await writeFile(join(secondWorkspace, "note.txt"), "second account file");
    expect(await readFile(join(firstWorkspace, "note.txt"), "utf8")).toBe("first account file");
    await agent.reset(second);
    expect(await readFile(join(secondWorkspace, "note.txt"), "utf8")).toBe("second account file");
    await agent.dispose();

    const restarted = await createAgent();
    expect((await restarted.agent.status(first)).hasHistory).toBe(true);
    expect((await restarted.agent.status(second)).hasHistory).toBe(false);
    expect((await restarted.agent.status(otherChannel)).hasHistory).toBe(true);
    await restarted.agent.prompt(first, "continue");
    expect(JSON.stringify(requests[3]?.messages)).toContain("history for first account");
    expect(JSON.stringify(requests[3]?.messages)).not.toContain("history for second account");
    expect(JSON.stringify(requests[3]?.messages)).not.toContain("history for other channel");
  });

  it("serializes one conversation while another runs and resets independently", async () => {
    const { createAgent, requests } = await fixture((response, requestNumber) => {
      if (requestNumber === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": waiting\n\n");
      } else streamReply(response, { content: "done" });
    });
    const { agent } = await createAgent();
    const other = { ...identity, accountId: "other" };
    const completed: string[] = [];
    const cancel = vi.fn(async () => {});
    agent.enqueue(identity, async () => {
      try { await agent.prompt(identity, "first"); }
      catch (error) {
        if (!(error instanceof AgentStoppedError)) throw error;
        completed.push("first stopped");
      }
    }, cancel);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    agent.enqueue(identity, async () => { await agent.prompt(identity, "second"); completed.push("second"); }, cancel);
    agent.enqueue(other, async () => { await agent.prompt(other, "independent"); completed.push("independent"); }, cancel);
    await vi.waitFor(() => expect(completed).toEqual(["independent"]));
    expect(await agent.status(identity)).toMatchObject({ running: true, pending: 1 });
    expect(await agent.status(other)).toMatchObject({ running: false, pending: 0 });
    await agent.reset(other);
    expect((await agent.status(other)).hasHistory).toBe(false);
    expect(await agent.stop(identity)).toBe(true);
    await vi.waitFor(() => expect(completed).toEqual(["independent", "first stopped", "second"]));
    expect(requests).toHaveLength(3);
    expect(cancel).not.toHaveBeenCalled();
    expect(await agent.status(identity)).toMatchObject({ running: false, pending: 0 });
  });

  it("waits for a reset before processing a new prompt or status query", async () => {
    const { createAgent, requests } = await fixture((response) => streamReply(response, { content: "done" }));
    const agent = await createAgent();
    await agent.prompt("old conversation");
    await Promise.all([agent.reset(), agent.status(), agent.prompt("new conversation")]);
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("old conversation");
    expect((await agent.status()).hasHistory).toBe(true);
  });

  it("aborts running work and waits for queued cancellation during shutdown", async () => {
    const { createAgent, requests } = await fixture((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": waiting\n\n");
    });
    const { agent } = await createAgent();
    const stopped = vi.fn();
    const queuedRun = vi.fn(async () => {});
    let finishCancellation!: () => void;
    const cancel = vi.fn(() => new Promise<void>((resolve) => { finishCancellation = resolve; }));
    agent.enqueue(identity, async () => {
      try { await agent.prompt(identity, "running"); }
      catch (error) {
        if (!(error instanceof AgentStoppedError)) throw error;
        stopped();
      }
    }, cancel);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    agent.enqueue(identity, queuedRun, cancel);
    const finished = vi.fn();
    const shutdown = agent.stopAll().then(finished);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(stopped).toHaveBeenCalledOnce();
    expect(queuedRun).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    finishCancellation();
    await shutdown;
    expect(() => agent.enqueue(identity, queuedRun, cancel)).toThrow("shutting down");
  });

  it("exposes workspace write failures to the model without changing outside files", async () => {
    const { createAgent, requests } = await fixture((response, requestNumber) => {
      if (requestNumber === 1) streamReply(response, { tool_calls: [{ index: 0, id: "outside-write", type: "function", function: {
        name: "write", arguments: JSON.stringify({ path: "../outside.txt", content: "changed" }),
      } }] }, "tool_calls");
      else streamReply(response, { content: "done" });
    });
    const agent = await createAgent();
    expect(await agent.prompt("write a file")).toBe("done");
    expect(JSON.stringify(requests[1]?.messages.filter((message) => message.role === "tool"))).toContain("inside the current workspace");
    await expect(access(join(agent.agent.getWorkspacePath(identity), "../outside.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

});
