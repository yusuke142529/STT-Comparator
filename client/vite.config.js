var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var _a, _b;
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
var __dirname = path.dirname(fileURLToPath(import.meta.url));
var ROOT_DIR = path.resolve(__dirname, '..');
var SERVER_PORT = Number((_b = (_a = process.env.SERVER_PORT) !== null && _a !== void 0 ? _a : process.env.PORT) !== null && _b !== void 0 ? _b : 4100);
var BACKEND_MANAGED_EXTERNALLY = process.env.STT_COMPARATOR_BACKEND_MANAGED === '1';
var PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
var POLL_INTERVAL = 250;
var EXISTING_CHECK_TIMEOUT = 2000;
var STARTUP_TIMEOUT = 15000;
var backendProcess = null;
var backendSpawnedByPlugin = false;
var backendEnsurePromise = null;
var exitHandlerRegistered = false;
var delay = function (ms) { return new Promise(function (resolve) { return setTimeout(resolve, ms); }); };
function isPortOpen(port) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, new Promise(function (resolve) {
                    var socket = net.connect({ port: port, host: '127.0.0.1' }, function () {
                        socket.destroy();
                        resolve(true);
                    });
                    socket.once('error', function () { return resolve(false); });
                    socket.once('timeout', function () {
                        socket.destroy();
                        resolve(false);
                    });
                })];
        });
    });
}
function waitForPort(port, timeoutMs) {
    return __awaiter(this, void 0, void 0, function () {
        var deadline;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    deadline = Date.now() + timeoutMs;
                    _a.label = 1;
                case 1:
                    if (!(Date.now() < deadline)) return [3 /*break*/, 4];
                    return [4 /*yield*/, isPortOpen(port)];
                case 2:
                    if (_a.sent()) {
                        return [2 /*return*/, true];
                    }
                    return [4 /*yield*/, delay(POLL_INTERVAL)];
                case 3:
                    _a.sent();
                    return [3 /*break*/, 1];
                case 4: return [2 /*return*/, false];
            }
        });
    });
}
function cleanupBackend() {
    if (backendProcess && backendSpawnedByPlugin) {
        backendProcess.kill('SIGINT');
        backendProcess = null;
        backendSpawnedByPlugin = false;
    }
}
function registerExitHandlers() {
    if (exitHandlerRegistered)
        return;
    var handler = function () {
        cleanupBackend();
    };
    process.once('exit', handler);
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
    process.once('uncaughtException', handler);
    exitHandlerRegistered = true;
}
function spawnBackend() {
    backendProcess = spawn(PNPM_COMMAND, ['run', 'dev:server'], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
        env: process.env,
    });
    backendProcess.once('exit', function () {
        backendProcess = null;
        backendSpawnedByPlugin = false;
    });
    backendProcess.once('error', function (error) {
        console.error('failed to spawn dev:server', error);
        backendProcess = null;
        backendSpawnedByPlugin = false;
    });
    backendSpawnedByPlugin = true;
}
function ensureBackendRunning() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (BACKEND_MANAGED_EXTERNALLY) {
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, isPortOpen(SERVER_PORT)];
                case 1:
                    if (_a.sent()) {
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, waitForPort(SERVER_PORT, EXISTING_CHECK_TIMEOUT)];
                case 2:
                    if (_a.sent()) {
                        return [2 /*return*/];
                    }
                    console.log('starting backend server (pnpm run dev:server)');
                    spawnBackend();
                    return [4 /*yield*/, waitForPort(SERVER_PORT, STARTUP_TIMEOUT)];
                case 3:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function ensureBackendStarted() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!backendEnsurePromise) {
                        backendEnsurePromise = ensureBackendRunning();
                    }
                    return [4 /*yield*/, backendEnsurePromise];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
var backendStarterPlugin = {
    name: 'stt-comparator-backend-starter',
    apply: 'serve',
    configureServer: function (server) {
        return __awaiter(this, void 0, void 0, function () {
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, ensureBackendStarted()];
                    case 1:
                        _b.sent();
                        registerExitHandlers();
                        (_a = server.httpServer) === null || _a === void 0 ? void 0 : _a.once('close', cleanupBackend);
                        return [2 /*return*/];
                }
            });
        });
    },
};
export default defineConfig(function (_a) {
    var _b;
    var mode = _a.mode;
    var env = loadEnv(mode, process.cwd(), '');
    var apiBase = (_b = env.VITE_API_BASE_URL) !== null && _b !== void 0 ? _b : 'http://localhost:4100';
    var wsTarget = apiBase.replace(/^http/, 'ws');
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
