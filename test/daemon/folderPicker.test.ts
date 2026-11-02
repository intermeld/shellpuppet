import * as path from 'node:path';
import type { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { chooseFolder, FOLDER_PICKER_FORCE_KILL_MS, FolderPickerFailureError, FolderPickerTimeoutError } from '../../src/daemon/folderPicker.js';

function fakeHelper(exitOnFirstKill: boolean): {
  execFileImpl: typeof execFile;
  signals: string[];
} {
  const signals: string[] = [];
  let callback: ((error: Error, stdout: Buffer, stderr: Buffer) => void) | undefined;
  const child = {
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill(signal = 'SIGTERM') {
      signals.push(signal);
      if (exitOnFirstKill || signal === 'SIGKILL') {
        this.signalCode = signal;
        queueMicrotask(() => callback?.(new Error('helper ended'), Buffer.alloc(0), Buffer.alloc(0)));
      }
      return true;
    },
  };
  const execFileImpl = ((...args: unknown[]) => {
    callback = args.at(-1) as typeof callback;
    return child;
  }) as unknown as typeof execFile;
  return { execFileImpl, signals };
}

describe('native folder picker runner', () => {
  it('pins Windows PowerShell, sets UTF-8 output and preserves a Unicode path with spaces', async () => {
    const calls: Array<{ file: string; args: string[]; options: { shell: false; windowsHide: true; cwd: string } }> = [];
    const folder = 'C:\\Users\\Renée\\Project space';
    const selected = await chooseFolder(new AbortController().signal, {
      platform: 'win32', systemRoot: 'C:\\Windows', executableExists: () => true,
      runner: (file, args, options) => {
        calls.push({ file, args, options });
        return Promise.resolve(Buffer.from(`${folder}\r\n`, 'utf8'));
      },
    });
    expect(selected).toBe(folder);
    expect(calls[0]?.file).toBe(path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(calls[0]?.args.join(' ')).toContain('[Console]::OutputEncoding = [Text.Encoding]::UTF8');
    expect(calls[0]?.options).toMatchObject({ shell: false, windowsHide: true });
    expect(calls[0]?.options.cwd).toBe(path.win32.dirname(calls[0]?.file ?? ''));
  });

  it('returns no path for an empty successful picker result', async () => {
    const result = await chooseFolder(new AbortController().signal, {
      platform: 'win32', executableExists: () => true, runner: () => Promise.resolve(Buffer.from('', 'utf8')),
    });
    expect(result).toBeNull();
  });

  it('reports a non-zero helper exit as a failure', async () => {
    await expect(chooseFolder(new AbortController().signal, {
      platform: 'win32', executableExists: () => true,
      runner: () => Promise.reject(Object.assign(new Error('failed'), { code: 2 })),
    })).rejects.toBeInstanceOf(FolderPickerFailureError);
  });

  it('aborts a helper that never settles on its own', async () => {
    const controller = new AbortController();
    const pending = chooseFolder(controller.signal, {
      platform: 'win32', executableExists: () => true,
      runner: async (_file, _args, options) => new Promise<Buffer>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('aborted')), { once: true });
      }),
    });
    controller.abort(new FolderPickerTimeoutError('The folder picker timed out.'));
    await expect(pending).rejects.toBeInstanceOf(FolderPickerTimeoutError);
  });

  it('ends a native helper on abort and does not force kill after it exits', async () => {
    const helper = fakeHelper(true);
    const controller = new AbortController();
    const pending = chooseFolder(controller.signal, {
      platform: 'win32', executableExists: () => true, execFileImpl: helper.execFileImpl,
    });
    controller.abort(new FolderPickerTimeoutError('The folder picker timed out.'));
    await expect(pending).rejects.toBeInstanceOf(FolderPickerTimeoutError);
    expect(helper.signals).toEqual(['SIGTERM']);
  });

  it('force kills a native helper that ignores the first termination', async () => {
    const helper = fakeHelper(false);
    const controller = new AbortController();
    const pending = chooseFolder(controller.signal, {
      platform: 'win32', executableExists: () => true, execFileImpl: helper.execFileImpl,
    });
    controller.abort(new FolderPickerTimeoutError('The folder picker timed out.'));
    await expect(Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('force kill did not settle')), FOLDER_PICKER_FORCE_KILL_MS + 500)),
    ])).resolves.toBe('settled');
    expect(helper.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(pending).rejects.toBeInstanceOf(FolderPickerTimeoutError);
  });

  it('uses only fixed Linux helper directories', async () => {
    const files: string[] = [];
    const selected = await chooseFolder(new AbortController().signal, {
      platform: 'linux', executableExists: (file) => file === '/usr/local/bin/kdialog',
      runner: (file) => { files.push(file); return Promise.resolve(Buffer.from('/tmp/My folder\n')); },
    });
    expect(files).toEqual(['/usr/local/bin/kdialog']);
    expect(selected).toBe('/tmp/My folder');
  });
});
