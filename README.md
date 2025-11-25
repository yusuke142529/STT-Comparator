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
│   ├── adapters/         # Provider Adapter 実装（deepgram / local_whisper / whisper_streaming。mock は任意のスタブ）
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
4. `config.json` の `storage.path` や `providers` を利用状況に合わせて調整（デフォルトは `deepgram`, `local_whisper`, `whisper_streaming`。手元検証用に `mock` を追加することもできます）。必要に応じて `ALLOWED_ORIGINS` をカンマ区切りで設定し、CORS/CSP/WS の許可先を絞り込めます。保存データの肥大化を防ぐため `storage.retentionDays` と `storage.maxRows` で保持期間と件数上限を設定できます（デフォルト: 30日 / 100,000件）。
  - `providerHealth.refreshMs` で `/api/providers` のヘルスチェック結果のキャッシュ期間（ミリ秒）を調整できます。デフォルト 5000ms により、`whisper_streaming` などのローカル ASR サービスを起動した直後でも UI が利用可能に切り替えられ、必要があれば `/api/admin/reload-config` を呼んで即座に再評価させられます。

### Whisper Streaming（faster-whisper-server, ローカル常駐）

- Docker 1コマンドで常駐サーバを起動できます（CPU 版の例、ポート 8000 固定）:
  ```bash
  docker run --rm -p 8000:8000 fedirz/faster-whisper-server:latest-cpu
  # GPU を使う場合は :latest-cuda イメージを選択
  ```
- .env に以下を追加（`cp .env.example .env` 済みの場合は値を書き換えるだけ）:
  ```bash
  WHISPER_WS_URL=ws://localhost:8000/v1/audio/transcriptions
  WHISPER_HTTP_URL=http://localhost:8000/v1/audio/transcriptions
  WHISPER_MODEL=small   # 任意モデル名
  ```
  - `whisper_streaming` Adapter は faster-whisper-server が WebSocket/HTTP をリッスン可能になるまでヘルスチェック（デフォルト: `http://localhost:8000/health`）をポーリングし、それが完了してからソケット接続または HTTP リクエストを開始します。必要に応じて以下の追加環境変数でポーリング先・タイムアウト・間隔を調整できます（全て省略または 0 にするとヘルスチェックを無効化します）。
    ```bash
    WHISPER_STREAMING_READY_URL=http://localhost:8000/health
    WHISPER_STREAMING_READY_TIMEOUT_MS=90000
    WHISPER_STREAMING_READY_INTERVAL_MS=1000
    ```
- `whisper_streaming` は **Realtime / Batch の両方に対応** します。UI/Batch API から選択すると PCM(16k mono) をローカルサーバへ送信し、partial/final の文字起こしを受信します。
- Deepgram など外部 API と同等にレイテンシ計測・公平性指標（p50/p95）が動作します。サーバ未起動時は `/api/providers` で unavailable 理由が返り、UI では選択不可・警告表示になります。

### ローカル Whisper (Python) を使う

- 依存: Python 3.10–3.13 推奨（本リポでは 3.11 を例示）、`ffmpeg` は既に必須。
- セットアップ例（リポジトリ直下で実行）
  ```bash
  python3.11 -m venv .venv
  source .venv/bin/activate
  pip install --upgrade pip setuptools wheel
  pip install git+https://github.com/openai/whisper.git
  ```
- サーバはデフォルトで `.venv/bin/python3` を優先し、`WHISPER_PYTHON` を指定すれば別 Python を使えます。モデル/デバイスは環境変数で調整できます（例: `WHISPER_MODEL=small`, `WHISPER_DEVICE=cpu`）。
- `local_whisper` は **Batch のみ対応** です（Realtime は非対応）。Realtime を試す場合は Deepgram 等のストリーミング対応プロバイダを選択してください。

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
- `GET /api/providers` — 現在のプロバイダ有効/無効状態を返却（Deepgram キー未設定などを UI で案内）。この API は現在のプロバイダヘルスを逐次再評価し `providerHealth.refreshMs` ミリ秒ごとにキャッシュを更新するため、ローカルの `whisper_streaming` サーバを起動した後でも数秒以内に UI に「利用可能」と反映されます。
- `GET /api/realtime/latency?limit=20` — 直近の realtime セッションのレイテンシ集計（avg/p50/p95/min/max, count, provider/lang）を返却。

詳細なスキーマは仕様書（`src/types.ts`）と README のリンク箇所を参照してください。

## スコアリング / ストレージ

- 正規化: `config.json` や manifest の `normalization` フィールドで NFKC/句読点/空白/小文字化を制御（デフォルトは stripSpace=true で CER/WER 比較の基準を揃えています）。
- CER/WER/RTF: `src/scoring/metrics.ts`。ユニットテスト（`pnpm test`）で動作確認。
- ストレージ: 既定は JSONL（`runs/<date>/results.jsonl`）。`storage.driver` を `sqlite` にすればスタブが落ちるため、実装追加時に入れ替え。

## Adapter 雛形

- `src/adapters/mock.ts` — ローカル確認/テスト用のスタブ。通常は `config.json` の providers に含まれませんが、必要なら手動追加できます。
- `src/adapters/deepgram.ts` — Deepgram 公式 API 連携を実装済み。`.env` に `DEEPGRAM_API_KEY` を設定して有効化。
- `src/adapters/whisperStreaming.ts` — ローカル常駐の faster-whisper-server (WS/HTTP) と連携する Streaming/Batch 両対応アダプタ。
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
