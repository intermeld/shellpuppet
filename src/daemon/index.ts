/**
 * Daemon entry point. Spawned fully detached by clients (design §2.2) with no
 * stdio, so everything observable goes to `~/.shellpuppet/daemon.log`.
 *
 * Exit codes: 0 = clean stop or deferred to a healthy incumbent; 1 = failure.
 */

import { Daemon, AlreadyRunningError } from './server.js';
import { createAuditor } from './audit.js';
import { readDaemonConfig, signatureOverBudgetLog } from './config.js';
import { useDialogSignatures } from '../core/dialogs.js';
import { useAgentSignatures } from '../core/reasoning.js';
import { createFileLogger } from './logger.js';
import { assertNodeVersion } from './meta.js';
import { daemonLogPath, ensureHome, shellpuppetHome } from './paths.js';

async function main(): Promise<void> {
  assertNodeVersion();
  const home = shellpuppetHome();
  await ensureHome(home);
  const logger = createFileLogger(daemonLogPath(home));
  // Shape-validated (design §4.3 fail-closed): a malformed policy section
  // arrives here as deny-all with the problem in its refusal reason. It must
  // never be silently ignored, because ignoring it is fail-open.
  const { config, problems } = readDaemonConfig(home);
  for (const problem of problems) logger.warn('CONFIG PROBLEM', { problem });
  // Recognised by every session's prompt detection from here on. The entries
  // that did not compile were reported among the problems above; a signature,
  // built-in or from config, that runs past its time budget on a screen is
  // reported then and set aside for a minute at a time.
  useDialogSignatures(config.dialogs ?? [], (name, builtIn) => {
    const { message, meta } = signatureOverBudgetLog('dialog', name, builtIn);
    logger.warn(message, meta);
  });

  // How hideReasoning and terminal_result read each agent's screen: the
  // built-in signatures, plus or replaced by the config's.
  useAgentSignatures(config.agentSignatures ?? [], (name, builtIn) => {
    const { message, meta } = signatureOverBudgetLog('agent', name, builtIn);
    logger.warn(message, meta);
  });

  const daemon = new Daemon({
    home,
    logger,
    audit: createAuditor(home, { captureContent: config.audit?.captureContent ?? false }, logger),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.sessionEnv !== undefined ? { sessionEnv: config.sessionEnv } : {}),
    ...(config.idleMinutes !== undefined ? { idleMs: config.idleMinutes * 60_000 } : {}),
    // The PRODUCT default is to open the viewer window; the library default in
    // DaemonOptions stays "none" so a test daemon can never put browser
    // windows on someone's desktop by forgetting to opt out. Set
    // `viewer.launchMode` to "none" in config.json for unattended machines.
    viewer: { launchMode: 'isolated-app', ...config.viewer },
    ...(config.launcher !== undefined ? { launchProfiles: config.launcher } : {}),
    onSelfStop: () => process.exit(0),
  });

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
