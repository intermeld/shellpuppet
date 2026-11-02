import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseFolder, FolderPickerFailureError, FolderPickerTimeoutError } from '../../src/daemon/folderPicker.js';

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
