const searchWebDefinition = {
    name: "search_web",
    kind: "tool",
    description: "Search the web for relevant documents using DuckDuckGo API",
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
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`search_web failed: ${response.status}`);
    }
    const data = await response.json();
    const results = (data?.Results || []).slice(0, topK).map((result) => ({
        title: result?.Title || "Untitled",
        snippet: result?.Text || "",
        url: result?.FirstURL || "",
    }));
    return results;
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
        try {
            const results = await searchWeb(query, topK);
            return { results };
        }
        catch (error) {
            console.error("search_web error:", error);
            return { results: [{ title: "Search unavailable", snippet: "Unable to fetch search results at this time", url: "" }] };
        }
    });
    registry.register(getWeatherDefinition, async (args) => {
        const location = String(args.location ?? "");
        if (!location.trim()) {
            throw new Error("location is required");
        }
        try {
            return await getWeather(location);
        }
        catch (error) {
            console.error("get_weather error:", error);
            throw error;
        }
    });
}
