import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureHome } from '../../src/daemon/paths.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn(),
}));

describe.runIf(process.platform === 'win32')('Windows home verification', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-home-check-')); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(execFileSync).mockReset();
    fs.rmdirSync(home);
  });

  it.each(['', 'S-1-5-21-123|S-1-5-21-123'])('retains a timeout with verification output %j', stdout => {
    const failure = Object.assign(new Error('PowerShell timed out'), {
      code: 'ETIMEDOUT', signal: 'SIGTERM', stdout, stderr: '',
    });
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw failure; });
    expect(() => ensureHome(home)).toThrow(expect.objectContaining({
      message: 'Could not verify owner-only Windows permissions in the ShellPuppet home.', cause: failure,
    }));
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    { remaining: undefined, timeout: 60_000 },
    { remaining: 30_000, timeout: 30_000 },
    { remaining: 8_000, timeout: 8_000 },
  ])('uses a bounded ACL check with $remaining ms left for startup', ({ remaining, timeout }) => {
    const now = 100_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(execFileSync).mockReturnValue('S-1-5-21-123|S-1-5-21-123');
    ensureHome(home, remaining === undefined ? undefined : now + remaining);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ timeout }));
  });

  it('refuses an expired deadline before starting PowerShell', () => {
    expect(() => ensureHome(home, 0)).toThrow(expect.objectContaining({
      cause: new Error('Home permission check deadline expired.'),
    }));
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
