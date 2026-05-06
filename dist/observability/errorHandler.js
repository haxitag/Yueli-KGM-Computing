import { logger } from './logger.js';
export class AppError extends Error {
    statusCode;
    code;
    isOperational;
    details;
    constructor(statusCode, code, message, isOperational = true, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = isOperational;
        this.details = details;
        Object.setPrototypeOf(this, AppError.prototype);
        Error.captureStackTrace(this, this.constructor);
    }
}
export class ValidationError extends AppError {
    constructor(message, details) {
        super(400, 'VALIDATION_ERROR', message, true, details);
    }
}
export class AuthenticationError extends AppError {
    constructor(message = 'Authentication failed') {
        super(401, 'AUTHENTICATION_ERROR', message);
    }
}
export class AuthorizationError extends AppError {
    constructor(message = 'Insufficient permissions') {
        super(403, 'AUTHORIZATION_ERROR', message);
    }
}
export class NotFoundError extends AppError {
    constructor(resource) {
        super(404, 'NOT_FOUND', `${resource} not found`);
    }
}
export class RateLimitError extends AppError {
    constructor(retryAfter) {
        super(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests', true, { retryAfter });
    }
}
export class InternalError extends AppError {
    constructor(message = 'Internal server error', details) {
        super(500, 'INTERNAL_ERROR', message, false, details);
    }
}
export function errorHandler(err, req, res, next) {
    const isProduction = process.env.NODE_ENV === 'production';
    if (err instanceof AppError) {
        logger.error({
            error: {
                code: err.code,
                message: err.message,
                statusCode: err.statusCode,
                details: err.details,
                stack: isProduction ? undefined : err.stack,
            },
            request: {
                method: req.method,
                url: req.url,
                ip: req.ip,
                userAgent: req.get('user-agent'),
            },
        }, 'Application error');
        res.status(err.statusCode).json({
            error: {
                code: err.code,
                message: err.message,
                ...(err.details && { details: err.details }),
                ...(isProduction ? {} : { stack: err.stack }),
            },
        });
        return;
    }
    // Unknown errors
    logger.error({
        error: {
            message: err.message,
            stack: isProduction ? undefined : err.stack,
        },
        request: {
            method: req.method,
            url: req.url,
            ip: req.ip,
        },
    }, 'Unhandled error');
    res.status(500).json({
        error: {
            code: 'INTERNAL_ERROR',
            message: isProduction ? 'An unexpected error occurred' : err.message,
            ...(isProduction ? {} : { stack: err.stack }),
        },
    });
}
export function notFoundHandler(req, res) {
    res.status(404).json({
        error: {
            code: 'NOT_FOUND',
            message: `Cannot ${req.method} ${req.url}`,
        },
    });
}
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
