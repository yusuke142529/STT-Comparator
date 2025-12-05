# STT-Compare Local 仕様 v1.0
作成日: 2025-11-19

## 0. 概要
### 0.1 背景と目的
複数の音声認識（ASR）プロバイダ／エンジンを同一条件で比較し、リアルタイム（マイク入力）とバッチ（録音ファイル）の双方で精度・レイテンシ・実用性を評価するローカル起動のミニアプリを提供する。本仕様では要件（機能・非機能）とアーキテクチャ（構成・データフロー・インタフェース）を統合定義する。

### 0.2 成果物（Deliverables）
- ローカル実行可能なアプリ（Web UI + ローカルサーバ）
- プロバイダ差し替え可能な Adapter 群（現行バンドルは Mock + Deepgram + ElevenLabs。その他は拡張用雛形）
- 評価モジュール（WER/CER/レイテンシ/RTFなど）
- 設定ファイル・環境変数テンプレート・README
- サンプルデータと評価マニフェスト（JSON）雛形
- 自動テスト（ユニット／統合）一式

### 0.3 成功基準（Acceptance Goals）
- UI上からプロバイダ切替が可能で、マイク入力のリアルタイム転写が動作する
- 録音ファイルの一括転写と**自動採点（CER/WER）**が可能
- 同一PCM条件での公平比較（16kHz/16bit/mono など）を担保
- レポート（JSON/CSV）のエクスポートが可能

## 1. スコープ
### 1.1 対象
- リアルタイムASR（マイク入力 → UI へ部分／確定結果表示）
- バッチASR（WAV等のファイル → テキスト）
- 評価（CER/WER/RTF/各種遅延・安定性）
- 結果の保存・可視化・エクスポート
- 複数ASRプロバイダのプラガブル化

### 1.2 非対象（当面）
- 高度な会話理解・要約・翻訳
- 自動話者分離・音源分離（将来拡張）
- クラウド側のジョブ管理／コスト最適化
- 商用配布用インストーラ（必要なら Tauri/Electron 包材は拡張）

### 1.3 前提（ローカル限定・非本番）
- 本アプリはローカル利用を前提とし、高可用性・冗長化・RBAC/監査ログなど本番運用向けの高度化は対象外。
- 最低限維持する安全・公平性: 16k/mono/PCM統一、.env による鍵管理とコミット禁止、許可済みASRエンドポイントのみ送信、パス/入力サニタイズ、CORS/helmet既定を緩めない。

## 2. 利用シナリオ／ユースケース
- U1: 評価者がアプリを起動 → マイクで各プロバイダのリアルタイム転写を比較。
- U2: 研究者が録音データセット（GT付き）を読み込み、一括転写 → 自動採点 → 結果をCSV化。
- U3: 実務担当が辞書（コンテキスト）や句読点ポリシーの有無で条件分岐評価を実施。

## 3. 用語集（抜粋）
- CER: Character Error Rate（文字誤り率）
- WER: Word Error Rate（単語誤り率）
- RTF: Real-time Factor（処理時間／音声長）
- Interim / Final: 部分結果／確定結果
- Adapter: プロバイダ差異を吸収する実装

## 4. 前提・制約
- ローカル起動: Web UI とローカルサーバ（Node.js）は利用者マシン上で動作。外部通信は各ASRプロバイダのAPIエンドポイントまたはローカルASRサーバ（local_whisper, nvidia_riva等）のみ。
- 同一PCM条件での比較（16kHz, 16-bit, mono 推奨）。
- ブラウザ音声取得は MediaRecorder（audio/webm; codecs=opus）→ ローカルサーバで PCM 変換。
- サポートブラウザ: Chrome / Edge 最新版。Safari 等は v1.0 では対象外。
- OS: Windows / macOS / Linux（Node.js v20+ / FFmpeg が必要）。
- 日本語評価は CER、英語系は WER を主指標（切替可能）。

## 5. 非機能要件
### 5.1 性能
- マイク → 部分結果: 平均 < 800ms、p95 < 1.5s（サーバ計測レイテンシ）。
- ファイル一括: 100件×30秒で平均 RTF ≤ 1.0 を目標。処理完了し再現可能。
- UI操作の応答: 主要操作 <100ms 体感。

