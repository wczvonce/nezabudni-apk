import { withAbortTimeout } from './async.js';

export async function readBackendSchema(client, timeoutMs = 5_000) {
  const { data, error } = await withAbortTimeout(
    signal => client.rpc('get_backend_capabilities').abortSignal(signal),
    { timeoutMs, message: 'Kontrola verzie databázy trvá príliš dlho.' },
  );
  if (error) throw error;
  const version = Number(data?.schema_version);
  if (!Number.isInteger(version) || version < 1) throw new Error('Databáza nevrátila platnú verziu.');
  return version;
}
