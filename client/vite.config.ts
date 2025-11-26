import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server as HttpServer } from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 4100);
const BACKEND_MANAGED_EXTERNALLY = process.env.STT_COMPARATOR_BACKEND_MANAGED === '1';
const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const POLL_INTERVAL = 250;
const EXISTING_CHECK_TIMEOUT = 2000;
const STARTUP_TIMEOUT = 15_000;

let backendProcess: ChildProcessWithoutNullStreams | null = null;
let backendSpawnedByPlugin = false;
let backendEnsurePromise: Promise<void> | null = null;
let exitHandlerRegistered = false;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) {
      return true;
    }
    await delay(POLL_INTERVAL);
  }
  return false;
}

function cleanupBackend(): void {
  if (backendProcess && backendSpawnedByPlugin) {
    backendProcess.kill('SIGINT');
    backendProcess = null;
    backendSpawnedByPlugin = false;
  }
}

function registerExitHandlers(): void {
  if (exitHandlerRegistered) return;
  const handler = () => {
    cleanupBackend();
  };
  process.once('exit', handler);
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  process.once('uncaughtException', handler);
  exitHandlerRegistered = true;
}

function spawnBackend(): void {
  backendProcess = spawn(PNPM_COMMAND, ['run', 'dev:server'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  backendProcess.once('exit', () => {
    backendProcess = null;
    backendSpawnedByPlugin = false;
  });
  backendProcess.once('error', (error) => {
    console.error('failed to spawn dev:server', error);
    backendProcess = null;
    backendSpawnedByPlugin = false;
  });
  backendSpawnedByPlugin = true;
}

async function ensureBackendRunning(): Promise<void> {
  if (BACKEND_MANAGED_EXTERNALLY) {
    return;
  }
  if (await isPortOpen(SERVER_PORT)) {
    return;
  }
  if (await waitForPort(SERVER_PORT, EXISTING_CHECK_TIMEOUT)) {
    return;
  }
  console.log('starting backend server (pnpm run dev:server)');
  spawnBackend();
  await waitForPort(SERVER_PORT, STARTUP_TIMEOUT);
}

async function ensureBackendStarted(): Promise<void> {
  if (!backendEnsurePromise) {
    backendEnsurePromise = ensureBackendRunning();
  }
  await backendEnsurePromise;
}

const backendStarterPlugin = {
  name: 'stt-comparator-backend-starter',
  apply: 'serve' as const,
  async configureServer(server: { httpServer: HttpServer | null }) {
    await ensureBackendStarted();
    registerExitHandlers();
    server.httpServer?.once('close', cleanupBackend);
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBase = env.VITE_API_BASE_URL ?? 'http://localhost:4100';
  const wsTarget = apiBase.replace(/^http/, 'ws');
  return {
    plugins: [react(), backendStarterPlugin],
    server: {
      port: 5173,
      proxy: {
        '/api': apiBase,
        '/ws': {
          target: wsTarget,
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
