export class TimeoutError extends Error {
  constructor(message, code = 'TIMEOUT') {
    super(message);
    this.name = 'TimeoutError';
    this.code = code;
  }
}

export async function withAbortTimeout(operation, {
  timeoutMs = 15_000,
  message = 'Operácia trvá príliš dlho.',
  externalSignal = null,
} = {}) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) forwardAbort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  const timeoutId = setTimeout(() => {
    controller.abort(new TimeoutError(message));
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof Error) throw reason;
      throw new TimeoutError(message);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener?.('abort', forwardAbort);
  }
}
