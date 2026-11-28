import { beforeAll, expect, it } from 'vitest';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { eventually } from './helpers.js';
import { observeNotices, withNoticePage } from './noticePage.js';

let browser: string | null;
beforeAll(async () => { browser = await findBrowser(); });

// Hold the initial parser queue until the browser has received the prompt replay.
const holdSnapshot = `(() => {
  const save = terminals.set.bind(terminals);
  terminals.set = (id, term) => {
    const write = term.write.bind(term), pending = [];
    term.write = (bytes, done) => pending.push([bytes, done]);
    window.releaseSnapshot = () => {
      term.write = write;
      for (const [bytes, done] of pending) write(bytes, done);
    };
    return save(id, term);
  };
})()`;

it('recognises replayed waits, handles a missed clear, and restores a provider stall', async context => {
  if (!browser) { context.skip(); return; }
  const result = await withNoticePage(browser, 'viewer', async ({ evaluate }, ids, input, listSessions) => {
    await evaluate(`window.id = ${JSON.stringify(ids[0])}; void Object.assign(window, parts(id))`);
    const beforeParse = await evaluate("!alert.hidden && alert.textContent.includes('Allow once') && alert.getBoundingClientRect().top === stack.parentElement.getBoundingClientRect().top + stack.clientTop");
    await evaluate('releaseSnapshot(); button.click(); window.firstSince = socket.prompt.since; socket.close()');
    await eventually(async () => await evaluate('streams.get(id) !== socket && streams.get(id)?.prompt?.since === firstSince') === true);
    const same = await evaluate("button.getAttribute('aria-expanded') === 'false' && alert.hidden");
    // Close the socket and hold the normal retry until the daemon has replaced the prompt.
    await evaluate(`window.oldSocket = streams.get(id);
      button.click();
      button.focus();
      window.oldQuestion = oldSocket.prompt.question;
      window.afterNoticeOpen = (_, next) => {
        window.atReopen = { headingHidden: button.hidden, detailsHidden: alert.hidden,
          text: alert.textContent, replayReceived: !!next.prompt };
      };
      new Promise(resolve => {
        const onClose = oldSocket.onclose;
        oldSocket.onclose = event => {
          window.resumeReconnect = () => onClose.call(oldSocket, event);
          resolve(true);
        };
        oldSocket.close();
      })`);
    const waiting = async () => (await listSessions()).find(session => session.id === ids[0])?.waitingOnPrompt;
    await input('c');
    await eventually(async () => (await waiting()) === undefined, 15_000, 50, 'daemon clear while offline');
    await input('n');
    await eventually(async () => {
      const prompt = await waiting();
      return prompt?.alerted === true && prompt.question.includes('Replace this file?');
    }, 15_000, 50, 'daemon replacement while offline');
    const staleBeforeReopen = await evaluate(`({ offline: oldSocket.readyState === WebSocket.CLOSED,
      expanded: !button.hidden && !alert.hidden, question: alert.querySelector('.question')?.textContent === oldQuestion })`);
    await evaluate('resumeReconnect()');
    await eventually(async () => await evaluate('streams.get(id) !== oldSocket && streams.get(id)?.prompt?.since > firstSince && !alert.hidden') === true);
    await eventually(async () => await evaluate("term.buffer.active.getLine(1)?.translateToString().includes('Replace this file?')") === true);
    const replaced = await evaluate("button.getAttribute('aria-expanded') === 'true' && alert.textContent.includes('Replace this file?') && document.activeElement !== button");
    const fallback = await evaluate(`(() => {
      const control = frame => streams.get(id).dispatchEvent(new MessageEvent('message', {data:JSON.stringify(frame)}));
      const copy = document.getElementById('copy-notice');
      copy.hidden = false;
      control({type:'session-stalled', stalled:{reason:'provider-error', since:'09:30', description:'Synthetic provider stall'}});
      button.click();
      const independent = !copy.hidden && copy.getAttribute('role') === 'status' && alert.hidden;
      control({type:'prompt-clear'});
      return independent && button.hidden && !alert.hidden && alert.textContent.includes('Synthetic provider stall');
    })()`);
    return { beforeParse, same, staleBeforeReopen, atReopen: await evaluate('window.atReopen'), replaced, fallback };
  }, { before: holdSnapshot });
  expect(result).toEqual({ beforeParse: true, same: true, staleBeforeReopen: { offline: true, expanded: true, question: true },
    atReopen: { headingHidden: true, detailsHidden: true, text: '', replayReceived: false }, replaced: true, fallback: true });
}, 230_000);

