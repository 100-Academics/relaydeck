import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
export function clientGuiUrl(server, deviceId, ticket) {
  const url = new URL('/', server);
  url.searchParams.set('device', deviceId);
  if (ticket) url.hash = new URLSearchParams({ ticket }).toString();
  return url.href;
}
export function options(extra = {}) {
  return parseArgs({ options: { gui: { type: 'boolean', default: false }, headless: { type: 'boolean', default: false }, ...extra } }).values;
}
export function openBrowser(url) {
  const program = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.error(`Open ${url} in your browser.`)); child.unref();
}
