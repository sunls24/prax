import { access, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentStoppedError, AgentTimeoutError, PraxAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";

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
      prompt: (text: string) => agent.prompt("test", "123", text),
      stop: () => agent.stop("test", "123"),
      reset: () => agent.reset("test", "123"),
      status: () => agent.status("test", "123"),
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
    const workspacePath = agent.agent.getWorkspacePath("test", "123");
    expect(await readFile(join(workspacePath, "note.txt"), "utf8")).toBe("hello");
    expect(requests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
    const hasHistory = agent.status().hasHistory;
    await agent.dispose();

    const restored = await createAgent();
    // Session 需要在第一次调用时才被加载，所以先 prompt 再检查 hasHistory
    expect(await restored.prompt("continue the conversation")).toBe("done");
    expect(restored.status().hasHistory).toBe(hasHistory);
    expect(JSON.stringify(requests[2]?.messages)).toContain("write a note");
    const sessionsPath = join(config.sessionsDir, "test-123");
    const [currentFile] = await readdir(sessionsPath);
    await writeFile(join(sessionsPath, "older-session.jsonl"), await readFile(join(sessionsPath, currentFile!)));
    await writeFile(join(sessionsPath, "keep.txt"), "not a session");
    await restored.reset();
    expect(restored.status().hasHistory).toBe(false);
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
    const sessionsPath = join(config.sessionsDir, "test-123");
    const [currentFile] = await readdir(sessionsPath);
    const history = await readFile(join(sessionsPath, currentFile!), "utf8");
    const olderFile = join(sessionsPath, "older-session.jsonl");
    await writeFile(olderFile, history);
    const error = Object.assign(new Error("cannot clear history"), { code: "EACCES" });
    if (operation === "reading") vi.mocked(readdir).mockRejectedValueOnce(error);
    else vi.mocked(unlink).mockRejectedValueOnce(error);

    await expect(agent.reset()).rejects.toBe(error);
    expect(agent.status().hasHistory).toBe(true);
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
    expect(agent.status().running).toBe(false);
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
    await agent.prompt("test", "123", "write the first note");
    await agent.prompt("test", "456", "write the second note");

    expect(await readFile(join(agent.getWorkspacePath("test", "123"), "home-note.txt"), "utf8")).toBe("first");
    expect(await readFile(join(agent.getWorkspacePath("test", "456"), "home-note.txt"), "utf8")).toBe("second");
    await expect(access(join(config.workspaceDir, "home-note.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels a streaming request and reports the task as stopped", async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const { createAgent } = await fixture((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": waiting\n\n");
      started();
    });
    const agent = await createAgent();
    const result = expect(agent.prompt("wait")).rejects.toBeInstanceOf(AgentStoppedError);
    await requestStarted;
    expect(agent.status().running).toBe(true);
    expect(await agent.stop()).toBe(true);
    await result;
    expect(agent.status().running).toBe(false);
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
    expect(agent.status().running).toBe(false);
  });
});
