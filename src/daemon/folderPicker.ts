/** Native desktop folder picker. The daemon route serialises calls to this function. */
import { execFile } from 'node:child_process';

export const FOLDER_PICKER_TIMEOUT_MS = 10 * 60_000;

export class FolderPickerUnavailableError extends Error {}
export class FolderPickerTimeoutError extends Error {}

function runPicker(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: FOLDER_PICKER_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error !== null) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ETIMEDOUT') reject(new FolderPickerTimeoutError('The folder picker timed out.'));
        else if (code === 'ENOENT') reject(new FolderPickerUnavailableError('No folder picker is available.'));
        else resolve(null);
        return;
      }
      const folder = stdout.replace(/\r?\n$/, '');
      resolve(folder === '' ? null : folder);
    });
  });
}

export async function chooseFolder(): Promise<string | null> {
  if (process.platform === 'win32') {
    const script = "$folder = (New-Object -ComObject Shell.Application).BrowseForFolder(0, 'Choose a folder', 0x50); if ($null -ne $folder) { $folder.Self.Path }";
    return runPicker('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  }
  if (process.platform === 'darwin') return runPicker('osascript', ['-e', 'POSIX path of (choose folder)']);
  try { return await runPicker('zenity', ['--file-selection', '--directory']); }
  catch (error) {
    if (!(error instanceof FolderPickerUnavailableError)) throw error;
    return runPicker('kdialog', ['--getexistingdirectory']);
  }
}
