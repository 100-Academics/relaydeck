// One native terminal per worker keeps ConPTY resource lifetimes isolated from
// the device runner. A terminal crash cannot take other harnesses offline.
import * as pty from 'node-pty';
let terminal, exiting = false;
const send = message => { if (process.connected) process.send(message); };
function finish(code = 0) {
  if (exiting) return;
  exiting = true; send({ type: 'exit', exitCode: code });
  // Let the final IPC output flush, then release native pipe/worker handles.
  setTimeout(() => process.exit(0), 80);
}
process.on('message', message => {
  try {
    if (message.type === 'start' && !terminal) {
      const { command, args, cwd } = message;
      terminal = pty.spawn(command, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: process.env, useConptyDll: process.platform === 'win32' });
      terminal.onData(data => send({ type: 'output', data }));
      terminal.onExit(({ exitCode }) => finish(exitCode));
      send({ type: 'ready' });
    } else if (message.type === 'input') terminal?.write(message.data);
    else if (message.type === 'resize') terminal?.resize(message.cols, message.rows);
    else if (message.type === 'stop') { terminal?.kill(); setTimeout(() => finish(1), 4000).unref(); }
  } catch (error) { send({ type: 'error', error: error.message }); if (!terminal) finish(1); }
});
process.on('disconnect', () => { try { terminal?.kill(); } catch {} setTimeout(() => process.exit(0), 1000); });