### 5.2 信頼性・可用性
- 回線断時は明示エラー＋再接続ボタン。
- バッチ処理は jobId 単位で再実行可能（途中再開は対象外、同条件で再評価）。

### 5.3 セキュリティ・プライバシ
- API鍵は .env 等で管理し平文コミット禁止。
- 収集ログは匿名化（デフォルトで音声は保存しない／オプトインで保存）。
- 送信先ドメイン制限（許可リスト）。
- ローカルユースのため本番級の多層防御は省略するが、鍵漏えい防止とパストラバーサル防止は必須。

### 5.4 運用性
- ログレベル切替（ERROR/INFO/DEBUG）。
- 設定ホットリロード（可能な範囲）。
- 評価結果の保存はローカルだが肥大化防止のため保持期間/件数を設定可能（デフォルト: 30日または10万件）。

## 6. 全体アーキテクチャ
```
Web UI (React/TS) -> WS(JSON config + binary webm/opus) -> Local Node Server
Node Server: Transmux (FFmpeg), Router, Scoring, Storage (JSONL/SQLite), CSV/JSON export
Adapters: deepgram（実装済） / ElevenLabs（Realtime+Batch） / local_whisper（Batchのみ） / whisper_streaming（Realtime/Batch） / mock（ローカル確認/テスト用のスタブ。デフォルト設定には含めていない）。他クラウドは任意拡張（デフォルト無効）
```

## 7. モジュール構成と責務
- Web UI: マイク制御、WS接続、部分／確定表示、条件選択、バッチ評価UI、結果可視化。
  - 句読点ポリシー（none/basic/full）をUIで切替可能。
- Transmux: webm/opus → FFmpeg → PCM(16k mono, linear16) 変換し Adapter に送る。preview/replay/batch のアップロードファイルも受信直後に FFmpeg の strict フラグ（`-v error -xerror -err_detect explode` など）で 16k mono PCM WAV に正規化し、デコードエラーや 100ms 未満の出力しか得られない壊れた音源は 400 で拒否する。正規化パラメータは `config.json.ingressNormalize`（サンプルレート/チャンネル/ピークヘッドルーム）で統一管理し、`AUDIO_UNSUPPORTED_FORMAT` を UI へ返して再試行を促す。
- Router: ProviderId 解決、セッションライフサイクル管理、コンテキスト管理。
- Provider Adapter: API/SDK/WS/gRPC への接続、PCM送信、結果正規化、supportsStreaming/batch を表現。
- Scoring: 正規化、CER/WER/RTF 算出、レイテンシ算出、p50/p95 集計。
- Storage: JSONL/SQLite 永続化、CSV/JSON エクスポート。

## 8. データフロー（シーケンス）
### 8.1 リアルタイム（マイク）
1. Start → MediaRecorder開始 → WS `/ws/stream?provider=<id>&lang=<bcp47>` 接続。
2. 接続直後に StreamingConfigMessage を送信。
3. 約250msごとに webm/opus チャンクをバイナリ送信。
4. サーバで FFmpeg 変換 → Adapter.startStreaming → PCM を逐次送信。
5. Adapter が Interim/Final を PartialTranscript に正規化。
6. Server → UI: StreamTranscriptMessage(JSON) に timestamp を付与。
7. UI 表示、エラーはトースト。
8. Stop で MediaRecorder 停止 → FFmpeg stdin close → Adapter end → WS close。

### 8.2 バッチ
1. UI で files[] と ref_json（任意）を指定し Run。並列度 options.parallel は「同時に処理するファイル数」を意味し、複数プロバイダー指定時はサーバ側で provider 数までは自動で引き上げ（config.jobs.maxParallel を上限）て同一ファイルを並列に転写し、公平な比較を担保する。
2. POST `/api/jobs/transcribe` (multipart/form-data): files[], provider, lang, ref_json, options。
3. サーバ: jobId 発行 → 各ファイルを FFmpeg で PCM 化 → Adapter.transcribeFileFromPCM → Scoring → Storage に保存。
4. UI: GET `/api/jobs/:jobId/status` で進捗ポーリング。
5. 完了後 GET `/api/jobs/:jobId/results?format=csv|json` で取得し表示・DL。

