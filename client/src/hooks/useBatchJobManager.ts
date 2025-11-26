import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileResult, JobHistoryEntry, JobStatus, JobSummary, SubmitBatchInput } from '../types/app';
import type { RetryController } from './retryController';

interface InternalConfig {
  apiBase: string;
  retry: RetryController;
  onJobLoaded?: (jobId: string) => void;
}

export const useBatchJobManager = ({ apiBase, retry, onJobLoaded }: InternalConfig) => {
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [jobResults, setJobResults] = useState<FileResult[]>([]);
  const [jobSummary, setJobSummary] = useState<JobSummary | null>(null);
  const [jobHistory, setJobHistory] = useState<JobHistoryEntry[]>([]);
  const [jobHistoryError, setJobHistoryError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const pollIntervalRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (pollIntervalRef.current) {
      window.clearInterval(pollIntervalRef.current);
    }
  }, []);

  const loadJobData = useCallback(
    async (jobId: string) => {
      if (!jobId) return;
      try {
        const resultRes = await fetch(`${apiBase}/api/jobs/${jobId}/results`);
        if (!resultRes.ok) throw new Error('ジョブ結果の取得に失敗しました');
        const resultJson = (await resultRes.json()) as FileResult[];
        setJobResults(resultJson);
        const summaryRes = await fetch(`${apiBase}/api/jobs/${jobId}/summary`);
        if (summaryRes.ok) {
          setJobSummary((await summaryRes.json()) as JobSummary);
        } else {
          setJobSummary(null);
        }
        setJobHistoryError(null);
        onJobLoaded?.(jobId);
      } catch (err) {
        console.error('failed to load job results', err);
        setJobSummary(null);
        setJobHistoryError((err as Error).message);
      }
    },
    [apiBase, onJobLoaded]
  );

  const refreshJobHistory = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/jobs`);
      if (!res.ok) throw new Error('ジョブ履歴の取得に失敗しました');
      const data = (await res.json()) as JobHistoryEntry[];
      setJobHistory(data);
      setJobHistoryError(null);
    } catch (err) {
      console.warn('job history refresh failed', err);
      setJobHistoryError((err as Error).message);
    }
  }, [apiBase]);

  const pollStatus = useCallback(
    (jobId: string) => {
      if (pollIntervalRef.current) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setJobError(null);
      setJobStatus({ jobId, total: 0, done: 0, failed: 0 });

      pollIntervalRef.current = window.setInterval(async () => {
        try {
          const statusRes = await fetch(`${apiBase}/api/jobs/${jobId}/status`);
          if (!statusRes.ok) throw new Error('ステータス取得失敗');
          const status = (await statusRes.json()) as JobStatus;
          setJobStatus(status);

          if (status.done + status.failed >= status.total) {
            if (pollIntervalRef.current) {
              window.clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            await loadJobData(jobId);
            await refreshJobHistory();
            setIsBatchRunning(false);
          }
        } catch (err) {
          if (pollIntervalRef.current) {
            window.clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setJobError('ステータス取得に失敗しました');
          setIsBatchRunning(false);
        }
      }, 1500);
    },
    [apiBase, loadJobData, refreshJobHistory]
  );

  const submitBatch = useCallback(
    async (payload: SubmitBatchInput) => {
      if (!payload.files || payload.files.length === 0) {
        alert('ファイルを選択してください');
        return;
      }

      retry.reset();
      setIsBatchRunning(true);
      setJobResults([]);
      setJobSummary(null);
      setJobError(null);

      let manifestPayload: string | null = null;
      if (payload.manifestJson.trim()) {
        try {
          const parsed = JSON.parse(payload.manifestJson);
          if (typeof parsed.version !== 'number' || parsed.version < 1) {
            throw new Error('version is required (number >= 1)');
          }
          if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
            throw new Error('items array is required');
          }
          parsed.items.forEach((item: any, idx: number) => {
            if (!item?.audio || !item?.ref) {
              throw new Error(`items[${idx}] must include audio and ref`);
            }
          });
          manifestPayload = JSON.stringify(parsed);
        } catch (err) {
          setJobError(`Manifestが不正です: ${(err as Error).message}`);
          setIsBatchRunning(false);
          return;
        }
      }

      try {
        const form = new FormData();
        for (const file of Array.from(payload.files)) {
          const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
          const uploadName = relativePath && relativePath.length > 0 ? relativePath : file.name;
          form.append('files', file, uploadName);
        }
        form.append('provider', payload.provider);
        form.append('lang', payload.lang);
        if (manifestPayload) form.append('ref_json', manifestPayload);

        form.append(
          'options',
          JSON.stringify({
            enableVad: payload.enableVad,
            punctuationPolicy: payload.punctuationPolicy,
            dictionaryPhrases: payload.dictionaryPhrases,
            parallel: payload.parallel,
          })
        );

        const res = await fetch(`${apiBase}/api/jobs/transcribe`, { method: 'POST', body: form });
        if (!res.ok) {
          const errText = await res.text();
          try {
            const parsed = JSON.parse(errText);
            throw new Error(parsed.message ?? 'ジョブ投入に失敗しました');
          } catch {
            throw new Error('ジョブ投入に失敗しました');
          }
        }
        const data = await res.json();
        setJobError(null);
        pollStatus(data.jobId);
      } catch (err) {
        const message = (err as Error).message;
        setJobError(message);
        setIsBatchRunning(false);
        if (err instanceof TypeError || message.toLowerCase().includes('network')) {
          retry.schedule(() => submitBatch(payload));
        } else {
          retry.reset();
        }
      }
    },
    [apiBase, pollStatus, retry]
  );

  return {
    jobStatus,
    jobResults,
    jobSummary,
    jobHistory,
    jobHistoryError,
    jobError,
    isBatchRunning,
    submitBatch,
    loadJobData,
    refreshJobHistory,
  };
};
