import type { ToolDefinition } from "../core/types.js";
import { ToolRegistry } from "./registry.js";

const searchWebDefinition: ToolDefinition = {
  name: "search_web",
  kind: "tool",
  description: "Search the web via a JSON search endpoint and convert result pages to Markdown with Jina Reader.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      top_k: { type: "number" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      results: { 
        type: "array", 
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            snippet: { type: "string" },
            url: { type: "string" },
            markdown: { type: "string" },
          },
        },
      },
    },
  },
  metadata: {
    latency: "medium",
    sideEffect: false,
    costLevel: "low",
    permission: "network",
    maxRetries: 2,
    tags: ["search", "retrieval"],
    integration: "builtin",
  },
};

const getWeatherDefinition: ToolDefinition = {
  name: "get_weather",
  kind: "tool",
  description: "Get current weather for a location using OpenWeatherMap API",
  inputSchema: {
    type: "object",
    required: ["location"],
    properties: {
      location: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      forecast: { type: "string" },
      temp_c: { type: "number" },
      temp_f: { type: "number" },
      humidity: { type: "number" },
      wind_speed: { type: "number" },
      description: { type: "string" },
    },
  },
  metadata: {
    latency: "fast",
    sideEffect: false,
    costLevel: "low",
    permission: "network",
    maxRetries: 1,
    tags: ["weather"],
    integration: "builtin",
  },
};

type SearchResult = {
  title: string;
  snippet: string;
  url: string;
  markdown: string;
};

type SearchCandidate = {
  title: string;
  snippet: string;
  url: string;
};

async function searchWeb(query: string, topK: number): Promise<SearchResult[]> {
  if (process.env.KGM_SMOKE_STUB_NETWORK_TOOLS === "1") {
    return [
      {
        title: "offline_stub",
        snippet: `stub results for: ${query}`,
        url: "https://example.invalid/offline-stub",
        markdown: `# Offline stub\n\nQuery: ${query}`,
      },
    ];
  }
  const encodedQuery = encodeURIComponent(query);
  const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;
  
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Yueli-KGM-Computing/0.2",
    },
  });
  if (!response.ok) {
    throw new Error(`search_web failed: ${response.status}`);
  }

  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || body.trim().startsWith("{")) {
    const candidates = parseDuckDuckGoJson(body, topK);
    return readCandidatesAsMarkdown(candidates);
  }
  throw new Error(`search_web expected json response, got ${contentType || "unknown"}`);
}

async function getWeather(location: string): Promise<{
  location: string;
  forecast: string;
  temp_c: number;
  temp_f: number;
  humidity: number;
  wind_speed: number;
  description: string;
}> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENWEATHER_API_KEY environment variable not set");
  }
  
  const encodedLocation = encodeURIComponent(location);
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodedLocation}&appid=${apiKey}&units=metric`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`get_weather failed: ${response.status}`);
  }
  
  const data = await response.json();
  return {
    location: location,
    forecast: data?.weather?.[0]?.main || "Unknown",
    temp_c: Math.round(data?.main?.temp || 0),
    temp_f: Math.round((data?.main?.temp || 0) * 9/5 + 32),
    humidity: data?.main?.humidity || 0,
    wind_speed: data?.wind?.speed || 0,
    description: data?.weather?.[0]?.description || "",
  };
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(searchWebDefinition, async (args) => {
    const query = String(args.query ?? "");
    const topK = Math.min(Number(args.top_k ?? 5), 10);
    
    if (!query.trim()) {
      return { results: [] };
    }
    
    const results = await searchWeb(query, topK);
    return { results };
  });

  registry.register(getWeatherDefinition, async (args) => {
    const location = String(args.location ?? "");
    
    if (!location.trim()) {
      throw new Error("location is required");
    }
    
    return getWeather(location);
  });
}

function parseDuckDuckGoJson(body: string, topK: number): SearchCandidate[] {
  const data = JSON.parse(body) as {
    Results?: Array<{ Title?: string; Text?: string; FirstURL?: string }>;
    RelatedTopics?: Array<{
      Title?: string;
      Text?: string;
      FirstURL?: string;
      Topics?: Array<{ Title?: string; Text?: string; FirstURL?: string }>;
    }>;
  };
  const direct = data.Results ?? [];
  const related = (data.RelatedTopics ?? []).flatMap((item) => item.Topics ?? [item]);
  return [...direct, ...related]
    .map((result) => ({
      title: cleanText(result.Title ?? deriveTitle(result.Text ?? "")),
      snippet: cleanText(result.Text ?? ""),
      url: normalizeDuckDuckGoUrl(result.FirstURL ?? ""),
    }))
    .filter((result) => result.url || result.snippet)
    .slice(0, topK);
}

async function readCandidatesAsMarkdown(candidates: SearchCandidate[]): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  for (const candidate of candidates) {
    if (!candidate.url) {
      continue;
    }
    results.push({
      ...candidate,
      markdown: await readMarkdownWithJina(candidate.url),
    });
  }
  return results;
}

async function readMarkdownWithJina(targetUrl: string): Promise<string> {
  const readerUrl = `${jinaReaderBaseUrl().replace(/\/+$/, "")}/${targetUrl}`;
  const headers: Record<string, string> = {
    accept: "text/markdown, application/json",
    "user-agent": "Yueli-KGM-Computing/0.2",
  };
  const apiKey = process.env.JINA_API_KEY ?? process.env.JINA_READER_API_KEY;
  if (apiKey?.trim()) {
    headers.authorization = `Bearer ${apiKey.trim()}`;
  }

  const response = await fetch(readerUrl, { headers });
  if (!response.ok) {
    throw new Error(`jina_reader failed: ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (contentType.includes("application/json") || body.trim().startsWith("{")) {
    const json = JSON.parse(body) as { data?: { content?: string }; content?: string };
    const markdown = json.data?.content ?? json.content;
    if (typeof markdown === "string") {
      return markdown;
    }
    throw new Error("jina_reader json missing markdown content");
  }
  if (contentType.includes("text/markdown") || contentType.includes("text/plain") || looksLikeMarkdown(body)) {
    return body;
  }
  throw new Error(`jina_reader expected markdown or json response, got ${contentType || "unknown"}`);
}

function jinaReaderBaseUrl(): string {
  return process.env.JINA_READER_BASE_URL ?? "https://r.jina.ai";
}

function deriveTitle(text: string): string {
  const trimmed = cleanText(text);
  const separator = trimmed.indexOf(" - ");
  return separator > 0 ? trimmed.slice(0, separator) : trimmed.slice(0, 80);
}

function normalizeDuckDuckGoUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return trimmed;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function looksLikeMarkdown(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed) && !trimmed.startsWith("<!DOCTYPE") && !trimmed.startsWith("<html");
}
