# Repository Guidelines

## Project Structure & Docs
- `src/`: Node/Express/WS server — `adapters/` (providers), `jobs/` (batch runner), `scoring/` (metrics), `storage/` (JSONL/SQLite drivers, CSV export), `replay/` (preview/replay stores), `voice/` (voice agent), `ws/` (stream/replay/voice handlers), `utils/` (FFmpeg/manifest helpers), entrypoint `server.ts`.
- `client/`: React + Vite UI (`src/App.tsx`, `styles/theme.ts`, `main.tsx`); `vite.config.ts` proxies `/api` and `/ws`（サーバ既定ポート 4100 は `.env` の `VITE_API_BASE_URL` と同期）。Results タブはプロバイダフィルタ/ファイル名検索と p50/p95 簡易チャート、Realtime はレイテンシ p50/p95 を即時計測表示し履歴テーブルで過去セッションを確認、Voice タブは音声会話（STT/LLM/TTS）を提供する。
- `public/`: static assets; after build, `client/dist` is served. Samples: `sample-data/`.
- Full仕様: `docs/stt-compare-local-v1.0.md` を参照（要件・型・API）。

## 利用前提（ローカル限定）
- 本ミニアプリはローカル環境専用。高可用性・冗長化・RBAC/監査ログなど本番運用向け強化は対象外。
- ただし公平性と最低限の安全性は維持: 16k mono PCM統一、.env管理、許可ドメインのみ送信、パス/入力サニタイズ。

## Environment & Config
- Node 20+, pnpm 10+, FFmpeg in PATH (or `@ffmpeg-installer/ffmpeg`). Chrome/Edge を主対象（Safari は v1.0 未対応）。
- Copy `.env.example` → `.env`; set provider keys, `SERVER_PORT`/`PORT` (default 4100).
- `config.json`: audio 16k/mono/250ms、normalizationプリセット、storage driver/path、providers。現行バンドルは `deepgram`, `elevenlabs`, `openai`, `local_whisper`, `whisper_streaming`（`mock` は必要に応じて追加）。追加実装は拡張時に `src/adapters/index.ts` へ登録。storage.driver は `jsonl` または `sqlite`（better-sqlite3実装済）。

## Build, Test, and Development
- Install: `pnpm install` (root) + `pnpm --filter stt-comparator-client install`.
- Dev: `pnpm run dev` (stack) | `dev:server` | `dev:client` (http://localhost:5173).
- Build/serve: `pnpm run build` → `pnpm start`.
- Quality: `pnpm lint`, `pnpm test` (server Vitest), `pnpm --filter stt-comparator-client test`, `pnpm test:all` (both).
- CI: `.github/workflows/ci.yml` が lint → test → build を実行（Node 20, pnpm 10.12.1 を Corepack で準備, `COREPACK_HOME` はローカルキャッシュ）。
- API補足: `GET /api/providers` が現在利用可能なプロバイダと理由（例: Deepgram鍵未設定）を返却。UI は unavailable 時にバナーと再接続/再試行ボタンを表示し、選択肢を disable する。`GET /api/realtime/latency?limit=20` で直近の Realtime レイテンシ集計を取得。
- Deepgram を有効化するには `.env` に `DEEPGRAM_API_KEY` を設定しサーバを再起動するだけでよい（config.json の変更は不要）。

## Coding Style & Conventions
- TypeScript + ESM, 2-space indent, single quotes, semicolons. Prefer `import type { ... }`.
- ESLint rules: `no-floating-promises`, `no-misused-promises`, `consistent-type-imports`; Prettier-compatible.
- Names: PascalCase (components/types), camelCase (functions/vars), tests `*.test.ts(x)` colocated.

## Testing Guidelines
- Server tests under `src/**/*.test.ts` (e.g., `src/scoring/metrics.test.ts`); Vitest node env with text/html coverage.
- Client tests under `client/src/**/*.test.tsx` (e.g., `App.test.tsx`) using Vitest + RTL。
- Use `sample-data/` manifests; file名はマニフェスト `items[].audio` と一致させる。記録するCER/WER/RTF/latencyは仕様値準拠。バッチ結果の集計は `/api/jobs/:jobId/summary` で平均/p50/p95 を返す。

## Workflow: Commits & PRs
- Commit: short imperative subject (≤72 chars, optional scope); reference issues in body if relevant.
- PRs: what/why, test commands run, screenshots/API samples for UI/WS changes。仕様変更時は `docs/`・`README.md`・サンプルを更新し、受入基準(0.3/22章)への影響を記載。

## Fairness & Performance Baselines (v1.0)
- Audioは常に PCM linear16 16k mono; WebSocket chunk 250ms。VADは公平比較ではOFF。
- Streaming目標: 平均レイテンシ < 800ms, p95 < 1.5s（サーバ計測の `latencyMs`）。Batch目標: 100×30s で平均 RTF ≤ 1.0。
- 出力: JSON camelCase / CSV snake_case。CSV/JSON エクスポート必須。

## Adapters & Runtime Notes
- 実装済: Mock, Deepgram, ElevenLabs, OpenAI, local_whisper（Batchのみ）, whisper_streaming（Streaming/Batch）。`.env` に各 API キーが無い場合は `/api/providers` で unavailable と返し、UI からは選択不可&警告表示。AWS/GCP/Azure など他クラウドはローカル用途のため未実装・任意拡張。
- Streaming: `src/ws/streamHandler.ts` で最初のPCM送信時刻を基準に `latencyMs` を付与し UI に表示。
- Batch: `src/jobs/batchRunner.ts` で `options.parallel` による並列処理、正規化は manifest が無い場合 config の既定を使用。
- Storage: JSONL (`results.jsonl`) か SQLite (`results.sqlite`, better-sqlite3)。両方 `storage.path` 配下に生成。

## Security & Data Hygiene
- `.env` や実音声をコミットしない。ストレージ出力は `runs/<date>/`（driver: jsonl/sqlite。`storage.path` の `{date}` を `YYYY-MM-DD` に展開）。大容量ログは適宜削除。
- 送信先は許可されたプロバイダエンドポイントのみ。入力は zod/manifest パーサで検証し、CORS/helmet のデフォルトを維持。ローカル利用でも鍵漏えいとパストラバーサルは防ぐ。
