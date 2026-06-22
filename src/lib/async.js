export class TimeoutError extends Error {
  constructor(message, code = 'TIMEOUT') {
    super(message);
    this.name = 'TimeoutError';
    this.code = code;
  }
}

/**
 * Spustí operáciu s tvrdým časovým limitom a podporou zrušenia.
 *
 * Dôležité: časový limit aj externé zrušenie sa pretekajú s operáciou, takže
 * `await` sa VŽDY ukončí – aj keď operácia signál `AbortSignal` ignoruje
 * (napr. Supabase/IndexedDB volania, ktoré signál neprijímajú). Operáciám,
 * ktoré signál podporujú, sa navyše signál abortne, aby mohli zrušiť prácu.
 *
 * @param {(signal: AbortSignal) => Promise<any>} operation
 * @param {{ timeoutMs?: number, message?: string, externalSignal?: AbortSignal|null }} options
 */
export async function withAbortTimeout(operation, {
  timeoutMs = 15_000,
  message = 'Operácia trvá príliš dlho.',
  externalSignal = null,
} = {}) {
  const controller = new AbortController();

  // Keď sa controller abortne (timeoutom alebo externe), preteč abortom `await`,
  // aby sa ukončil aj pri operácii, ktorá signál nepoužíva.
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    const reason = controller.signal.reason;
    rejectAbort(reason instanceof Error ? reason : new TimeoutError(message));
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });

  const forwardAbort = () => controller.abort(externalSignal?.reason ?? new Error('Operation aborted'));
  if (externalSignal) {
    if (externalSignal.aborted) forwardAbort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  const timeoutId = setTimeout(() => controller.abort(new TimeoutError(message)), timeoutMs);

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      abortPromise,
    ]);
  } finally {
    clearTimeout(timeoutId);
    controller.signal.removeEventListener('abort', onAbort);
    externalSignal?.removeEventListener?.('abort', forwardAbort);
    // Voľná abortPromise bez catch handlera by inak vyhodila neodchytené odmietnutie.
    abortPromise.catch(() => {});
  }
}
