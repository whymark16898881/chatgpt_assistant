export class ProbeError extends Error {
  constructor(code, message, { retryable = false, retryAction = 'none', internalRetry = false, retryAfterMs = 250 } = {}) {
    super(message); this.name = 'ProbeError'; this.code = code;
    this.retryable = retryable; this.retryAction = retryAction;
    this.internalRetry = internalRetry; this.retryAfterMs = retryAfterMs;
  }
}
export const policyError = () => new ProbeError('POLICY_REJECTED', 'URL or upstream transport rejected by download policy.');
export const timeoutError = () => new ProbeError('TIMEOUT', 'Download time budget exceeded.', { retryable: true, retryAction: 'retry_tool' });
export function failure(error) {
  const e = error instanceof ProbeError ? error : new ProbeError('STORAGE_FAILED', 'Archive could not be committed.', { retryable: true, retryAction: 'retry_tool' });
  return { code: e.code, retryable: e.retryable, retry_action: e.retryAction, message: e.message };
}
