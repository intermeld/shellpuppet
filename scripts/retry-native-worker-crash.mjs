/**
 * Windows node-pty 1.1.0 can crash a Vitest fork while its ConPTY exit threads
 * access their shared terminal list. Keep an ordinary test failure fatal; only
 * an access violation in an integration worker gets one full-suite retry.
 */

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const WORKER_CRASH = /Worker exited unexpectedly with exit code 3221225477 during started state while running test file [^\r\n]*[/\\]test[/\\]integration[/\\][^\r\n]*\.test\.ts/;
const TEST_FAILURE = /(?:^|\n)\s*(?:FAIL\s|Failed Tests|Test Files\s+\d+ failed\b|Tests\s+\d+ failed\b)/m;

export function isRetryableNativeWorkerCrash({ code, signal, output, truncated }, platform = process.platform) {
  const plain = output.replace(ANSI_COLOUR, '');
  return platform === 'win32' && code === 1 && signal === null && !truncated &&
    plain.includes('Error: [vitest-pool]: Worker forks emitted error.') &&
    plain.includes('Vitest caught 1 unhandled error during the test run.') &&
    /(?:^|\n)\s*Errors\s+1 error\b/m.test(plain) &&
    /(?:^|\n)\s*Tests\s+\d+ passed\b/m.test(plain) &&
    WORKER_CRASH.test(plain) && !TEST_FAILURE.test(plain);
}

function runVitest(args) {
  const entry = resolve('node_modules', 'vitest', 'vitest.mjs');
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [entry, 'run', ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });
    let output = '';
    let truncated = false;
    const capture = (chunk, stream) => {
      stream.write(chunk);
      if (truncated) return;
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
        output = '';
        truncated = true;
      }
    };
    child.stdout.on('data', (chunk) => capture(chunk, process.stdout));
    child.stderr.on('data', (chunk) => capture(chunk, process.stderr));
    child.once('error', rejectRun);
    child.once('close', (code, signal) => resolveRun({ code, signal, output, truncated }));
  });
}

export async function main(args = [], { run = runVitest, platform = process.platform, warn = (message) => process.stderr.write(message) } = {}) {
  const first = await run(args);
  if (first.code === 0) return 0;
  if (!isRetryableNativeWorkerCrash(first, platform)) return first.code ?? 1;

  warn('::warning::Vitest integration fork hit node-pty access violation 0xC0000005; rerunning the full suite once.\n');
  const second = await run(args);
  if (second.code === 0) {
    warn('::warning::The full suite passed on retry after a native worker crash.\n');
  }
  return second.code ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
