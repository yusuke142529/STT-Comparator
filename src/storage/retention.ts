export interface RetentionPolicy {
  retentionMs?: number;
  maxRows?: number;
  pruneIntervalMs?: number;
}
