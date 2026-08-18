import type { SearchProvider, SearchResult } from "./types.js";

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
  published_date?: unknown;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

function timeoutSignal(seconds: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(seconds * 1000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class TavilySearchProvider implements SearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutSeconds: number,
  ) {}

  async search(
    query: string,
    options: { maxResults: number; signal?: AbortSignal },
  ): Promise<SearchResult[]> {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: options.maxResults,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: timeoutSignal(this.timeoutSeconds, options.signal),
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new Error(`Tavily search failed (${response.status}): ${body || response.statusText}`);
    }

    const data = (await response.json()) as TavilyResponse;
    return (data.results ?? []).flatMap((result): SearchResult[] => {
      if (typeof result.title !== "string" || typeof result.url !== "string") return [];
      const item: SearchResult = {
        title: result.title,
        url: result.url,
        snippet: typeof result.content === "string" ? result.content : "",
      };
      if (typeof result.score === "number") item.score = result.score;
      if (typeof result.published_date === "string") item.publishedAt = result.published_date;
      return [item];
    });
  }
}
