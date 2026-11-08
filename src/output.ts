/** Treat terminal content as untrusted; preserve only newlines and horizontal tabs. */
export function sanitize(value: string): string {
  return value.toWellFormed().replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
export function bounded(value: string, bytes = 16384, lines = 200): { text: string; truncated: boolean } {
  const clean = sanitize(value);
  const rows = clean.split("\n");
  const tail = rows.slice(-lines).join("\n");
  const data = Buffer.from(tail);
  let result = tail;
  if (data.length > bytes) {
    let start = data.length - bytes;
    while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
    result = data.subarray(start).toString("utf8");
  }
  return { text: result, truncated: rows.length > lines || data.length > bytes };
}
export const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
