import { z } from 'zod';

const envSchema = z.object({
  // Basic
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('58691'),
  
  // LLM Configuration
  KGM_LLM_BASE_URL: z.string().url().optional(),
  KGM_LLM_API_KEY: z.string().optional(),
  KGM_LLM_MODEL: z.string().optional(),
  KGM_LLM_MODE: z.enum(['chat', 'completions']).optional(),
  KGM_LLM_PATH: z.string().optional(),
  
  // Authentication
  KGM_HTTP_API_KEY: z.string().optional(),
  KGM_HTTP_AUTH_EXEMPT: z.string().default('/health,/metrics,/openapi.json'),
  
  // Rate Limiting
  KGM_HTTP_RATE_LIMIT_MAX: z.string().transform(Number).default('0'),
  KGM_HTTP_RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('60000'),
  
  // Database
  KGM_DB_PROVIDER: z.enum(['sqlite', 'postgresql']).default('sqlite'),
  KGM_DB_PATH: z.string().default('data/kgm.db'),
  KGM_DB_HOST: z.string().optional(),
  KGM_DB_PORT: z.string().transform(Number).optional(),
  KGM_DB_NAME: z.string().optional(),
  KGM_DB_USER: z.string().optional(),
  KGM_DB_PASSWORD: z.string().optional(),
  KGM_DB_SSL: z.string().transform(v => v === '1' || v === 'true').default('false'),
  KGM_DB_MAX_CONNECTIONS: z.string().transform(Number).default('20'),
  KGM_DB_IDLE_TIMEOUT: z.string().transform(Number).default('30000'),
  KGM_DB_CONNECTION_TIMEOUT: z.string().transform(Number).default('10000'),
  
  // Model Management
  KGM_MODEL_STATE_PATH: z.string().default('data/models/store'),
  KGM_MODEL_HEALTHCHECK_INTERVAL_MS: z.string().transform(Number).default('15000'),
  
  // Multimodal
  KGM_MULTIMODAL_BASE_URL: z.string().url().optional(),
  KGM_MULTIMODAL_PATH: z.string().default('/v1/embeddings'),
  KGM_MULTIMODAL_MODEL: z.string().default('clip'),
  KGM_MULTIMODAL_KEY: z.string().optional(),
  KGM_MULTIMODAL_TIMEOUT_MS: z.string().transform(Number).default('120000'),
  KGM_MULTIMODAL_JSON_TEMPLATE: z.string().transform(v => v === '1').default('0'),

  // Sandbox adapters
  KGM_SANDBOX_ADAPTERS_PATH: z.string().optional(),
  KGM_SANDBOX_ADAPTERS_JSON: z.string().optional(),

  // File/API/executor tools
  KGM_FILE_TOOL_ROOTS: z.string().optional(),
  KGM_HTTP_TOOL_ALLOWED_ORIGINS: z.string().optional(),
  KGM_EXECUTOR_URL: z.string().url().optional(),
  KGM_EXECUTOR_PATH: z.string().default('/execute'),
  KGM_EXECUTOR_API_KEY: z.string().optional(),
  
  // Telemetry
  KGM_TELEMETRY_SAMPLING_RATE: z.string().transform(v => parseFloat(v)).default('0.1'),
  
  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  
  // Timeout
  YUELIAI_HOST: z.string().optional(),
  YUELIAI_API_KEY: z.string().optional(),
  YUELIAI_UPSTREAM_PREFIX: z.string().optional(),
  YUELIAI_TIMEOUT_MS: z.string().transform(Number).optional(),

  KGM_REQUEST_TIMEOUT_MS: z.string().transform(Number).default('30000'),
  KGM_CIRCUIT_BREAKER_TIMEOUT_MS: z.string().transform(Number).default('10000'),
  KGM_CIRCUIT_BREAKER_ERROR_THRESHOLD: z.string().transform(Number).default('5'),
  KGM_CIRCUIT_BREAKER_RESET_TIMEOUT_MS: z.string().transform(Number).default('60000'),
});

export type Env = z.infer<typeof envSchema>;

let validatedEnv: Env | null = null;

export function validateEnv(): Env {
  if (validatedEnv) {
    return validatedEnv;
  }

  try {
    validatedEnv = envSchema.parse(process.env);
    return validatedEnv;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missing = error.errors
        .filter(e => e.code === 'invalid_type')
        .map(e => e.path.join('.'));
      
      const invalid = error.errors
        .filter(e => e.code !== 'invalid_type')
        .map(e => `${e.path.join('.')}: ${e.message}`);
      
      throw new Error(
        `Environment validation failed:\n` +
        (missing.length > 0 ? `Missing: ${missing.join(', ')}\n` : '') +
        (invalid.length > 0 ? `Invalid: ${invalid.join(', ')}` : '')
      );
    }
    throw error;
  }
}

export function getEnv(): Env {
  return validatedEnv || validateEnv();
}
