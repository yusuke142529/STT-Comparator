export interface RetryController {
  reset: () => void;
  schedule: (fn: () => void) => void;
}
