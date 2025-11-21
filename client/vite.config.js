import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(function (_a) {
    var _b;
    var mode = _a.mode;
    var env = loadEnv(mode, process.cwd(), '');
    var apiBase = (_b = env.VITE_API_BASE_URL) !== null && _b !== void 0 ? _b : 'http://localhost:4100';
    var wsTarget = apiBase.replace(/^http/, 'ws');
    return {
        plugins: [react()],
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