## 9. インタフェース仕様（厳密）
### 9.1 WebSocket
- パス: `/ws/stream?provider=<id>&lang=<bcp47>`
- 接続直後: UI → config JSON → 音声バイナリ送信 → Server → StreamServerMessage。
- StreamingConfigMessage 例:
```
{
  "type": "config",
  "enableInterim": true,
  "contextPhrases": ["サンプル"],
  "normalizePreset": "ja_cer",
  "options": { "enableVad": false, "punctuationPolicy": "full", "parallel": 1 }
}
```
- 音声: MediaRecorder の webm/opus チャンク（~250ms）。
- Server → UI transcript 例:
```
{
  "type": "transcript",
  "provider": "deepgram",
  "isFinal": false,
  "text": "こんにちは",
  "words": [{ "startSec": 0.10, "endSec": 0.35, "text": "こんにち", "confidence": 0.86 }],
  "timestamp": 1732000000000,
  "channel": "mic"
}
```
- エラー: `{ "type": "error", "message": "..." }`

### 9.2 HTTP（バッチ）
- POST `/api/jobs/transcribe` (multipart/form-data): files[], provider, lang, ref_json (任意), options (任意)。
- Response: `{ "jobId": "uuid", "queued": 10 }`
- GET `/api/jobs/:jobId/status` → `{ jobId, total, done, failed }`
- GET `/api/jobs/:jobId/results?format=csv|json`
  - CSV カラム例: path,provider,lang,cer,wer,rtf,latency_ms,text,ref_text
  - JSON 例: `{ path, provider, lang, durationSec, processingTimeMs, rtf, cer, wer, latencyMs, text, refText, opts }`
  - CSVはsnake_case、JSONはcamelCase。
  - GET `/api/jobs/:jobId/summary` → `{ count, cer:{avg,p50,p95}, wer:{...}, rtf:{...}, latencyMs:{...} }`

### 9.5 リアルタイム: 内部再生
- `POST /api/realtime/replay` (multipart/form-data: `file`, `provider`, `lang`) でファイルをアップロードし `sessionId` を返却。プロバイダは `streaming` 判定済みである必要があり、サーバは `ReplaySessionStore` に一時保存（TTL 5 分）し、録音なしでも同じ FFmpeg → Adapter の経路を再現する。
- UI は返却された `sessionId` を使って `WS /ws/replay?provider=<id>&lang=<bcp47>&sessionId=<id>` に接続し、通常の `StreamingConfigMessage` を送信。WS はファイルから PCM を `controller.sendAudio` で送出し、`StreamTranscriptMessage` には `channel:'file'` を付与する。接続終了後、セッションファイルは削除される。
- CLI の `scripts/realtime-replay.ts` も同様の `StreamingConfigMessage`/WS を使うため、UI の内部再生をベースにスクリプトを組み合わせることでマイクが不要な検証も行える。

### 9.6 リアルタイム: ログ
- `GET /api/realtime/logs/:sessionId` — 指定セッションの `session`, `transcript`, `error`, `session_end` を時系列で返す。生成AIなどへ渡すため、1セッション分の `StreamTranscriptMessage`（partial/final）、`latencyMs`、`channel`、`provider`、`timestamp` を含むタイムラインをサーバ側で蓄積しておける。
- ログ行は `storage.driver` に応じて `runs/<date>/realtime-logs.jsonl`（JSONL）または SQLite 内の `realtime_logs` テーブルへ書きこまれ、`storage.retentionDays`/`storage.maxRows` の範囲で pruning される。`storage.path` を共有するバッチ/latency ログと同じストレージなので、生成AIレビューのために `runs` の任意の日付フォルダを丸ごとコピーしてもよい。
- エントリ構造: `{ sessionId, provider, lang, recordedAt, payload }`。`payload` は `StreamSessionMessage` (`startedAt`)、`StreamTranscriptMessage`（`text`/`latencyMs`/`isFinal`）、`StreamErrorMessage`（`message`）、`StreamSessionEndMessage`（`endedAt`）のいずれか。
### 9.3 評価マニフェスト
```
{
  "version": 1,
  "language": "ja-JP",
  "items": [ { "audio": "dataset/a.wav", "ref": "これはテストです。" } ],
  "normalization": { "nfkc": true, "stripPunct": true, "stripSpace": true }
}
```

