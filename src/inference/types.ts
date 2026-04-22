export type KvBlock = {
  id: string;
  tokens: number[];
  kCache: Float32Array;
  vCache: Float32Array;
  refCount: number;
  hash: string;
};

export type PrefixCacheStats = {
  totalBlocks: number;
  cachedBlocks: number;
  hitRate: number;
  memoryBytes: number;
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
};

export type StableContext = {
  systemPrompt: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  outputSchema: Record<string, unknown>;
  constraints: {
    maxTokens?: number;
    temperature?: number;
    stop?: string[];
  };
};
