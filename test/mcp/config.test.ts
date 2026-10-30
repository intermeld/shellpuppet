/**
 * The MCP adapter's `mcp` section (design §4.4, §4.6): what a human writes
 * there, and what the adapter makes of it when it is missing or wrong.
 */

import { describe, expect, it } from 'vitest';
import { parseMcpConfig } from '../../src/mcp/config.js';
import type { Logger } from '../../src/core/types.js';

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => void warnings.push(message),
    error: () => undefined,
  };
  return { logger, warnings };
}

describe('the mcp section of config.json', () => {
  it('passes no variables and frames screen content when the section is absent', () => {
    const { logger, warnings } = recordingLogger();
    expect(parseMcpConfig({}, logger)).toEqual({ untrustedFraming: true, passEnv: [] });
    expect(parseMcpConfig(null, logger)).toEqual({ untrustedFraming: true, passEnv: [] });
    expect(warnings).toEqual([]);
  });

  it('reads the variables the human allows to be passed', () => {
    const { logger } = recordingLogger();
    expect(parseMcpConfig({ mcp: { passEnv: ['OPENCODE_API_KEY', 'OTHER_KEY'] } }, logger).passEnv).toEqual([
      'OPENCODE_API_KEY',
      'OTHER_KEY',
    ]);
  });

  it('drops entries that are not variable names, and says so', () => {
    const { logger, warnings } = recordingLogger();
    const config = parseMcpConfig({ mcp: { passEnv: ['GOOD_KEY', 'BAD-KEY', 7, '', '__proto__'] } }, logger);
    expect(config.passEnv).toEqual(['GOOD_KEY']);
    expect(warnings).toHaveLength(1);
  });

  it('passes nothing when passEnv is not a list, and says so', () => {
    const { logger, warnings } = recordingLogger();
    expect(parseMcpConfig({ mcp: { passEnv: 'OPENCODE_API_KEY' } }, logger).passEnv).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('turns framing off only for an explicit false', () => {
    const { logger } = recordingLogger();
    expect(parseMcpConfig({ mcp: { untrustedFraming: false } }, logger).untrustedFraming).toBe(false);
    expect(parseMcpConfig({ mcp: { untrustedFraming: 'no' } }, logger).untrustedFraming).toBe(true);
  });
});