### 9.4 Realtime Replay Helper
- `scripts/realtime-replay.ts` は UI の `MediaRecorder` → `/ws/stream` → FFmpeg → Adapter の本番経路を TypeScript で模倣し、`ffmpeg -re` で `sample-data` などのファイルを WebM/Opus に変換して直接ストリーミングします。このスクリプトを使えば、外部マイクを使えない静音環境でもプロバイダ・言語・マニフェストごとのレイテンシを再現性高く収集できます。
- 起動: `pnpm replay:realtime --provider mock --language ja-JP --file sample-data/your.wav`（`--manifest sample-data/manifest.example.json` も可）。`--enable-interim`/`--normalize-preset`/`--punctuation`/`--context`/`--dictionary` や `--dry-run` により、StreamingConfigMessage のパラメタを UI と同じ感覚で調整できます。
- 出力: `StreamTranscriptMessage` を受信するたびに `latencyMs` を含むログ行（`interim` と `final`）、最後に平均/p95/最大の latency 要約、transcript count、final count を表示します。`GET /api/realtime/latency?limit=20` と併せて session-level の集計と突合させれば、実験比較の信頼性が高まります。
- プロバイダごと: Deepgram では `.env` に `DEEPGRAM_API_KEY`、ElevenLabs では `ELEVENLABS_API_KEY`、`whisper_streaming` では faster-whisper-server が起動済みで `WHISPER_STREAMING_READY_URL` が通る状態であることを確認してからスクリプトを叩いてください。`mock` でまず挙動を確認し、必要なら manifest の `items[]` にノイズ・会話・朗読などのサンプルを追加して比較軸を整えてください。
- items[].audio はアップロード files[] のファイル名と一致させる。マッピング不可は警告/エラー。

## 10. 型仕様（TypeScript）
  - v1.0 デフォルト: `deepgram`, `elevenlabs`, `local_whisper`, `whisper_streaming`（ローカル常駐 WS/HTTP サーバ, Streaming/Batch 両対応）。`mock` はローカル検証やテスト用途で必要に応じて追加してください。その他は拡張用。
  - `whisper_streaming`: faster-whisper-server 等のローカル常駐エンドポイントを前提。WS 初期メッセージで language/task/model を送信し、partial/final を受信する。
- StreamingOptions: language, sampleRateHz(16000), encoding 'linear16', enableInterim?, contextPhrases?
- TranscriptWord, PartialTranscript (timestamp, channel 'mic'|'file')
- PunctuationPolicy: 'none' | 'basic' | 'full'; TranscriptionOptions: enableVad?, punctuationPolicy?, dictionaryPhrases?, parallel?
- StreamingConfigMessage { type:'config', enableInterim?, contextPhrases?, normalizePreset?, options? }
- StreamingController/StreamingSession インタフェース
- BatchResult { provider, text, words?, durationSec?, processingTimeMs? }
- ProviderAdapter { id, supportsStreaming/batch, startStreaming(opts), transcribeFileFromPCM(pcm, opts) }
- StreamServerMessage = StreamTranscriptMessage | StreamErrorMessage

補足: encoding は v1.0 で常に linear16。StreamingSession はサーバ ↔ Adapter 間内部IF。

