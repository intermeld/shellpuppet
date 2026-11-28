import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { configPath, ensureWatchedHome, HomeIdentityError } from './paths.js';

export interface ConfigRead {
  text?: string;
  /** Recheck the same directory and file after asynchronous verification and preparation. */
  current(): boolean;
}

const permissionProblem = 'Cannot verify owner-only permissions for config.json or its directory.';
const windowsPermissions = `
function Test-ConfigPermissions([bool]$includeFile) {
$ErrorActionPreference = 'Stop'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $id.User
$items = @([IO.DirectoryInfo]::new($env:SP_HOME))
if ($includeFile) { $items += [IO.FileInfo]::new([IO.Path]::Combine($env:SP_HOME,'config.json')) }
foreach ($item in $items) {
  if (!$item.Exists) { return $false }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
  $acl = $item.GetAccessControl()
  $rules = @($acl.GetAccessRules($true,$true,$sid.GetType()))
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or
      $rules[0].AccessControlType -ne 'Allow' -or [int]$rules[0].PropagationFlags -ne 0 -or $rules[0].FileSystemRights -ne 'FullControl') { return $false }
  $owner = $acl.GetOwner($sid.GetType())
  if ($owner -ne $sid -and !($item -is [IO.FileInfo] -and $rules[0].IsInherited -and $owner -eq $id.Owner)) { return $false }
  if ($item -is [IO.DirectoryInfo] -and (!$acl.AreAccessRulesProtected -or [int]$rules[0].InheritanceFlags -ne 3)) { return $false }
}
return $true
}
`;

const powershell = () => join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const argsFor = (script: string) => ['-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(windowsPermissions + script, 'utf16le').toString('base64')];
const aclEnv = (home: string) => ({ SystemRoot: process.env['SystemRoot'], SP_HOME: home });

/** Reuse the Windows ACL reader. Requests check only this daemon's fixed home and config. */
export class ConfigPermissions {
  private child?: ChildProcessWithoutNullStreams;
  private reply?: (line?: string) => void;
  private secured?: { directory: string; stat: fs.BigIntStats };

  constructor(private readonly home: string) {}

  async secureHome(): Promise<string> {
    this.secured = undefined;
    try {
      this.secured = await ensureWatchedHome(this.home, (script, env) => {
        this.close();
        this.startReader(env['SP_PRIVATE_HOME']!, script, env);
        return this.waitForReply(15_000);
      });
      return this.verifiedHome();
    } catch (error) { this.secured = undefined; this.close(); throw error; }
  }

  verifiedHome(): string {
    if (!this.secured) throw new HomeIdentityError(permissionProblem);
    const { directory, stat } = this.secured;
    const current = fileStat(directory);
    if (!current?.isDirectory() || stat.dev !== current.dev || stat.ino !== current.ino) throw new HomeIdentityError(permissionProblem);
    return directory;
  }

  /** Inspect the opened file and its entry under the directory we hardened. */
  async read(): Promise<ConfigRead> {
    const { secured } = this;
    if (!secured) throw new Error(permissionProblem);
    const home = secured.directory;
    const file = configPath(home);
    const dir = fileStat(home);
    if (!dir?.isDirectory() || dir.dev !== secured.stat.dev || dir.ino !== secured.stat.ino) throw new Error(permissionProblem);
    const before = fileStat(file);
    const uid = process.getuid?.();
    if ((before && (!before.isFile() || before.nlink !== 1n)) ||
        (uid !== undefined && (dir.uid !== BigInt(uid) || (dir.mode & 0o077n) !== 0n ||
          (before && (before.uid !== BigInt(uid) || (before.mode & 0o022n) !== 0n))))) throw new Error(permissionProblem);
    const current = () => same(dir, fileStat(home)) && same(before, fileStat(file));
    // Permissions can change without changing the bytes. Verify them on every reread.
    if (process.platform === 'win32') {
      try {
        await this.check(before !== undefined);
      } catch { throw new Error(permissionProblem); }
    }
    if (!current()) throw new Error('config.json changed during the read.');
    if (!before) return { current };
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const fd = fs.openSync(file, flags);
    try {
      if (!same(before, fs.fstatSync(fd, { bigint: true }))) throw new Error('config.json changed during the read.');
      const bytes = fs.readFileSync(fd);
      if (!current() || !same(before, fs.fstatSync(fd, { bigint: true }))) throw new Error('config.json changed during the read.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error('config.json is not valid UTF-8.'); }
      return { text, current };
    } finally { fs.closeSync(fd); }
  }

  private startReader(directory: string, hardening?: string, env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    // Run the startup hardener once. A replacement reader only checks permissions.
    const startup = hardening === undefined ? '' : `try {
${hardening}
[Console]::WriteLine()
[Console]::Out.Flush()
} catch { exit 1 }
`;
    const script = startup + `
while ($null -ne ($line = [Console]::ReadLine())) {
  try { $ok = Test-ConfigPermissions ($line -eq '1') } catch { $ok = $false }
  [Console]::WriteLine([int]$ok)
  [Console]::Out.Flush()
}`;
    const child = this.child = spawn(powershell(), argsFor(script), { windowsHide: true, env: { ...aclEnv(directory), ...env }, stdio: 'pipe' });
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => { if (this.child === child) this.reply?.(line); });
    const lost = () => { if (this.child === child) this.close(); };
    child.on('error', lost);
    child.stdin.on('error', lost);
    child.once('close', lost);
    return child;
  }

  private waitForReply(timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), timeout).unref();
      this.reply = line => {
        clearTimeout(timer);
        this.reply = undefined;
        if (line === undefined) reject(new Error(permissionProblem)); else resolve(line);
      };
    });
  }

  private async check(includeFile: boolean): Promise<void> {
    const child = this.startReader(this.verifiedHome());
    const reply = this.waitForReply(10_000);
    try { child.stdin.write(includeFile ? '1\n' : '0\n'); }
    catch { this.close(); }
    if (await reply !== '1') throw new Error(permissionProblem);
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.reply?.();
    child?.stdin.end();
    child?.kill();
  }
}

