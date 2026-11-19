/** A single line of typed text followed by its submitting key. */
export function submittingText(data: string, key = '\r'): boolean {
  if (!data.endsWith(key)) return false;
  const body = data.slice(0, -key.length);
  return !/[\r\n]/.test(body) &&
    Array.from(body).some((character) => character > ' ' && character !== '\x7f');
}