## 11. 設定／構成管理
- 環境変数例:
```
PORT=5173
DEEPGRAM_API_KEY=dg_xxx        # 現行デフォルトで必要なのはこれのみ
ELEVENLABS_API_KEY=xi_xxx      # ElevenLabs を使うにはキーを設定
WHISPER_WS_URL=ws://localhost:8000/v1/audio/transcriptions
WHISPER_HTTP_URL=http://localhost:8000/v1/audio/transcriptions
WHISPER_MODEL=small            # faster-whisper-server へ渡すモデル名
# 電文が応答しない場合のバッチタイムアウト（ミリ秒）。省略時は 60000。
ELEVENLABS_BATCH_TIMEOUT_MS=60000
# 再試行を増やすには以下の値を設定。いずれも省略時は 3 回 / 拡張バックオフ（1000ms → 5000ms）です。
ELEVENLABS_BATCH_MAX_ATTEMPTS=3
ELEVENLABS_BATCH_BASE_DELAY_MS=1000
ELEVENLABS_BATCH_MAX_DELAY_MS=5000
# 以下は拡張時に使用（デフォルトでは未使用）
# AZURE_SPEECH_KEY=...
# AZURE_SPEECH_REGION=...
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
```
- .env はコミット禁止。
- config.json 例:
```
{
  "audio": { "targetSampleRate": 16000, "targetChannels": 1, "chunkMs": 250 },
  "normalization": { "nfkc": true, "stripPunct": true, "stripSpace": true },
  "storage": { "driver": "jsonl", "path": "./runs/2025-11-19" }, // driver は jsonl または sqlite
  "providers": ["deepgram", "elevenlabs", "local_whisper", "whisper_streaming"], // ローカル用途の現行デフォルト（`mock` は任意追加）
  "ws": {
    "maxPcmQueueBytes": 5242880,
    "compare": { "backlogSoft": 8, "backlogHard": 32, "maxDropMs": 1000 } // Realtime比較用バックログ制御
  }
}
```
- `providerHealth.refreshMs` を指定すると `/api/providers` のヘルスチェック結果を再計算する間隔（ミリ秒）を調整できます。デフォルト 5000 によりローカルの `whisper_streaming` 等を起動した直後でも数秒で「利用可能」へ切り替わるようになり、同エンドポイントは TTL 内でキャッシュを再利用して過剰なヘルスチェックを防ぎます。即時再評価が必要なときは `/api/admin/reload-config` を叩いてください。
- `/api/providers` のレスポンスには `supportsDictionaryPhrases` / `supportsPunctuationPolicy` / `supportsContextPhrases` のようなフラグも含まれるため、クライアントはプロバイダごとの機能差を UI 表示や辞書・句読点コントロールの有効/無効に反映できます。

## 12. 音声処理ポリシー
- Realtime: webm/opus、Batch: wav/mp3/mp4。サーバで PCM S16LE 16k mono に統一。
- チャンク: 250ms（config.audio.chunkMs）。
- VAD: オプション、公平比較では OFF をデフォルト。

## 13. 評価設計
- 正規化: 日本語 NFKC→句読点除去→空白除去→CER、英語 NFKC→punct正規化→lower→WER。
- 指標: CER, WER, RTF=(processingTimeMs/1000)/durationSec, レイテンシ latencyMs=サーバ送信→最初のInterim/Final受信差分。
- 出力: 平均/p50/p95 を集計し UI と CSV/JSON で可視化。再現性確保。

## 14. UI仕様（要点）
- Realtime: プロバイダ選択（現行は Deepgram、ElevenLabs、Whisper Streaming。local_whisper は Batch のみ対応）、言語、VAD・句読点ポリシー・辞書トグル、Start/Stop、部分/確定表示、レイテンシ表示、Chrome/Edge 推奨文言。入力ソースはマイクと「内部ファイル再生」のトグルになっており、ファイル選択時は `/api/realtime/replay` で音声をサーバに送り、返却された `sessionId` を使って `/ws/replay` を開くことで mic-less の比較が可能です。
- Batch Evaluate: ファイルドロップ、参照マニフェスト、並列度（options.parallel）、VAD/句読点/辞書入力、Run、進捗バー、結果テーブル、CSV/JSON DL。
- Results: 最新ジョブの p50/p95 要約と per-file テーブル（provider/cer/wer/rtf/latency）。将来的な比較グラフは拡張範囲。
- 操作: マイク許可必須、ストリーミング中は Stop 常設、プロバイダ切替時はセッションを安全終了。

## 15. エラーハンドリング・ロギング
- UI: トースト、type:'error' を検出し表示。
- Server: 構造化ログ（time, level, event, provider, jobId, file, latencyMs, rtf, error）。

## 16. セキュリティ
- API鍵の平文コミット禁止、環境変数で管理。
- 送信先ドメイン制限（許可リストのみ）。
- ローカル保存はプロジェクト配下。アップロードパスはサニタイズ（.. 禁止）。

## 17. テスト計画
- ユニット: 正規化関数、CER/WER/RTF、小規模期待値、Adapterモック、TranscriptionOptionsパース。
- 統合: Realtime往復（MediaRecorder→WS→FFmpeg→Adapter(Mock)→UI）、StreamServerMessage transcript/error 双方処理、バッチ10件程度、マニフェストと files[] マッピング検証。
- 性能: 250ms チャンクドロップ無し、100×30s で RTF ≤1.0。
- 受け入れ: 成功基準(0.3)を手順書で検証、プロバイダ切替/辞書/正規化差分が UI で比較可能。

