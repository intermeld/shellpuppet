import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { repoRoot } from './helpers.js';

const source = fs.readFileSync(path.join(repoRoot, 'src/viewer/dashboard-layout.js'), 'utf8');
const context: { ShellPuppetDashboardLayout?: {
  assign: (ids: string[], windows: { id: string; width: number; height: number }[]) => Record<string, string[]>;
  capacity: (width: number, height: number) => number;
} } = {};
vm.runInNewContext(source, context);
const layout = context.ShellPuppetDashboardLayout!;
const ids = (count: number) => Array.from({ length: count }, (_, index) => String(index));
const counts = (result: Record<string, string[]>) => Object.values(result).map((entries) => entries.length);

it('spreads mixed-capacity overflow while keeping the larger windows full', () => {
  const windows = [
    { id: 'small', width: 1280, height: 720 },
    { id: 'large', width: 1920, height: 1080 },
    { id: 'medium', width: 1304, height: 892 },
  ];
  expect(windows.map((entry) => layout.capacity(entry.width, entry.height))).toEqual([1, 4, 4]);
  expect(counts(layout.assign(ids(10), windows))).toEqual([2, 4, 4]);
});

it('spreads overflow by capacity, including equal rank zero windows', () => {
  const windows = [
    { id: 'rank-zero-a', width: 1280, height: 720 },
    { id: 'rank-zero-b', width: 1920, height: 1080 },
    { id: 'rank-zero-c', width: 1280, height: 720 },
  ];
  const result = layout.assign(ids(18), windows);
  expect(counts(result)).toEqual([3, 12, 3]);
  expect(Object.values(result).flat()).toEqual(ids(18));
  expect(counts(layout.assign(ids(18), windows))).toEqual([3, 12, 3]);
});

it('splits equal-capacity overflow evenly with a stable tie', () => {
  const windows = ['a', 'b', 'c'].map((id) => ({ id, width: 1280, height: 720 }));
  expect(counts(layout.assign(ids(8), windows))).toEqual([3, 3, 2]);
});
