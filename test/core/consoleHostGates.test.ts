/**
 * Each identity check has to be able to refuse on its own. A stand-in answers
 * Get-Process with a chosen name and start time, and records whether Kill ran.
 * No process is started. Removing either check lets the stand-in be killed.
 */

import type { ExecFileException } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { endConsoleHostProcess } from '../../src/core/windowsConsoleHost.js';

const captured = vi.hoisted(() => ({
  scripts: [] as string[],
  execFile: null as null | typeof import('node:child_process').execFile,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  captured.execFile = actual.execFile;
  const isUnknownList = (value: unknown): value is readonly unknown[] => Array.isArray(value);
  const scriptFrom = (args: unknown): string => {
    if (!isUnknownList(args)) return '';
    const index = args.indexOf('-Command');
    const script = index >= 0 ? args[index + 1] : undefined;
    return typeof script === 'string' ? script : '';
  };
  return {
    ...actual,
    execFile: ((
      file: string,
      args?: ReadonlyArray<string>,
      options?: unknown,
      callback?: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      const cb = typeof options === 'function' ? options as typeof callback : callback;
      const opts = typeof options === 'function' ? undefined : options;
      const script = scriptFrom(args);
      if (file === 'powershell.exe' && script.includes('$proc.Kill()') && !script.includes('ShellPuppetStandIn')) {
        captured.scripts.push(script);
        const pid = /\$targetId = (\d+)/.exec(script)?.[1] ?? '0';
        cb?.(null, `${pid} 3\n`, '');
        return { unref(): void {} };
      }
      return actual.execFile(
        file,
        args,
        opts as Parameters<typeof actual.execFile>[2],
        cb as Parameters<typeof actual.execFile>[3],
      );
    }) as typeof actual.execFile,
  };
});

/** Not a live pid. The stand-in answers for it, so nothing is looked up. */
const STAND_IN_PID = 2_147_483_646;

interface StandIn {
  name: string;
  startMs: number;
  /** Reading the handle throws, as an open that Windows refuses. */
  handleThrows?: boolean;
  /** Reading the handle gives a zero pointer rather than a handle. */
  handleZero?: boolean;
}

interface StandInReport {
  killed: boolean;
  status: number;
}

function powershell(script: string): Promise<string> {
  const run = captured.execFile;
  if (run === null) throw new Error('the real execFile was not captured');
  return new Promise((resolve, reject) => {
    run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000 },
      (error, stdout) => {
        const text = typeof stdout === 'string' ? stdout : String(stdout);
        if (error) {
          const detail = error instanceof Error ? error.message : 'PowerShell failed';
          reject(new Error(`${detail}\n${text}`));
          return;
        }
        resolve(text);
      },
    );
  });
}

/** The production end script, captured without running it. */
async function captureScript(creationTime?: number): Promise<string | undefined> {
  captured.scripts = [];
  await endConsoleHostProcess(STAND_IN_PID, creationTime).then(
    () => undefined,
    () => undefined,
  );
  return captured.scripts[0];
}

/**
 * Run the captured end against a Get-Process that returns this stand-in.
 * Kill records a flag and ends no process.
 */
