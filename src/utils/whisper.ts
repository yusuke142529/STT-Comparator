import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

interface WhisperRuntime {
  pythonPath: string | null;
  reason?: string;
}

let cachedRuntime: WhisperRuntime | null = null;

function resolvePythonCandidate(): string | null {
  if (process.env.WHISPER_PYTHON) return process.env.WHISPER_PYTHON;

  const venvPython = path.resolve('.venv/bin/python3');
  if (existsSync(venvPython)) return venvPython;

  return 'python3';
}

export function getWhisperRuntime(): WhisperRuntime {
  if (cachedRuntime) return cachedRuntime;

  const candidate = resolvePythonCandidate();
  if (!candidate) {
    cachedRuntime = { pythonPath: null, reason: 'python executable not found' };
    return cachedRuntime;
  }

  try {
    const probe = spawnSync(candidate, ['-c', 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("whisper") else 1)'], {
      stdio: 'ignore',
    });
    if (probe.error) {
      cachedRuntime = { pythonPath: null, reason: probe.error.message };
      return cachedRuntime;
    }
    if (probe.status && probe.status !== 0) {
      cachedRuntime = { pythonPath: null, reason: 'python available but whisper module missing' };
      return cachedRuntime;
    }
    cachedRuntime = { pythonPath: candidate };
    return cachedRuntime;
  } catch (error) {
    cachedRuntime = { pythonPath: null, reason: (error as Error).message };
    return cachedRuntime;
  }
}

export function resetWhisperRuntimeCache(): void {
  cachedRuntime = null;
}