## 18. ディレクトリ構成（推奨）
```
stt-compare-local/
  public/
  src/
    server.ts
    types.ts
    adapters/
    scoring/
    jobs/
    storage/
  config.json
  .env.example
  README.md
```

## 19. 実装要点（抜粋）
- FFmpeg ブリッジ: `ffmpeg -f webm -i pipe:0 -ac 1 -ar 16000 -f s16le pipe:1` を用い、WSバイナリ→stdin、stdout→StreamingController.sendAudio。
- ストリーミングLC: Start→WS→config→MediaRecorder、サーバで Adapter.startStreaming、Stop でFFmpeg close→controller.end、エラー時は StreamErrorMessage を送信。
- スコア計算: CER/ WER（編集距離）、RTF=(processingTimeMs/1000)/durationSec、集計は平均/p50/p95。

## 20. 拡張計画（例）
- 辞書／ブースト語UI強化、話者分離、ノイズ処理、可視化強化、1ジョブで複数プロバイダ同時評価。

## 21. リスクと軽減策
- API変更→Adapterレイヤでバージョン分離/設定化。
- FFmpeg非導入→初回起動チェック/導入ガイド。
- マシン性能不足→チャンク/並列度制御、ローカルASR選択。
- 鍵漏えい→.env除外、保護、使用後破棄。
- ブラウザ非対応→対象明記、非対応は Batch 案内。

## 22. 受入基準（詳細）
- リアルタイム: 部分→確定が表示、平均レイテンシ<800ms(p95<1.5s) を UI で確認。
- バッチ: 10件以上で CER/WER/RTF 算出、CSV/JSON が仕様通り、同条件で再評価可能。
- 公平性: 16k/mono/PCM投入（ログ記録）、公平比較では VAD OFF。
- 安定性: 連続30分ストリーミングでハングなし。

## 23. 開発・ビルド・実行（標準）
- 要件: Node v20+, FFmpeg。
- セットアップ:
```
pnpm i
cp .env.example .env
pnpm tsx src/server.ts
open http://localhost:5173
```
- スクリプト: `pnpm start`, `pnpm test`, `pnpm build`。デスクトップラッパーは Tauri/Electron で同梱可。

## 24. 付録A：UIワイヤー（簡易）
```
[Realtime]
Provider: [deepgram] Language: [ja-JP] [Dict…] [Start] [Stop]
... こんに | ... こんにちは | ■ こんにちは世界
latency: 350ms (interim), 900ms (final) | session: 00:02:31

[Batch Evaluate]
[ Drop files here ] [Ref Manifest JSON] [Parallel: 4] [Run]
# file prov dur cer wer rtf p50lat p95lat
1 a.wav deepgram 12.3 .078 .132 .34 580ms 980ms
[Export CSV] [Export JSON]
```

## 25. 付録B：評価マニフェスト仕様（JSON Schema イメージ）
```
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["version", "language", "items"],
  "properties": {
    "version": { "type": "integer", "minimum": 1 },
    "language": { "type": "string" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["audio", "ref"],
        "properties": {
          "audio": { "type": "string" },
          "ref": { "type": "string" },
          "meta": { "type": "object" }
        }
      }
    },
    "normalization": {
      "type": "object",
      "properties": {
        "nfkc": { "type": "boolean" },
        "stripPunct": { "type": "boolean" },
        "stripSpace": { "type": "boolean" }
      }
    }
  }
}
```

## 26. 付録C：Adapter 実装ガイド（概要）
- startStreaming(opts): encoding は 'linear16' 固定。ベンダ仕様で接続し PartialTranscript に正規化。sendAudio の引数は PCM 生バイト。
- transcribeFileFromPCM(pcm, opts): 必要なら一時ファイル/アップロード。processingTimeMs を計測して返却。
- local_whisper: Python版 Whisper へのローカル接続。v1 では Batch のみ対応（Streaming 非対応）。モデル/デバイス要件は README に明記。
- nvidia_riva: ローカル常駐サーバへの接続。GPU要件は README に明記。

## 27. 付録D：サンプル正規化ロジック
- 日本語: NFKC → 句読点除去 → 空白除去 → CER
- 英語: NFKC → punctuation 正規化 → lowercase → WER
