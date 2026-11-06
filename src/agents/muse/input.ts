/** Muse needs a short pause after text before its submitting Enter. */
export const MUSE_SUBMIT_DELAY_MS = 400;

export function museSubmittingText(data: string): boolean {
  if (!data.endsWith('\r')) return false;
  const body = data.slice(0, -1);
  return !/[\r\n]/.test(body) &&
    Array.from(body).some((character) => character > ' ' && character !== '\x7f');
}
