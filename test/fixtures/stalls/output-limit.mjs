import { requestFailed } from './request-failed.mjs';

export function outputLimit({ message = 'Output length limit reached', marker = '✗ Error', ...options } = {}) {
  const source = requestFailed({ ...options, wrappedChrome: false });
  return source.replace('✗ Error\x1b[0m\x1b[38;2;128;128;128m · status 400 · non-retryable\x1b[0m', `${marker}\x1b[0m`)
    .replace('Request failed: Example connection closed.', message);
}
