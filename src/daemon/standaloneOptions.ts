import type { DaemonConfig } from './config.js';
import type { DaemonOptions } from './server.js';
import { daemonLogPath } from './paths.js';
import { createAuditor } from './audit.js';
import { DEFAULT_VIEWER_LAUNCH_MODE, signatureOverBudgetLog } from './config.js';
import { useDialogSignatures } from '../core/dialogs.js';
import { useAgentSignatures } from '../core/reasoning.js';
import { createFileLogger } from './logger.js';
import { releaseWrappedDaemon } from './wrappedStart.js';

/** Product defaults for a standalone process, using its verified directory and file. */
export function standaloneOptions(home: string, config: DaemonConfig, supervised: boolean): DaemonOptions {
  const logger = createFileLogger(daemonLogPath(home));
  // Recognised by every session's prompt detection from here on. The entries
  // that did not compile are included in the configuration problems. A signature
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

  return {
    home,
    logger,
    ...(supervised ? { afterPublish: releaseWrappedDaemon } : {}),
    audit: createAuditor(home, { captureContent: config.audit?.captureContent ?? false }, logger),
    ...(config.messaging !== undefined ? { messaging: config.messaging } : {}),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.sessionEnv !== undefined ? { sessionEnv: config.sessionEnv } : {}),
    ...(config.idleMinutes !== undefined ? { idleMs: config.idleMinutes * 60_000 } : {}),
    // The product default is to open the dashboard; the library default in
    // DaemonOptions stays "no-window" so a test daemon can never put browser
    // windows on someone's desktop by forgetting to opt out. Set
    // `viewer.launchMode` to "no-window" in config.json for unattended machines.
    viewer: { launchMode: DEFAULT_VIEWER_LAUNCH_MODE, ...config.viewer },
    ...(config.dashboard?.fontSize !== undefined ? { dashboardFontSize: config.dashboard.fontSize } : {}),
    ...(config.launcher !== undefined ? { launchProfiles: config.launcher } : {}),
    onSelfStop: () => process.exit(0),
    exitProcessOnStop: true,
  };
}