async function runStandIn(script: string, standIn: StandIn): Promise<StandInReport> {
  if (!/^[A-Za-z0-9]+$/.test(standIn.name)) throw new Error('stand-in name is not a token');
  // A ScriptProperty that throws is swallowed and the read yields null.
  // A null handle is the open failing. A real process throws instead, which
  // the end catches the same way.
  const handleValue =
    standIn.handleThrows === true ? '$null' : standIn.handleZero === true ? '[IntPtr]::Zero' : '[IntPtr]64';
  const prelude = [
    '$global:ShellPuppetStandInKilled = $false',
    `$global:ShellPuppetStandInName = '${standIn.name}'`,
    `$global:ShellPuppetStandInStart = [DateTimeOffset]::FromUnixTimeMilliseconds(${String(standIn.startMs)}).UtcDateTime`,
    'function Get-Process {',
    '  [CmdletBinding()]',
    '  param([int]$Id)',
    '  $p = New-Object psobject',
    '  $p | Add-Member -MemberType ScriptProperty -Name ProcessName -Value { $global:ShellPuppetStandInName }',
    '  $p | Add-Member -MemberType ScriptProperty -Name StartTime -Value { $global:ShellPuppetStandInStart }',
    `  $p | Add-Member -MemberType ScriptProperty -Name Handle -Value { ${handleValue} }`,
    '  $p | Add-Member -MemberType ScriptMethod -Name Kill -Value { $global:ShellPuppetStandInKilled = $true }',
    '  return $p',
    '}',
  ].join('\n');
  const body = script.replace(
    /\nexit 0\s*$/,
    '\nWrite-Output "KILLED $global:ShellPuppetStandInKilled"\nexit 0',
  );
  const stdout = await powershell(`${prelude}\n${body}`);
  const status = /^(\d+) (\d+)\b/m.exec(stdout);
  const killed = /^KILLED (True|False)$/m.exec(stdout);
  if (status === null || killed === null) throw new Error(`stand-in report was incomplete:\n${stdout}`);
  return { killed: killed[1] === 'True', status: Number(status[2]) };
}

afterEach(() => {
  captured.scripts = [];
});

describe.skipIf(process.platform !== 'win32')('console host identity gates', () => {
  const listedStart = 1_700_000_000_000;

  it('ends a stand-in that is still the listed host', async () => {
    const script = await captureScript(listedStart);
    if (script === undefined) throw new Error('the end did not build a script');
    const report = await runStandIn(script, { name: 'conhost', startMs: listedStart });
    expect(report.killed).toBe(true);
    expect(report.status).toBe(0);
  }, 40_000);

  it('does not kill a process that is not a console host, even at the listed start time', async () => {
    const script = await captureScript(listedStart);
    if (script === undefined) throw new Error('the end did not build a script');
    // The time matches. Only the name check can refuse this process.
    const report = await runStandIn(script, { name: 'node', startMs: listedStart });
    expect(report.killed).toBe(false);
    expect(report.status).toBe(3);
  }, 40_000);

  it('does not kill a console host whose start time is not the listed one', async () => {
    const script = await captureScript(1);
    if (script === undefined) throw new Error('the end did not build a script');
    // The name matches. Only the start-time check can refuse this host.
    const report = await runStandIn(script, { name: 'conhost', startMs: listedStart });
    expect(report.killed).toBe(false);
    expect(report.status).toBe(3);
  }, 40_000);

  it('does not kill by name when the caller gives no creation time', async () => {
    captured.scripts = [];
    const outcome = await endConsoleHostProcess(STAND_IN_PID).then(
      () => 'ended',
      (error: unknown) => error,
    );
    const script = captured.scripts[0];
    // A script that still ran would kill any console host it was handed.
    if (script !== undefined) {
      const report = await runStandIn(script, { name: 'conhost', startMs: listedStart });
      expect(report.killed).toBe(false);
    }
    expect(script).toBeUndefined();
    expect(outcome).toMatchObject({ code: 'ESRCH' });
  }, 40_000);

  it('does not kill by name when the creation time is the old skip sentinel', async () => {
    const script = await captureScript(-1);
    if (script === undefined) throw new Error('the end did not build a script');
    const report = await runStandIn(script, { name: 'conhost', startMs: listedStart });
    expect(report.killed).toBe(false);
    expect(report.status).toBe(3);
  }, 40_000);

  it('treats a failure to open the handle as the host gone, and does not kill', async () => {
    const script = await captureScript(listedStart);
    if (script === undefined) throw new Error('the end did not build a script');
    const report = await runStandIn(script, { name: 'conhost', startMs: listedStart, handleThrows: true });
    expect(report.killed).toBe(false);
    expect(report.status).toBe(2);
  }, 40_000);

  it('treats a zero handle as a failure to open, and does not kill', async () => {
    const script = await captureScript(listedStart);
    if (script === undefined) throw new Error('the end did not build a script');
    const report = await runStandIn(script, { name: 'conhost', startMs: listedStart, handleZero: true });
    expect(report.killed).toBe(false);
    expect(report.status).toBe(2);
  }, 40_000);
});
