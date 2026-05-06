import { logger } from './logger.js';
class GracefulShutdown {
    shutdownHandlers = [];
    isShuttingDown = false;
    server;
    register(handler) {
        this.shutdownHandlers.push(handler);
    }
    setServer(server) {
        this.server = server;
    }
    async shutdown(signal) {
        if (this.isShuttingDown) {
            logger.warn({ signal }, 'Shutdown already in progress');
            return;
        }
        this.isShuttingDown = true;
        logger.info({ signal }, 'Starting graceful shutdown');
        try {
            // Stop accepting new connections
            if (this.server) {
                await new Promise((resolve) => {
                    this.server.close((err) => {
                        if (err) {
                            logger.error({ error: err.message }, 'Error closing server');
                        }
                        else {
                            logger.info('Server closed successfully');
                        }
                        resolve();
                    });
                });
            }
            // Run registered shutdown handlers
            const shutdownPromises = this.shutdownHandlers.map(async (handler, index) => {
                try {
                    logger.info({ handlerIndex: index }, 'Running shutdown handler');
                    await handler();
                    logger.info({ handlerIndex: index }, 'Shutdown handler completed');
                }
                catch (error) {
                    logger.error({ handlerIndex: index, error }, 'Shutdown handler failed');
                }
            });
            await Promise.all(shutdownPromises);
            logger.info('Graceful shutdown completed');
            process.exit(0);
        }
        catch (error) {
            logger.error({ error }, 'Error during graceful shutdown');
            process.exit(1);
        }
    }
    setup() {
        const signals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
        signals.forEach((signal) => {
            process.on(signal, () => {
                this.shutdown(signal);
            });
        });
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            logger.error({ error }, 'Uncaught exception');
            this.shutdown('uncaughtException');
        });
        // Handle unhandled promise rejections
        process.on('unhandledRejection', (reason, promise) => {
            logger.error({ reason, promise }, 'Unhandled promise rejection');
            this.shutdown('unhandledRejection');
        });
    }
}
export const gracefulShutdown = new GracefulShutdown();
export function setupGracefulShutdown(server) {
    gracefulShutdown.setServer(server);
    gracefulShutdown.setup();
}
export function registerShutdownHandler(handler) {
    gracefulShutdown.register(handler);
}
