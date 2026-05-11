const searchWebDefinition = {
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
const getWeatherDefinition = {
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
async function searchWeb(query, topK) {
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
async function getWeather(location) {
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
        temp_f: Math.round((data?.main?.temp || 0) * 9 / 5 + 32),
        humidity: data?.main?.humidity || 0,
        wind_speed: data?.wind?.speed || 0,
        description: data?.weather?.[0]?.description || "",
    };
}
export function registerBuiltinTools(registry) {
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
function parseDuckDuckGoJson(body, topK) {
    const data = JSON.parse(body);
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
async function readCandidatesAsMarkdown(candidates) {
    const results = [];
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
async function readMarkdownWithJina(targetUrl) {
    const readerUrl = `${jinaReaderBaseUrl().replace(/\/+$/, "")}/${targetUrl}`;
    const headers = {
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
        const json = JSON.parse(body);
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
function jinaReaderBaseUrl() {
    return process.env.JINA_READER_BASE_URL ?? "https://r.jina.ai";
}
function deriveTitle(text) {
    const trimmed = cleanText(text);
    const separator = trimmed.indexOf(" - ");
    return separator > 0 ? trimmed.slice(0, separator) : trimmed.slice(0, 80);
}
function normalizeDuckDuckGoUrl(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    try {
        const url = new URL(trimmed, "https://duckduckgo.com");
        const uddg = url.searchParams.get("uddg");
        return uddg ? decodeURIComponent(uddg) : url.href;
    }
    catch {
        return trimmed;
    }
}
function cleanText(value) {
    return value.replace(/\s+/g, " ").trim();
}
function looksLikeMarkdown(value) {
    const trimmed = value.trim();
    return Boolean(trimmed) && !trimmed.startsWith("<!DOCTYPE") && !trimmed.startsWith("<html");
}
