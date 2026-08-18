import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { assertPublicHttpUrl } from "./security.js";

export interface FetchPageOptions {
  timeoutSeconds: number;
  maxResponseBytes: number;
  maxTextChars: number;
  maxRedirects: number;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title?: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function extractText(contentType: string, body: string, url: string): { title?: string; text: string } {
  if (contentType.includes("text/html")) {
    const { document } = parseHTML(body);
    const article = new Readability(document as unknown as Document, { charThreshold: 100 }).parse();
    const text = article?.textContent?.replace(/\n{3,}/g, "\n\n").trim() ?? document.body?.textContent?.trim() ?? "";
    return { title: article?.title || document.title || url, text };
  }
  if (contentType.includes("application/json")) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2) };
    } catch {
      return { text: body };
    }
  }
  return { text: body };
}

export async function fetchPage(
  input: string,
  options: FetchPageOptions,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  const initialUrl = await assertPublicHttpUrl(input);
  let currentUrl = initialUrl;
  const timeout = AbortSignal.timeout(options.timeoutSeconds * 1000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: requestSignal,
      headers: {
        accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1",
        "user-agent": "Prax/0.1 (+https://github.com/)",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect response ${response.status} has no Location header`);
      if (redirectCount >= options.maxRedirects) throw new Error("Too many redirects");
      currentUrl = await assertPublicHttpUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) throw new Error(`Web fetch failed (${response.status} ${response.statusText})`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("text/") && contentType !== "application/json") {
      throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
    }

    const bytes = await readLimitedBody(response, options.maxResponseBytes);
    const body = new TextDecoder().decode(bytes);
    const extracted = extractText(contentType, body, currentUrl.toString());
    const truncated = extracted.text.length > options.maxTextChars;
    const result: FetchedPage = {
      url: initialUrl.toString(),
      finalUrl: currentUrl.toString(),
      contentType,
      text: extracted.text.slice(0, options.maxTextChars),
      truncated,
    };
    if (extracted.title) result.title = extracted.title;
    return result;
  }

  throw new Error("Unable to fetch URL");
}
