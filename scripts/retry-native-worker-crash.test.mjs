import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRetryableNativeWorkerCrash, main } from './retry-native-worker-crash.mjs';

const crash = [
  'Vitest caught 1 unhandled error during the test run.',
  'Error: [vitest-pool]: Worker forks emitted error.',
  'Caused by: Error: Worker exited unexpectedly with exit code 3221225477 during started state while running test file D:/a/shellpuppet/test/integration/reasoning-readers.test.ts',
  ' Test Files   (1)',
  '      Tests  15 passed (15)',
  '     Errors  1 error',
].join('\n');

const result = (output, overrides = {}) => ({ code: 1, signal: null, output, truncated: false, ...overrides });

test('retries only a Windows integration fork access violation with no failed tests', () => {
  assert.equal(isRetryableNativeWorkerCrash(result(crash), 'win32'), true);
  assert.equal(isRetryableNativeWorkerCrash(result(crash), 'linux'), false);
  assert.equal(isRetryableNativeWorkerCrash(result(crash, { code: 3221225477 }), 'win32'), false);
  assert.equal(isRetryableNativeWorkerCrash(result(crash, { truncated: true }), 'win32'), false);
});

test('a failed test is fatal even alongside a native worker crash', () => {
  for (const failure of [' FAIL test/core/foo.test.ts', ' Test Files  1 failed (1)', ' Tests  1 failed | 15 passed', ' Failed Tests 1']) {
    assert.equal(isRetryableNativeWorkerCrash(result(`${crash}\n${failure}`), 'win32'), false);
  }
});

test('other worker failures and unhandled errors are fatal', () => {
  assert.equal(isRetryableNativeWorkerCrash(result(crash.replace('3221225477', '1')), 'win32'), false);
  assert.equal(isRetryableNativeWorkerCrash(result(crash.replace('test/integration/', 'test/core/')), 'win32'), false);
  assert.equal(isRetryableNativeWorkerCrash(result(crash.replace('Vitest caught 1', 'Vitest caught 2')), 'win32'), false);
  assert.equal(isRetryableNativeWorkerCrash(result(crash.replace('Worker forks', 'Worker threads')), 'win32'), false);
  assert.equal(isRetryableNativeWorkerCrash(result(crash.replace('Errors  1 error', 'Errors  2 errors')), 'win32'), false);
});

test('reruns exactly once and requires the second run to pass', async () => {
  const calls = [];
  const warnings = [];
  const options = {
    platform: 'win32',
    warn: (message) => warnings.push(message),
    run: async (args) => {
      calls.push(args);
      return calls.length === 1 ? result(crash) : result('', { code: 0 });
    },
  };
  assert.equal(await main(['--project', 'integration'], options), 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(warnings.length, 2);

  calls.length = 0;
  options.run = async (args) => { calls.push(args); return result(crash); };
  assert.equal(await main([], options), 1);
  assert.equal(calls.length, 2);
});

test('does not rerun when a test failed', async () => {
  let calls = 0;
  const code = await main([], {
    platform: 'win32',
    warn: () => assert.fail('unexpected retry warning'),
    run: async () => { calls += 1; return result(`${crash}\n Tests  1 failed | 15 passed`); },
  });
  assert.equal(code, 1);
  assert.equal(calls, 1);
});
