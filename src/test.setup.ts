// Ensure server bootstrap is skipped during Vitest runs and avoid port collisions.
process.env.NODE_ENV = 'test';
process.env.TEST_SERVER_PORT = process.env.TEST_SERVER_PORT ?? '0';
