import path from 'node:path';
import dotenv from 'dotenv';

const DEFAULT_ENV_PATH = path.resolve('.env');
let loadedEnvPath = DEFAULT_ENV_PATH;

function load(envPath: string) {
  const resolved = path.resolve(envPath);
  const result = dotenv.config({ path: resolved, override: true });
  loadedEnvPath = resolved;
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw result.error;
  }
}

export function loadEnvironment(envPath?: string) {
  load(envPath ?? DEFAULT_ENV_PATH);
}

export function reloadEnvironment() {
  load(loadedEnvPath);
}

export function getEnvironmentPath() {
  return loadedEnvPath;
}
