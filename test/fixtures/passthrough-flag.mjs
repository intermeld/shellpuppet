// Stay alive so a CLI wait can observe the flag even on a slow CI runner.
process.stdout.write(`argument: ${process.argv[2] ?? '(missing)'}\r\n`);
setInterval(() => {}, 1_000);
