import { performance } from 'node:perf_hooks';
/** Opt-in in-memory instrumentation, never writes logs. */
export const editingTimings = new Map<string, number[]>();
export function timed<T>(name: string, action: () => T): T {
  if (process.env.MIO_EDITING_TIMINGS !== '1') { return action(); }
  const start = performance.now();
  try { return action(); } finally {
    const values = editingTimings.get(name) ?? [];
    values.push(performance.now() - start);
    if (values.length > 1000) { values.shift(); }
    editingTimings.set(name, values);
  }
}
export async function timedAsync<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (process.env.MIO_EDITING_TIMINGS !== '1') { return action(); }
  const start = performance.now();
  try { return await action(); } finally {
    const values = editingTimings.get(name) ?? [];
    values.push(performance.now() - start);
    if (values.length > 1000) { values.shift(); }
    editingTimings.set(name, values);
  }
}
