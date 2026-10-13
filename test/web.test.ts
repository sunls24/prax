import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPage, TavilySearchProvider } from "../src/web.js";

const http = { fetch: vi.fn<typeof fetch>() };
beforeEach(() => {
  http.fetch.mockReset();
  vi.stubGlobal("fetch", http.fetch);
});

describe("Tavily search", () => {
  it("returns search results with source URLs", async () => {
    http.fetch.mockResolvedValueOnce(Response.json({ results: [{ title: "Example", url: "https://example.test", content: "snippet" }] }));
    const provider = new TavilySearchProvider("synthetic-api-key", 15);
    expect(await provider.search("query", { maxResults: 3 })).toEqual([
      { title: "Example", url: "https://example.test", snippet: "snippet" },
    ]);
    const [, init] = http.fetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: "query", max_results: 3 });
  });

  it("reports API failures instead of returning empty results", async () => {
    const provider = new TavilySearchProvider("synthetic-api-key", 15);
    http.fetch.mockResolvedValueOnce(new Response("invalid key", { status: 401 }));
    await expect(provider.search("query", { maxResults: 3 })).rejects.toThrow("Tavily search failed (401): invalid key");
  });
});
afterEach(() => vi.unstubAllGlobals());
const options = { timeoutSeconds: 15, maxResponseBytes: 4096, maxTextChars: 1000, maxRedirects: 3 };

describe("fetchPage", () => {
  it("rejects local and non-HTTP URLs before making a request", async () => {
    for (const url of [
      "http://localhost/", "http://127.0.0.1/", "http://10.0.0.1/", "http://172.16.0.1/", "http://192.168.1.1/",
      "file:///etc/passwd", "ftp://example.test/",
    ]) {
      await expect(fetchPage(url, options)).rejects.toThrow(/Private|HTTP/);
    }
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it("extracts public page text and truncates it", async () => {
    http.fetch.mockResolvedValueOnce(new Response("中文".repeat(600), { headers: { "content-type": "text/plain" } }));
    const page = await fetchPage("http://example.test", options);
    expect(page.text).toBe("中文".repeat(500));
    expect(page.truncated).toBe(true);
  });

  it("decodes GBK text declared in the response header", async () => {
    http.fetch.mockResolvedValueOnce(new Response(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), {
      headers: { "content-type": 'text/plain; charset="gbk"' },
    }));
    const page = await fetchPage("https://example.test", options);
    expect(page.text).toBe("中文");
  });

  it("rejects private redirect targets and releases the redirect body", async () => {
    const response = new Response("redirect", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    http.fetch.mockResolvedValueOnce(response);
    await expect(fetchPage("https://example.test", options)).rejects.toThrow("Private");
    expect(http.fetch).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });

  it("limits streamed response bytes without relying on Content-Length", async () => {
    http.fetch.mockResolvedValueOnce(new Response("a".repeat(1500), { headers: { "content-type": "text/plain" } }));
    await expect(fetchPage("https://example.test", { ...options, maxResponseBytes: 1024 })).rejects.toThrow("exceeds 1024 bytes");
  });

  it("follows relative redirects and extracts readable HTML", async () => {
    http.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/article" } }));
    http.fetch.mockResolvedValueOnce(new Response(`<html><head><title>Example</title></head><body><article><p>${"Article content. ".repeat(20)}</p></article></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    const page = await fetchPage("https://example.test", options);
    expect(page.finalUrl).toBe("https://example.test/article");
    expect(page.title).toBe("Example");
    expect(page.text).toContain("Article content.");
    expect(page.text).not.toContain("<article>");
  });

  it("stops at the redirect limit", async () => {
    http.fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
    await expect(fetchPage("https://example.test", { ...options, maxRedirects: 1 })).rejects.toThrow("Too many redirects");
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });
});
