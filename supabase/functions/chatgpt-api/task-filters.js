const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = new Set(['assignee', 'status', 'from', 'to', 'query', 'limit', 'offset']);

/** Strict, bounded filters, shared by REST and MCP callers. */
export function parseTaskFilters(params) {
  for (const key of params.keys()) {
    if (!KEYS.has(key) || params.getAll(key).length !== 1) throw new Error('INVALID_TASK_FILTER');
  }
  const assignee = params.get('assignee');
  if (assignee && !UUID.test(assignee)) throw new Error('INVALID_ASSIGNEE');
  const status = params.get('status');
  if (status !== null && !['pending', 'completed', 'cancelled', 'rejected'].includes(status)) throw new Error('INVALID_TASK_FILTER');
  const query = params.get('query');
  if (query !== null && (!query.trim() || query.length > 180)) throw new Error('INVALID_TASK_FILTER');
  const instant = key => {
    const value = params.get(key);
    if (value === null) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error('INVALID_TASK_FILTER');
    }
    const [year, month, day] = value.slice(0,10).split('-').map(Number);
    const date = new Date(`${value.slice(0,10)}T00:00:00Z`);
    if (date.getUTCFullYear() !== year || date.getUTCMonth()+1 !== month || date.getUTCDate() !== day
      || Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59 || Number(value.slice(17,19)) > 59) {
      throw new Error('INVALID_TASK_FILTER');
    }
    return new Date(value).toISOString();
  };
  const from = instant('from'), to = instant('to');
  if (from && to && from > to) throw new Error('INVALID_TASK_FILTER');
  const number = (key, fallback, min, max) => {
    const value = params.get(key);
    if (value === null) return fallback;
    if (!/^\d{1,5}$/.test(value) || Number(value) < min || Number(value) > max) throw new Error('INVALID_TASK_FILTER');
    return Number(value);
  };
  return { p_assignee: assignee || null, p_status: status, p_from: from, p_to: to,
    p_query: query, p_limit: number('limit', 50, 1, 100), p_offset: number('offset', 0, 0, 10000) };
}
