export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedAt?: string;
}

export interface SearchProvider {
  search(
    query: string,
    options: { maxResults: number; signal?: AbortSignal },
  ): Promise<SearchResult[]>;
}