function fileStat(file: string): fs.BigIntStats | undefined {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function same(a: fs.BigIntStats | undefined, b: fs.BigIntStats | undefined): boolean {
  if (!a || !b) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs &&
    a.size === b.size && a.mode === b.mode && a.uid === b.uid;
}

interface Watch { on(event: 'error', listener: () => void): unknown; close(): void }
export type WatchHealth = 'watching' | 'polling' | 'stopped';

export class ConfigWatcher {
  private watch?: Watch;
  private timer?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  private burst?: number;
  private stopped = false;
  private dirty = false;
  private running?: Promise<void>;
  private retryAt = 0;
  private retryMs = 1000;

  constructor(private readonly options: {
    watch(notify: (filename: string | null) => void): Watch;
    read(): Promise<ConfigRead>;
    receive(read: ConfigRead): void;
    fail(reason: string): void;
    health(state: WatchHealth): void;
  }) {}

  private attach(): void {
    if (this.watch || Date.now() < this.retryAt) return;
    const failed = () => {
      if (this.stopped) return;
      this.watch?.close();
      this.watch = undefined;
      this.retryAt = Date.now() + this.retryMs;
      this.retryMs = Math.min(30_000, 2 * this.retryMs);
      this.options.health('polling');
    };
    try {
      this.watch = this.options.watch(name => {
        if (this.stopped || (name !== null && name !== 'config.json')) return;
        this.burst ??= Date.now();
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.burst = undefined; void this.request(); },
          Math.max(0, Math.min(100, this.burst + 500 - Date.now()))).unref();
      });
      this.watch.on('error', failed);
      this.options.health('watching');
      this.retryMs = 1000;
    } catch { failed(); }
  }

  start(): Promise<void> {
    this.attach();
    this.poll = setInterval(() => { this.attach(); if (!this.running) void this.request(); }, 2000).unref();
    return this.request();
  }

  request(): Promise<void> {
    this.dirty = true;
    this.running ??= this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async drain(): Promise<void> {
    let retriedReplacement = false;
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      try {
        const candidate = await this.options.read();
        if (this.stopped || this.dirty) continue;
        if (!candidate.current()) throw new Error('config.json changed during the read.');
        this.options.receive(candidate);
      } catch (error) {
        if (this.stopped) return;
        const message = error instanceof Error ? error.message : '';
        if (message === 'config.json changed during the read.' && !retriedReplacement) {
          retriedReplacement = true;
          this.dirty = true;
          continue;
        }
        this.options.fail([permissionProblem, 'config.json changed during the read.', 'config.json is not valid UTF-8.'].includes(message)
          ? message : 'Could not read config.json.');
      }
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.poll);
    clearTimeout(this.timer);
    this.watch?.close();
    this.options.health('stopped');
  }
}
