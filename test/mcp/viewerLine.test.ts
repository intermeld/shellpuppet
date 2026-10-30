/**
 * What `terminal_start` tells the agent about the human's way in (design
 * §3.1): a window the daemon opened needs no link, and none is given; when
 * nothing opened, the one-use URL is the way in and has to reach the human.
 */

import { describe, expect, it } from 'vitest';
import { viewerLine } from '../../src/mcp/tools.js';

const url = 'http://127.0.0.1:1/view?s=s1&vt=0123abcd';

describe('viewerLine', () => {
  it('names the window and carries no link when one opened', () => {
    const line = viewerLine({ viewer: { opened: true, mode: 'isolated-app' } });
    expect(line).toContain('a window has opened on this machine');
    expect(line).toContain('terminal_viewer_url');
    expect(line).not.toContain('http');
  });

  it('never repeats a link the daemon sent beside an opened window', () => {
    // The daemon sends no URL when a window opened; if one ever arrived, the
    // window still holds the grant and the agent still has nothing to paste.
    const line = viewerLine({ viewer: { opened: true, mode: 'isolated-app' }, viewerUrl: url });
    expect(line).not.toContain('vt=');
  });

  it('says why the default browser was used, beside the window', () => {
    const line = viewerLine({
      viewer: { opened: true, mode: 'isolated-app', reason: 'fell back: no Chromium-family browser found' },
    });
    expect(line).toContain('a window has opened on this machine');
    expect(line).toContain('fell back: no Chromium-family browser found');
    expect(line).toContain('They need no link');
    expect(line).not.toContain('http');
  });

  it('gives the URL and says why nothing opened', () => {
    const line = viewerLine({
      viewer: { opened: false, mode: 'none', reason: 'viewer.launchMode is "none"' },
      viewerUrl: url,
    });
    expect(line).toContain('No viewer window opened (viewer.launchMode is "none").');
    expect(line).toContain('Viewer URL for the human');
    expect(line.endsWith(url)).toBe(true);
  });

  it('gives the URL when the daemon says nothing about a window', () => {
    const line = viewerLine({ viewerUrl: url });
    expect(line).toContain('No viewer window opened.');
    expect(line.endsWith(url)).toBe(true);
  });
});
