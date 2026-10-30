/**
 * The MCP adapter's `mcp` section (design §4.4): what a human writes there,
 * and what the adapter makes of it when it is missing or wrong.
 */

import { describe, expect, it } from 'vitest';
import { parseMcpConfig } from '../../src/mcp/config.js';

describe('the mcp section of config.json', () => {
  it('frames screen content when the section is absent', () => {
    expect(parseMcpConfig({})).toEqual({ untrustedFraming: true });
    expect(parseMcpConfig(null)).toEqual({ untrustedFraming: true });
  });

  it('turns framing off only for an explicit false', () => {
    expect(parseMcpConfig({ mcp: { untrustedFraming: false } }).untrustedFraming).toBe(false);
    expect(parseMcpConfig({ mcp: { untrustedFraming: 'no' } }).untrustedFraming).toBe(true);
  });
});
