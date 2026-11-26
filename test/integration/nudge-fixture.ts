import { join } from 'node:path';
import type { DaemonOptions } from '../../src/daemon/server.js';
import { parseLauncher } from '../../src/daemon/launchProfiles.js';
import { api, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

/** The sender is an outside group member. Each recipient gets its chair role from an owner launch profile. */
export async function startNudgeDaemon(options: Partial<DaemonOptions> & { home: string },
  recipients: Record<string, string>) {
  const profiles = Object.entries(recipients).map(([name, mode]) => ({
    name, role: 'chair', command: process.execPath, shell: false, cwd: options.home,
    args: [join(repoRoot, 'test/fixtures/nudge-tui.mjs'), mode,
      join(options.home, name + '.input'), join(options.home, name + '.read')],
    ...(mode === 'shell' ? {} : { agent: 'claude' }),
  }));
  const { launcher, problems } = parseLauncher({ profiles }, new Set(['claude']));
  if (problems.length) throw new Error(problems.join('\n'));
  const td: TestDaemon = await startTestDaemon({ ...options, launchProfiles: launcher,
    dashboardSessionFactory: session => td.daemon['manager'].create({ ...session, cols: 120, rows: 34 }),
  });
  const tokens = td.daemon['tokens'];
  const cookie = 'sp_dash=' + tokens.redeemDashboardGrant(tokens.mintDashboardGrant())!.token;
  const headers = { cookie, origin: 'http://127.0.0.1:' + String(td.port), 'x-shellpuppet-csrf': tokens.issueDashboardProof()!,
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
  return { ...td, launch: (name: string) => api(td.port, null, '/dashboard/launch', { headers, body: { profile: name } }) };
}
