/**
 * Under `shell: false` on Windows, a candidate whose file name contains `:`
 * names an alternate data stream and is refused. The decision is a predicate
 * over strings. This file calls that predicate and nothing else: it starts
 * no program, opens no stream and creates no file, including while the
 * predicate is missing.
 */

import { describe, expect, it } from 'vitest';
import { windowsCandidateNamesStream } from '../../src/core/session.js';

const cases = [
  ['C:\\Windows\\System32\\cmd.exe', false],
  ['C:\\Windows\\System32\\CMD.EXE', false],
  ['D:\\dir\\app.com', false],
  ['\\\\server\\share\\app.exe', false],
  ['C:real.exe', false],
  ['C:foo\\bar.exe', false],
  ['cmd', false],
  ['D:\\dir\\run.cmd:s.exe', true],
  ['run.cmd:s.exe', true],
  ['C:\\dir\\real.exe:stream', true],
  ['C:\\dir\\real.exe::$DATA', true],
  ['C:\\dir\\run.cmd::$DATA', true],
  ['\\\\?\\C:\\dir\\file.cmd:s.exe', true],
  ['file.exe:', true],
  ['C:stream:s.exe', true],
  ['C:\\dir\\app.exe:stream:more', true],
] as const;

describe('windowsCandidateNamesStream', () => {
  it.each(cases)('%s names a stream: %s', (candidate, namesStream) => {
    expect(windowsCandidateNamesStream(candidate)).toBe(namesStream);
  });
});
