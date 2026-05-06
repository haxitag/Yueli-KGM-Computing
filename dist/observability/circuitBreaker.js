import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import { getEnv } from '../config/envValidation.js';
export function createCircuitBreaker(action, options, name) {
    const env = getEnv();
    const breakerOptions = {
        timeout: options?.timeout ?? env.KGM_CIRCUIT_BREAKER_TIMEOUT_MS,
        errorThreshold: options?.errorThreshold ?? env.KGM_CIRCUIT_BREAKER_ERROR_THRESHOLD,
        resetTimeout: options?.resetTimeout ?? env.KGM_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
        rollingCountTimeout: options?.rollingCountTimeout ?? 10000,
        rollingCountBuckets: options?.rollingCountBuckets ?? 10,
        rollingPercentiles: [50, 90, 95, 99],
        name: name || 'default',
    };
    const breaker = new CircuitBreaker(action, breakerOptions);
    breaker.on('open', () => {
        logger.warn({ circuit: breakerOptions.name }, 'Circuit breaker opened');
    });
    breaker.on('halfOpen', () => {
        logger.info({ circuit: breakerOptions.name }, 'Circuit breaker half-open');
    });
    breaker.on('close', () => {
        logger.info({ circuit: breakerOptions.name }, 'Circuit breaker closed');
    });
    breaker.on('fallback', (result) => {
        logger.warn({ circuit: breakerOptions.name, result }, 'Circuit breaker fallback triggered');
    });
    breaker.on('reject', (error) => {
        logger.warn({ circuit: breakerOptions.name, error: error.message }, 'Circuit breaker rejected request');
    });
    breaker.on('timeout', (error) => {
        logger.warn({ circuit: breakerOptions.name, error: error.message }, 'Circuit breaker timeout');
    });
    breaker.on('success', (result) => {
        logger.debug({ circuit: breakerOptions.name }, 'Circuit breaker success');
    });
    breaker.on('failure', (error) => {
        logger.error({ circuit: breakerOptions.name, error: error.message }, 'Circuit breaker failure');
    });
    return breaker;
}
export function createCircuitBreakerGroup() {
    const breakers = new Map();
    return {
        get(name) {
            return breakers.get(name);
        },
        set(name, breaker) {
            breakers.set(name, breaker);
        },
        getAll() {
            return breakers;
        },
        getAllStates() {
            const states = {};
            breakers.forEach((breaker, name) => {
                states[name] = breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed';
            });
            return states;
        },
    };
}
export const circuitBreakerGroup = createCircuitBreakerGroup();
