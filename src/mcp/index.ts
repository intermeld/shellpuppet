/**
 * MCP adapter entry: a stdio MCP server that is a thin client to the shared
 * daemon (design §2.1: it must never own PTYs itself).
 *
 * stdout belongs ENTIRELY to the MCP protocol. Nothing on this code path may
 * print to it: diagnostics go to stderr, which MCP clients capture as logs.
 * Importing this module starts the server; the CLI's `mcp` verb does exactly
 * that.
 */

import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readMcpConfig } from './config.js';
import { isEnvNamesProblem, readDaemonConfig } from '../daemon/config.js';
import { registerTools } from './tools.js';
import type { PassLists } from './tools.js';
import { assertNodeVersion, packageVersion } from '../daemon/meta.js';
import { shellpuppetHome } from '../daemon/paths.js';
import { discoverDaemon, request } from '../client/http.js';
import { claudeSessionFile, watchClaudeResumeId } from '../agents/claude/liveResumeId.js';
import type { Logger } from '../core/types.js';

const stderrLogger: Logger = {
  debug: () => undefined,
  info: (message, meta) => console.error(`shellpuppet-mcp: ${message}`, meta ?? ''),
  warn: (message, meta) => console.error(`shellpuppet-mcp warning: ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`shellpuppet-mcp error: ${message}`, meta ?? ''),
};

async function main(): Promise<void> {
  assertNodeVersion();
  const server = new McpServer(
    { name: 'shellpuppet', version: packageVersion() },
    {
      instructions:
        'Important: A session whose model is a Claude model should ALWAYS pass hideReasoning: true ' +
        'on every call that reads a screen: terminal_snapshot, terminal_wait, terminal_find, ' +
        'terminal_screenshot, terminal_list, and use --hide-reasoning with their CLI equivalents. ' +
        'Claude models\' safety checks can flag another model\'s reasoning read off a screen as an ' +
        'attempt to extract reasoning and stop the session. Leaving the reasoning out avoids that; ' +
        'terminal_result gives the agent\'s answer. With the flag, a Claude model can use every ' +
        'ShellPuppet tool freely. Other models can leave the flag off when they need the full screen.',
    },
  );
  const home = shellpuppetHome();
  const config = readMcpConfig(home, stderrLogger);
  // The variable lists are read afresh at every terminal_start, so a change
  // to config applies to the next session with no restart. The lists are the
  // daemon's to parse; their problems are reported once each.
  const reported = new Set<string>();
  const reportOnce = (problem: string): void => {
    if (reported.has(problem)) return;
    reported.add(problem);
    stderrLogger.warn(problem);
  };
  const readPassLists = (): PassLists => {
    const parsed = readDaemonConfig(home);
    for (const problem of parsed.problems) {
      if (problem.startsWith('agents') || isEnvNamesProblem(problem)) reportOnce(problem);
    }
    return {
      envNames: parsed.config.envNames ?? [],
      agentPassEnv: parsed.config.agentPassEnv ?? {},
      agentSignatures: parsed.config.agentSignatures ?? [],
    };
  };
  readPassLists();
  // Messaging tools are offered only when messaging is switched on when this
  // server starts; a change to config.json applies at the next MCP start.
  const messaging = readDaemonConfig(home).config.messaging?.enabled === true;
  const releaseClaim = registerTools(server, {
    logger: stderrLogger,
    messaging,
    untrustedFraming: config.untrustedFraming,
    readPassLists,
    // Audit actor (design §4.5): identify the calling MCP client (Claude
    // Code, Qoder, Cursor…) from the initialize handshake. Resolved per call,
    // because clientInfo does not exist until after the handshake completes.
    actor: () => {
      const info = server.server.getClientVersion();
      return info !== undefined ? `mcp:${info.name}` : 'mcp';
    },
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const stopResumeWatch = process.env['SHELLPUPPET_PROFILE_AGENT'] === 'claude' &&
    process.env['SHELLPUPPET_SESSION'] && process.env['SHELLPUPPET_SESSION_TOKEN'] &&
    process.env['SHELLPUPPET_DAEMON_INSTANCE']
    ? watchClaudeResumeId(claudeSessionFile(process.env, process.cwd()), async id => {
      const connection = await discoverDaemon({ home });
      if (!connection || connection.instanceId !== process.env['SHELLPUPPET_DAEMON_INSTANCE']) {
        throw new Error('The parent session daemon is unavailable.');
      }
      const response = await request(connection, 'GET', '/sessions', undefined,
        { home, autoStart: false, observedResumeId: id });
      if (response.status !== 200 || response.recordedResumeId !== id) {
        throw new Error('The parent session did not record the conversation id.');
      }
    }) : undefined;
  const previousClose = transport.onclose;
  transport.onclose = () => {
    previousClose?.();
    stopResumeWatch?.();
    void releaseClaim();
  };
}

main().catch((error: unknown) => {
  console.error(
    `shellpuppet-mcp failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
