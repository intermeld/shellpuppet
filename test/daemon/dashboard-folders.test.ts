import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('dashboard recent folders', () => {
  it('puts recent offered choices first, limits memory to five and ignores stale choices', () => {
    const source = fs.readFileSync(path.resolve('src/viewer/dashboard-folders.js'), 'utf8');
    const context: Record<string, unknown> = {};
    vm.runInNewContext(source, context);
    const choices = context['ShellPuppetDashboardFolders'] as {
      remember: (recent: Record<string, string[]>, profile: string, choice: string) => Record<string, string[]>;
      order: (offered: { value: string }[], recent: Record<string, string[]>, profile: string) => { value: string }[];
      anyOptions: (recent: Record<string, string[]>, profile: string, roots: { path: string }[]) => string[];
    };
    let recent: Record<string, string[]> = {};
    for (const value of ['a', 'b', 'c', 'd', 'e', 'f', 'c']) recent = choices.remember(recent, 'shell', value);
    expect([...recent['shell']!]).toEqual(['c', 'f', 'e', 'd', 'b']);
    expect([...choices.order([{ value: 'a' }, { value: 'b' }, { value: 'c' }], recent, 'shell')].map((item) => item.value)).toEqual(['c', 'b', 'a']);
    expect([...choices.order([{ value: 'a' }, { value: 'b' }], recent, 'other')].map((item) => item.value)).toEqual(['a', 'b']);
  });
  it('offers recent paths before root paths in one list without duplicates', () => {
    const source = fs.readFileSync(path.resolve('src/viewer/dashboard-folders.js'), 'utf8');
    const context: Record<string, unknown> = {};
    vm.runInNewContext(source, context);
    const choices = context['ShellPuppetDashboardFolders'] as {
      anyOptions: (recent: Record<string, string[]>, profile: string, roots: { path: string }[]) => string[];
    };
    expect([...choices.anyOptions({ open: ['C:/recent', 'C:/root'] }, 'open', [{ path: 'C:/root' }, { path: 'C:/other' }])])
      .toEqual(['C:/recent', 'C:/root', 'C:/other']);
  });
});