it.for(['viewer', 'dashboard'])('%s avoids layout reads during output and after disposal with a pending snapshot', { timeout: 230_000 }, async (mode, context) => {
  if (!browser) { context.skip(); return; }
  const result = await withNoticePage(browser, mode, async ({ evaluate }, ids) => {
    await evaluate(`window.id = ${JSON.stringify(ids[0])}; void Object.assign(window, parts(id))`);
    const burst = await evaluate(`(async () => {
      const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await document.fonts.ready;
      await new Promise(resolve => term.write('', resolve));
      await paint();
      window.layoutReads = 0;
      for (const el of [term.element.querySelector('.xterm-screen'), term.element.closest('#wrap, .pane-wrap'), stack, alert]) {
        const rect = el.getBoundingClientRect.bind(el);
        el.getBoundingClientRect = () => { layoutReads++; return rect(); };
      }
      for (const prop of ['clientHeight', 'scrollHeight']) {
        Object.defineProperty(stack, prop, { get() { layoutReads++; return Reflect.get(Element.prototype, prop, this); } });
      }
      for (let chunk = 0; chunk < 8; chunk++) {
        const bytes = new TextEncoder().encode('\\x1b[' + (chunk + 5) + ';1HOutput ' + chunk);
        socket.dispatchEvent(new MessageEvent('message', { data: bytes.buffer }));
        await new Promise(resolve => term.write('', resolve));
        await paint();
      }
      return { reads: layoutReads, last: term.buffer.active.getLine(11).translateToString(true), visible: !alert.hidden };
    })()`);
    // Keep the real reconnect snapshot's parse callback pending across destroy().
    await evaluate(`window.afterNoticeOpen = () => {
      const write = term.write.bind(term);
      term.write = (bytes, done) => {
        if (!(bytes instanceof Uint8Array)) return write(bytes, done);
        term.write = write;
        write(bytes, () => { window.finishSnapshot = done; });
      };
    }; socket.close()`);
    await eventually(async () => await evaluate("typeof window.finishSnapshot === 'function' && !!streams.get(id)?.prompt && !alert.hidden") === true);
    const disposed = await evaluate(`(async () => {
      paneClients.get(id).destroy();
      const before = stack.style.cssText, reads = layoutReads;
      finishSnapshot();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { reads: layoutReads - reads, sameStyle: before === stack.style.cssText };
    })()`);
    return { burst, disposed };
  });
  expect(result).toEqual({ burst: { reads: 0, last: 'Output 7', visible: true }, disposed: { reads: 0, sameStyle: true } });
});

for (const rows of [24, 150]) for (const ended of [false, true]) {
  it(`places the ${ended ? 'ended' : 'live'} pane on Pop out and reattachment at 80x${String(rows)}`, async context => {
    if (!browser) { context.skip(); return; }
    const result = await withNoticePage(browser, 'dashboard', async ({ evaluate, send }, ids, input) => {
      const id = JSON.stringify(ids[0]);
      await evaluate(`window.original = streams.get(${id}); parts(${id}).button.click()`);
      if (ended) {
        await input('q');
        await eventually(async () => await evaluate(`parts(${id}).root.classList.contains('ended') && parts(${id}).button.hidden`) === true);
      }
      await evaluate(`parts(${id}).root.querySelector('[data-action=pop]').click()`);
      const url = await evaluate('window.openedURL');
      const { targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow: true }, true) as { targetId: string };
      const ready = `terminals.has(${id}) && parts(${id}).term.rows === ${String(rows)} &&
        parts(${id}).term.buffer.active.getLine(0)?.translateToString().includes('Permission Required') &&
        ${ended ? `parts(${id}).root.classList.contains('ended')` : `!!streams.get(${id})?.prompt`}`;
      const read = `(() => {
        const {button, alert, stack} = parts(${id});
        return {headingHidden:button.hidden, detailsHidden:alert.hidden, hasOptions:alert.textContent.includes('Allow once'),
          top:Math.abs(stack.getBoundingClientRect().top - stack.parentElement.getBoundingClientRect().top) <= 1};
      })()`;
      let popup;
      try {
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, true) as { sessionId: string };
        await send('Page.enable', {}, sessionId);
        await send('Page.addScriptToEvaluateOnNewDocument', { source: observeNotices }, sessionId);
        await send('Page.navigate', { url }, sessionId);
        const inspect = async (expression: string) => {
          const reply = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId) as { result: { value?: unknown } };
          return reply.result.value;
        };
        await eventually(async () => await inspect(ready) === true, 30_000, 50, 'parsed Pop out snapshot');
        popup = await inspect(read);
      } finally { await send('Target.closeTarget', { targetId }, true); }
      await eventually(async () => await evaluate(`original !== streams.get(${id}) && (${ready})`) === true,
        30_000, 50, 'parsed reattached snapshot');
      return { popup, returned: await evaluate(read) };
    }, { rows, before: 'window.open = url => { window.openedURL = url; return {closed:false}; }' });
    expect(result).toMatchObject({ popup: { top: true, headingHidden: ended, detailsHidden: ended, hasOptions: !ended },
      returned: { top: true, headingHidden: ended, detailsHidden: true } });
  }, 230_000);
}
