import pino from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const sensitiveKeys = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'bearer',
  'credential',
  'credit',
  'ssn',
  'social_security',
  'x-api-key',
  'x_api_key',
  'access_token',
  'refresh_token',
  'session_token',
  'private_key',
  'public_key',
  'secret_key',
  'connection_string',
  'db_password',
  'db_pass',
  'jdbc_url',
  'connection_url',
  'aws_access_key',
  'aws_secret_key',
  'gcp_key',
  'azure_key',
  'api_secret',
  'client_secret',
  'app_secret',
];

function redactSensitiveData(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveData);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSensitiveData(value);
      }
    }
    return result;
  }

  return obj;
}

export function createLogger(options?: {
  level?: LogLevel;
  serviceName?: string;
  environment?: string;
}) {
  const level = options?.level || (process.env.LOG_LEVEL as LogLevel) || 'info';
  const serviceName = options?.serviceName || 'yueli-kgm-computing';
  const environment = options?.environment || process.env.NODE_ENV || 'development';

  return pino({
    level,
    name: serviceName,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
      error: pino.stdSerializers.err,
    },
    redact: {
      paths: sensitiveKeys.map(k => `*.${k}`),
      remove: true,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      pid: process.pid,
      hostname: process.env.HOSTNAME || 'unknown',
      environment,
    },
    mixin: () => ({
      service: serviceName,
    }),
  });
}

export const logger = createLogger();

export function withLoggerContext<T extends Record<string, unknown>>(
  context: T
): T & { logger: pino.Logger } {
  return {
    ...context,
    logger: logger.child(redactSensitiveData(context) as Record<string, unknown>),
  };
}
