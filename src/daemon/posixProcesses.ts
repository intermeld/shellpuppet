import { execFile } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { LiveResumeProcess } from '../agents/types.js';

const run = promisify(execFile);

async function linuxTimes(signal: AbortSignal) {
  const [stat, hz, latestBoot] = await Promise.all([
    readFile('/proc/stat', { encoding: 'utf8', signal }),
    run('/usr/bin/getconf', ['CLK_TCK'], { signal }),
    readFile('/proc/uptime', { encoding: 'utf8', signal }).then(text => Date.now() - Number(text.split(' ')[0]) * 1000),
  ]);
  // btime is the kernel's epoch in whole seconds. Uptime supplies a tighter
  // upper bound for mtime, even when the file is written in the first second.
  const boot = Number(/^btime (\d+)$/m.exec(stat)?.[1]) * 1000;
  const tick = 1000 / Number(hz.stdout.trim());
  if (!Number.isFinite(boot) || !Number.isFinite(latestBoot) || !(tick > 0 && tick <= 1000)) {
    throw new Error('Could not verify the procfs clock.');
  }
  return async (pid: number) => {
    const stat = await readFile('/proc/' + String(pid) + '/stat', { encoding: 'utf8', signal });
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return;
    const ticks = Number(fields[19]); // starttime, field 22 of proc_pid_stat(5)
    if (!Number.isSafeInteger(ticks) || ticks <= 0) return;
    return { parent: Number(fields[1]), startedAt: Math.floor(boot + ticks * tick), instance: BigInt(ticks),
      latestStart: Math.ceil(Math.min(boot + 1000, latestBoot) + (ticks + 1) * tick) };
  };
}

async function darwinTimes(pids: number[], signal: AbortSignal) {
  // System Ruby's Fiddle calls libproc without a compiler. PROC_PIDTBSDINFO
  // ends with the two uint64 fields pbi_start_tvsec and pbi_start_tvusec.
  const script = String.raw`
require 'fiddle/import'
module ProcInfo
  extend Fiddle::Importer
  dlload '/usr/lib/libproc.dylib'
  extern 'int proc_pidinfo(int,int,unsigned long long,void*,int)'
end
ARGV.each do |arg|
  data = "\0".b * 136
  next unless ProcInfo.proc_pidinfo(Integer(arg), 3, 0, data, data.size) == data.size
  next if data.unpack1('x4I') == 5 # SZOMB
  parent, seconds, micros = data.unpack('x16Ix100Q2')
  puts "#{arg} #{parent} #{seconds * 1000000 + micros}"
end`;
  const { stdout } = await run('/usr/bin/ruby', ['--disable-gems', '-e', script, ...pids.map(String)], {
    signal, env: { PATH: '/usr/bin:/bin' },
  });
  const times = new Map<number, Pick<LiveResumeProcess, 'parent' | 'startedAt' | 'latestStart' | 'instance'>>();
  for (const entry of stdout.trim().split('\n')) {
    const [pid, parent, micros] = entry.split(' ');
    if (micros) times.set(Number(pid), { parent: Number(parent), startedAt: Math.floor(Number(micros) / 1000),
      latestStart: Math.ceil(Number(micros) / 1000), instance: BigInt(micros) });
  }
  return (pid: number) => times.get(pid);
}

const interpreters = new Set(['node', 'nodejs', 'bun']);

async function darwinCommands(pids: number[], signal: AbortSignal) {
  const commands = new Map<number, string>();
  if (!pids.length) return commands;
  const ps = await run('/bin/ps', ['-ww', '-p', pids.join(','), '-o', 'pid=,args='], { signal });
  for (const line of ps.stdout.split('\n')) {
    const row = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (row) commands.set(Number(row[1]), row[2]!);
  }
  return commands;
}

async function program(pid: number, name: string, signal: AbortSignal, commands?: Map<number, string>) {
  if (!interpreters.has(name)) return name;
  let script: string | undefined;
  if (!commands) {
    const file = await open('/proc/' + String(pid) + '/cmdline', 'r');
    try {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await file.read(buffer);
      const args = buffer.toString('utf8', 0, bytesRead).split('\0', 3);
      if (args.length === 3) script = args[1];
    } finally { await file.close(); }
  } else {
    const command = commands.get(pid) ?? '';
    script = /^\s*\S+\s+(\S+)/.exec(command)?.[1];
    // ps flattens argv on Darwin. An ambiguous script path ends this branch.
    if (command.includes('/cli.js') && !script?.endsWith('/cli.js')) return;
  }
  return script && !script.startsWith('-') ? script : undefined;
}

export async function posixProcesses(roots: number[], signal: AbortSignal): Promise<LiveResumeProcess[]> {
  const ps = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm='], { signal, maxBuffer: 1 << 20 });
  const rows = new Map<number, { pid: number; parent: number; name: string }>();
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!row) continue;
    const pid = Number(row[1]);
    const parent = Number(row[2]);
    rows.set(pid, { pid, parent, name: basename(row[3]!) });
    const siblings = children.get(parent);
    if (siblings) siblings.push(pid);
    else children.set(parent, [pid]);
  }
  const pending = new Set(roots);
  const owned = [];
  for (const pid of pending) {
    const row = rows.get(pid);
    if (!row) continue;
    owned.push(row);
    // Avoid queuing an unbounded number of procfs reads.
    if (owned.length > 512) return [];
    for (const child of children.get(pid) ?? []) pending.add(child);
  }
  const mac = process.platform === 'darwin';
  const [timeOf, commands] = await Promise.all([
    mac ? darwinTimes(owned.map(p => p.pid), signal) : linuxTimes(signal),
    mac ? darwinCommands(owned.filter(p => interpreters.has(p.name)).map(p => p.pid), signal) : undefined,
  ]);
  const processes = await Promise.all(owned.map(async row => {
    try {
      const [time, name] = await Promise.all([timeOf(row.pid), program(row.pid, row.name, signal, commands)]);
      if (name && time?.parent === row.parent) return { ...row, ...time, name };
    } catch { /* A disappearing process cannot establish a chain of ownership. */ }
  }));
  return processes.filter(p => p !== undefined);
}
