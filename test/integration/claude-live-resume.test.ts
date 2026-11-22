import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { api, eventually, makeTempHome, startTestDaemon } from './helpers.js';

it('saves the switched conversation reported by a direct Claude MCP child in ten runs', async () => {
  for (let run = 0; run < 10; run++) {
    const home = makeTempHome();
    const configDir = join(home, 'claude-config');
    mkdirSync(join(configDir, 'sessions'), { recursive: true });
    const parent = join(home, 'fake-claude.cjs');
    writeFileSync(parent, `
      const fs = require('node:fs');
      const path = require('node:path');
      const { spawn } = require('node:child_process');
      const record = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions', process.pid + '.json');
      const switchFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'switch');
      fs.writeFileSync(record, JSON.stringify({sessionId:'initial-${run}'}));
      const mcp = spawn(process.execPath, [process.env.SHELLPUPPET_CLI, 'mcp'],
        { env: process.env, stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setInterval(() => {
        if (fs.existsSync(switchFile)) {
          fs.writeFileSync(record, JSON.stringify({sessionId:'switched-${run}'}));
          clearInterval(timer);
        }
      }, 25);
      process.on('exit', () => mcp.kill());
      setInterval(() => {}, 1000);
    `);
    const config = parseDaemonConfig({ launcher: { sessionLaunch: ['chair'], profiles: [
      { name: 'worker', command: process.execPath, args: [parent], shell: false, cwd: home,
        agent: 'claude', envFromDaemon: ['CLAUDE_CONFIG_DIR'], resume: ['--resume', '{id}'] },
    ] } }).config;
    const td = await startTestDaemon({ home, launchProfiles: config.launcher,
      daemonEnv: { CLAUDE_CONFIG_DIR: configDir }, messaging: { enabled: true, allow: [] } });
    try {
      const claim = (await api(td.port, td.token, '/messages/claims', { body: { name: 'chair' } })).body;
      const headers = { 'x-shellpuppet-claim': String(claim['claimId']),
        'x-shellpuppet-claim-secret': String(claim['secret']) };
      expect((await api(td.port, td.token, '/launcher/launch', { headers,
        body: { profile: 'worker', resumeId: 'launch' } })).status).toBe(200);
      const current = () => td.daemon['manager'].liveProfileSessions()[0]?.resumeId;
      await eventually(() => current() === `initial-${run}`, 30_000);
      writeFileSync(join(configDir, 'switch'), '1');
      await eventually(() => current() === `switched-${run}`, 30_000);
      expect((await api(td.port, td.token, '/daemon/shutdown',
        { body: { restart: true, force: true } })).status).toBe(200);
      const saved = JSON.parse(readFileSync(join(home, 'previous-sessions.json'), 'utf8')) as {
        sessions: { resumeId: string }[];
      };
      expect(saved.sessions[0]?.resumeId).toBe(`switched-${run}`);
    } finally { await td.stop(); }
  }
}, 300_000);
