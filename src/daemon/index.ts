/**
 * Daemon entry point. Spawned fully detached by clients (design §2.2) with no
 * stdio, so everything observable goes to `~/.shellpuppet/daemon.log`.
 *
 * Exit codes: 0 = clean stop or deferred to a healthy incumbent; 1 = failure.
 */

import { removeClaimCredentials } from '../core/types.js';
import { Daemon, AlreadyRunningError } from './server.js';
import { assertNodeVersion } from './meta.js';
import { shellpuppetHome } from './paths.js';
import { WRAPPED_START_IPC } from './wrappedStart.js';

async function main(): Promise<void> {
  assertNodeVersion();
  removeClaimCredentials(process.env);
  const supervised = process.env[WRAPPED_START_IPC] === '1' && process.send !== undefined;
  delete process.env[WRAPPED_START_IPC];
  const { daemon, logger } = await Daemon.standalone(shellpuppetHome(), supervised);

  const shutdown = (signal: string): void => {
    logger.info('signal received, shutting down', { signal });
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // `finally`: the process exits even if the stop itself fails, rather than
  // living on with its port closed.
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception, shutting down', { error: String(error.stack ?? error) });
    void daemon.stop().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection, shutting down', { reason: String(reason) });
    void daemon.stop().finally(() => process.exit(1));
  });

  try {
    await daemon.start();
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      logger.info('deferring to the running daemon', {
        pid: error.state.pid,
        port: error.state.port,
      });
      process.exit(0);
    }
    logger.error('daemon failed to start', { error: String(error) });
    process.exit(1);
  }
}

void main();
