// Anchor each hold to the browser's observed row. Its immediate acknowledgement
// travels during the hold instead of adding a round trip to every phase.
export function phaseDriver() {
  let phases = [], index = 0, active = false, serial = 0, awaiting = false, pending = '';
  let timer;
  const emit = () => {
    const [render, duration, row] = phases[index];
    const bytes = typeof render === 'function' ? render() : render;
    awaiting = true;
    process.stdout.write(bytes + '\x1b]777;' + (++serial) + ':' + duration + ':' + row + '\x07');
  };
  const acknowledge = (id, parsedAt) => {
    if (!active || !awaiting || id !== serial || !Number.isFinite(parsedAt)) return;
    awaiting = false;
    timer = setTimeout(() => {
      if (!active || id !== serial) return;
      index = (index + 1) % phases.length;
      emit();
    }, Math.max(0, parsedAt + phases[index][1] - Date.now()));
  };
  return {
    start(next) { clearTimeout(timer); phases = next; index = 0; active = true; emit(); },
    stop() { active = false; clearTimeout(timer); },
    read(bytes) {
      pending += bytes.toString();
      let commands = '';
      while (pending.length) {
        if (pending[0] !== 'a') { commands += pending[0]; pending = pending.slice(1); continue; }
        const end = pending.indexOf(';');
        if (end < 0) break;
        const [id, parsedAt] = pending.slice(1, end).split(':').map(Number);
        pending = pending.slice(end + 1);
        acknowledge(id, parsedAt);
      }
      return commands;
    },
  };
}
