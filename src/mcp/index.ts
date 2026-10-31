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
    { instructions: 'Every tool that returns screen text accepts hideReasoning. If your model\'s safety checks flag reasoning read off another model\'s screen (Claude models at present), pass hideReasoning: true on every such call. Leave it off when you need the full screen.' },
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
  registerTools(server, {
    logger: stderrLogger,
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
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(
    `shellpuppet-mcp failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
