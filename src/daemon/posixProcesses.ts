import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { LiveResumeProcess, ProcessImage } from '../agents/types.js';

const run = promisify(execFile);

export async function posixImages(signal: AbortSignal): Promise<ProcessImage[]> {
  // On macOS ucomm comes directly from the kernel's process name.
  const ps = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,ucomm='], { signal, maxBuffer: 1 << 20 });
  return ps.stdout.split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return row ? [{ pid: Number(row[1]), parent: Number(row[2]), name: row[3]!.trimEnd() }] : [];
  });
}

async function linuxBirths(rows: ProcessImage[], signal: AbortSignal) {
  const [stat, hz] = await Promise.all([
    readFile('/proc/stat', { encoding: 'utf8', signal }),
    run('/usr/bin/getconf', ['CLK_TCK'], { signal }),
  ]);
  const boot = Number(/^btime (\d+)$/m.exec(stat)?.[1]) * 1000;
  const tick = 1000 / Number(hz.stdout.trim());
  if (!(boot > 0 && tick > 0 && tick <= 1000)) return [];
  const processes = await Promise.all(rows.map(async row => {
    try {
      const stat = await readFile('/proc/' + String(row.pid) + '/stat', { encoding: 'utf8', signal });
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
      const ticks = Number(fields[19]); // starttime, field 22 of proc_pid_stat(5)
      if (fields[0] === 'Z' || fields[0] === 'X' || Number(fields[1]) !== row.parent ||
          !Number.isSafeInteger(ticks) || ticks <= 0) return;
      return { ...row, startedAt: Math.floor(boot + ticks * tick), instance: BigInt(ticks) };
    } catch { /* A disappearing process cannot establish ownership. */ }
  }));
  return processes.filter(p => p !== undefined);
}

export async function posixBirths(rows: ProcessImage[], signal: AbortSignal): Promise<LiveResumeProcess[]> {
  if (process.platform !== 'darwin') return linuxBirths(rows, signal);
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
  const { stdout } = await run('/usr/bin/ruby', ['--disable-gems', '-e', script, ...rows.map(p => String(p.pid))], {
    signal, env: { PATH: '/usr/bin:/bin' },
  });
  const byPid = new Map(rows.map(row => [row.pid, row]));
  return stdout.trim().split('\n').flatMap(line => {
    const [pid, parent, micros] = line.split(' ');
    const row = byPid.get(Number(pid));
    return row && Number(parent) === row.parent && micros ? [{ ...row,
      startedAt: Math.floor(Number(micros) / 1000), instance: BigInt(micros) }] : [];
  });
}
