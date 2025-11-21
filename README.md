# STT Comparator
[![CI](https://github.com/yusuke142529/STT-Comparator/actions/workflows/ci.yml/badge.svg)](https://github.com/yusuke142529/STT-Comparator/actions/workflows/ci.yml)

ローカル環境で複数の音声認識（ASR）プロバイダを同一条件で比較・計測するミニアプリです。リアルタイム（マイク入力）とファイル一括バッチを共通UIから操作し、CER/WER/RTF やレイテンシを収集・可視化する v1.0 スペックに基づいて設計しています。

## 技術スタック

- **Server**: Node.js 20 + Express + WebSocket（`src/` 直下, 既定ポート 4100）
- **UI**: Vite + React + TypeScript（`client/`、Results タブにプロバイダフィルタと p50/p95 の簡易チャート、Realtime にレイテンシ p50/p95 と履歴テーブル）
- **Audio**: FFmpeg（`@ffmpeg-installer/ffmpeg`）で webm/opus → PCM (16k mono linear16)
- **Scoring**: 独自 CER/WER/RTF 実装、正規化プリセット
- **Storage**: JSONL 永続化（SQLite ドライバも実装済み; storage.driver で切替）

## 主要ディレクトリ

```
├── src/                  # ローカルサーバ（Express/WS）
│   ├── adapters/         # Provider Adapter 実装（mock + deepgram）
│   ├── jobs/             # バッチ実行・スコアリング
│   ├── scoring/          # CER/WER/RTF と正規化
│   ├── storage/          # JSONL/SQLite ドライバ, CSVエクスポータ
│   ├── utils/            # FFmpeg ブリッジ, マニフェストパーサ
│   ├── ws/               # Realtime WebSocket handler
│   └── server.ts         # Express + WS エントリポイント
├── client/               # Web UI (React)
│   ├── src/App.tsx       # Realtime + Batch UI ワイヤー
│   └── vite.config.ts    # 開発/ビルド設定（API Proxy）
├── public/               # ビルド済み UI の配置先（Express が配信）
├── sample-data/          # manifest 雛形
├── config.json           # v1.0 仕様のアプリ設定
└── .env.example          # API鍵やポートのテンプレート
```

## セットアップ

1. FFmpeg がローカルにインストールされていることを確認してください。
2. 依存関係をインストール:
   ```bash
   pnpm install
   pnpm --filter stt-comparator-client install
   ```
3. 環境変数テンプレートを複製して API キー等を設定（`DEEPGRAM_API_KEY` が未設定の場合、UI で Deepgram は「unavailable」と表示され選択不可）:
 ```bash
  cp .env.example .env
  ```
  - Deepgram を有効化するには `.env` に `DEEPGRAM_API_KEY` を入れてサーバを再起動するだけでOK。既定ポートは 4100（`SERVER_PORT` で変更可能、フロントは `VITE_API_BASE_URL` と Vite proxy がそれに追従します）。
4. `config.json` の `storage.path` や `providers` を利用状況に合わせて調整（デフォルトは `mock` と `deepgram`）。必要に応じて `ALLOWED_ORIGINS` をカンマ区切りで設定し、CORS/CSP/WS の許可先を絞り込めます。保存データの肥大化を防ぐため `storage.retentionDays` と `storage.maxRows` で保持期間と件数上限を設定できます（デフォルト: 30日 / 100,000件）。

## 実行

- サーバ単体（API + WS + static 配信）: `pnpm run dev:server`
- UI 単体（Vite Dev Server, http://localhost:5173）: `pnpm run dev:client`
- フルスタック（サーバ + UI 同時）: `pnpm run dev`
- ビルド: `pnpm run build`（サーバをコンパイルし、UI を `client/dist` → `public/` へ出力、デフォルトで `COREPACK_HOME=.corepack-cache` を使用）
- 本番起動: `pnpm start`

UI ビルド後は `public/` に生成されたファイルを Express が配信します。開発中は Vite が `/api`・`/ws` へのプロキシを介してサーバと通信します。

## API・WS 概要

- `POST /api/jobs/transcribe` — multipart/form-data で `files[]`, `provider`, `lang`, `ref_json`, `options` を受け取り、UUID ベースの `jobId` を返却。
- `GET /api/jobs/:jobId/status` — 進捗（done/failed/total）を返却。
- `GET /api/jobs/:jobId/results?format=csv|json` — CER/WER/RTF を含むレコードを JSON/CSV で返却。
- `WS /ws/stream?provider=<id>&lang=<bcp47>` — 接続直後に `StreamingConfigMessage` を送信 → 以降は webm/opus バイナリ（MediaRecorder）を送る。
- UI では punctuation policy（none/basic/full）を選択して送信でき、プロバイダ側の句読点挿入挙動を条件として比較可能。
- `GET /api/providers` — 現在のプロバイダ有効/無効状態を返却（Deepgram キー未設定などを UI で案内）。
- `GET /api/realtime/latency?limit=20` — 直近の realtime セッションのレイテンシ集計（avg/p50/p95/min/max, count, provider/lang）を返却。

詳細なスキーマは仕様書（`src/types.ts`）と README のリンク箇所を参照してください。

## スコアリング / ストレージ

- 正規化: `config.json` や manifest の `normalization` フィールドで NFKC/句読点/空白/小文字化を制御（デフォルトは stripSpace=true で CER/WER 比較の基準を揃えています）。
- CER/WER/RTF: `src/scoring/metrics.ts`。ユニットテスト（`pnpm test`）で動作確認。
- ストレージ: 既定は JSONL（`runs/<date>/results.jsonl`）。`storage.driver` を `sqlite` にすればスタブが落ちるため、実装追加時に入れ替え。

## Adapter 雛形

- `src/adapters/mock.ts` — ローカルで UI/ストレージの疎通確認用。
- `src/adapters/deepgram.ts` — Deepgram 公式 API 連携を実装済み。`.env` に `DEEPGRAM_API_KEY` を設定して有効化。
- Adapter を増やす際は `src/adapters/index.ts` に登録し、`config.json` の `providers` に ID を追加します。

## サンプル manifest

`sample-data/manifest.example.json` は v1.0 仕様の参照 JSON。UI のバッチエリアや `POST /api/jobs/transcribe` の `ref_json` に流用できます。

## テスト

- サーバ: `pnpm test`（Vitest, Node env）
- クライアント: `pnpm --filter stt-comparator-client test`

## CI

- GitHub Actions (`.github/workflows/ci.yml`) で lint → test → build を実行。Node 20 + pnpm 10.12.1 を Corepack で準備し、`COREPACK_HOME` をローカルキャッシュに向けています。

### Corepack キャッシュ権限エラーが出る場合
共有環境で `pnpm build` が `~/.cache/node/corepack` への書き込み権限不足で失敗することがあります。`pnpm run build` は自動で `COREPACK_HOME=.corepack-cache` をセットしますが、明示的に変えたい場合は以下のように上書きできます。
```bash
export COREPACK_HOME="$(pwd)/.corepack-cache"
pnpm run build
```

## 未実装 / TODO

- （必要なら）AWS/GCP/Azure などクラウド実プロバイダ Adapter 実装
- Results ダッシュボードのグラフ可視化
- ジョブの永続キューイング（途中再開, 並列制御）

## ライセンス

MIT
