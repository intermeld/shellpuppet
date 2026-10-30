/**
 * The liveness probes behind telling a busy daemon from one that has gone
 * (design §2.3).
 */

import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { daemonRunning, portAccepts, processExists } from '../../src/daemon/liveness.js';

describe('processExists', () => {
  it('finds this process', () => {
    expect(processExists(process.pid)).toBe(true);
  });

  it('never probes pid 0 or a negative pid, which address process groups', () => {
    expect(processExists(0)).toBe(false);
    expect(processExists(-1)).toBe(false);
    expect(processExists(1.5)).toBe(false);
  });
});

describe('portAccepts', () => {
  it('accepts on a listening port and refuses on a closed one', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    expect(await portAccepts(port)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await portAccepts(port)).toBe(false);
  });

  it('refuses a port number that cannot be one', async () => {
    expect(await portAccepts(0)).toBe(false);
    expect(await portAccepts(70_000)).toBe(false);
  });
});

describe('daemonRunning', () => {
  it('needs both a live process and an accepting port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    expect(await daemonRunning({ pid: process.pid, port })).toBe(true);
    expect(await daemonRunning({ pid: 0, port })).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await daemonRunning({ pid: process.pid, port })).toBe(false);
  });
});
