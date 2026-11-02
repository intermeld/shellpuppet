/** Native desktop folder picker. The daemon route serialises calls to this function. */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const FOLDER_PICKER_TIMEOUT_MS = 10 * 60_000;

export class FolderPickerUnavailableError extends Error {}
export class FolderPickerTimeoutError extends Error {}
export class FolderPickerFailureError extends Error {}

export interface PickerRunOptions {
  signal: AbortSignal;
  cwd: string;
  shell: false;
  windowsHide: true;
}

export type PickerProcessRunner = (file: string, args: string[], options: PickerRunOptions) => Promise<Buffer>;

export interface PickerDependencies {
  runner?: PickerProcessRunner;
  platform?: NodeJS.Platform;
  systemRoot?: string;
  executableExists?: (file: string) => boolean;
}

function executableExists(file: string): boolean {
  try { return fs.statSync(file).isFile(); }
  catch { return false; }
}

/** execFile calls back after the child closes, including when aborted. */
const nativeRunner: PickerProcessRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, encoding: 'buffer', maxBuffer: 64 * 1024 }, (error, stdout) => {
    if (error !== null) { reject(error instanceof Error ? error : new FolderPickerFailureError('The folder picker failed.')); return; }
    resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
  });
});

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new FolderPickerFailureError('The folder picker was cancelled.');
}

async function runPicker(file: string, args: string[], signal: AbortSignal, runner: PickerProcessRunner, platform: NodeJS.Platform): Promise<string | null> {
  if (signal.aborted) throw abortReason(signal);
  try {
    const stdout = await runner(file, args, {
      signal, cwd: platform === 'win32' ? path.win32.dirname(file) : path.posix.dirname(file),
      shell: false, windowsHide: true,
    });
    if (signal.aborted) throw abortReason(signal);
    const folder = stdout.toString('utf8').replace(/\r?\n$/, '');
    return folder === '' ? null : folder;
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new FolderPickerUnavailableError('No folder picker is available.');
    if (platform === 'linux' && String(code) === '1') return null;
    if (platform === 'darwin' && String(code) === '1' && /User canceled|\(-128\)/i.test(String(error))) return null;
    throw new FolderPickerFailureError('The folder picker could not open.');
  }
}

function fixedLinuxHelper(name: 'zenity' | 'kdialog', exists: (file: string) => boolean): string | undefined {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
    const file = path.posix.join(dir, name);
    if (exists(file)) return file;
  }
  return undefined;
}

export async function chooseFolder(signal: AbortSignal, deps: PickerDependencies = {}): Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  const exists = deps.executableExists ?? executableExists;
  const runner = deps.runner ?? nativeRunner;
  if (platform === 'win32') {
    const file = path.win32.join(deps.systemRoot ?? process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!exists(file)) throw new FolderPickerUnavailableError('No folder picker is available.');
    const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $folder = (New-Object -ComObject Shell.Application).BrowseForFolder(0, 'Choose a folder', 0x50); if ($null -ne $folder) { $folder.Self.Path }";
    return runPicker(file, ['-NoProfile', '-STA', '-Command', script], signal, runner, platform);
  }
  if (platform === 'darwin') {
    const file = '/usr/bin/osascript';
    if (!exists(file)) throw new FolderPickerUnavailableError('No folder picker is available.');
    return runPicker(file, ['-e', 'POSIX path of (choose folder)'], signal, runner, platform);
  }
  const zenity = fixedLinuxHelper('zenity', exists);
  if (zenity !== undefined) return runPicker(zenity, ['--file-selection', '--directory'], signal, runner, platform);
  const kdialog = fixedLinuxHelper('kdialog', exists);
  if (kdialog !== undefined) return runPicker(kdialog, ['--getexistingdirectory'], signal, runner, platform);
  throw new FolderPickerUnavailableError('No folder picker is available.');
}
