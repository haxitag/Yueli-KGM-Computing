import type { ConfigStore } from "../core/configStore.js";
import type { RoutingHints } from "../core/types.js";
import { OllamaLlmClient } from "./third-party.js";
import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";

export type CompletionOptions = {
  model?: string;
  requestId?: string;
  sessionId?: string;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  seed?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  taskInput?: string;
  taskType?: string;
  taskName?: string;
  routing?: RoutingHints;
};

export type CompletionResult = {
  text: string;
  raw: unknown;
};

export type CompletionStreamEvent =
  | {
      type: "started";
      model?: string;
    }
  | {
      type: "token";
      text: string;
      index: number;
      tokenId?: number;
    }
  | {
      type: "finished";
      result: CompletionResult;
    };

export type LlmClient = {
  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>;
  streamComplete?(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent>;
};

export async function* streamCompletion(
  client: LlmClient,
  prompt: string,
  options?: CompletionOptions,
): AsyncIterable<CompletionStreamEvent> {
  if (client.streamComplete) {
    yield* client.streamComplete(prompt, options);
    return;
  }

  yield {
    type: "started",
    model: options?.model,
  };
  const result = await client.complete(prompt, options);
  if (result.text) {
    yield {
      type: "token",
      text: result.text,
      index: 0,
    };
  }
  yield {
    type: "finished",
    result,
  };
}

export class HttpLlmClient implements LlmClient {
  private baseUrl: string;
  private model: string;
  private path: string;
  private apiKey?: string;
  private mode: "completions" | "chat";
  private timeoutMs?: number;

  constructor(params: {
    baseUrl: string;
    model: string;
    path?: string;
    apiKey?: string;
    mode?: "completions" | "chat";
    timeoutMs?: number;
  }) {
    this.baseUrl = params.baseUrl;
    this.model = params.model;
    this.path = params.path ?? "/completions";
    this.apiKey = params.apiKey;
    this.mode = params.mode ?? "completions";
    this.timeoutMs = params.timeoutMs;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const payload =
      this.mode === "chat"
        ? {
            model: options?.model ?? this.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.2,
            stop: options?.stop,
          }
        : {
            model: options?.model ?? this.model,
            prompt,
            max_tokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.2,
            stop: options?.stop,
          };

    const data = (await postJson(joinUrl(this.baseUrl, this.path), payload, {
      headers: buildAuthHeaders(this.apiKey),
      timeoutMs: this.timeoutMs,
    })) as {
      choices?: Array<{ text?: string; message?: { content?: string } }>;
      output_text?: string;
    };

    const choice = data.choices?.[0];
    const text = data.output_text ?? choice?.text ?? choice?.message?.content ?? "";
    return { text, raw: data };
  }
}

export class ConfigurableLlmClient implements LlmClient {
  private store: ConfigStore;

  constructor(store: ConfigStore) {
    this.store = store;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const config = this.store.get().llm;
    if (config.provider === "openai" && !config.apiKey) {
      throw new Error("llm apiKey is required for openai provider");
    }
    const client =
      config.provider === "ollama"
        ? new OllamaLlmClient({
            baseUrl: config.baseUrl,
            model: config.model,
            timeoutMs: config.timeoutMs,
          })
        : new HttpLlmClient({
            baseUrl: config.baseUrl,
            model: config.model,
            path: config.path,
            apiKey: config.apiKey,
            mode: config.mode,
            timeoutMs: config.timeoutMs,
          });
    return client.complete(prompt, {
      maxTokens: options?.maxTokens ?? config.maxTokens,
      temperature: options?.temperature ?? config.temperature,
      stop: options?.stop,
      model: options?.model ?? config.model,
    });
  }
}

export class MockLlmClient implements LlmClient {
  async complete(prompt: string): Promise<CompletionResult> {
    const input = extractUserInput(prompt).toLowerCase();
    let text = "";
    const hasToolResults = !prompt.includes("\"toolResults\": []");

    if (hasToolResults) {
      text = JSON.stringify({ type: "final", content: "ok_after_tool" });
    } else if (input.includes("weather") || input.includes("forecast") || input.includes("tianqi")) {
      text = JSON.stringify({ type: "call", target: "get_weather", arguments: { location: "auto" } });
    } else if (input.includes("search") || input.includes("lookup")) {
      text = JSON.stringify({ type: "call", target: "search_web", arguments: { query: input, top_k: 3 } });
    } else {
      text = JSON.stringify({ type: "final", content: "ok" });
    }

    return { text, raw: { mock: true } };
  }
}

function extractUserInput(prompt: string): string {
  const marker = "\n  \"input\":";
  const idx = prompt.indexOf(marker);
  if (idx === -1) {
    return "";
  }
  const slice = prompt.slice(idx + marker.length);
  const match = slice.match(/\s*\"([^\"]+)\"/);
  return match?.[1] ?? "";
}

function buildAuthHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) {
    return {};
  }
  return { authorization: `Bearer ${apiKey}` };
}
