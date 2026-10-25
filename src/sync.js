import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fail, str } from './store.js';

const exec = promisify(execFile);
export async function insideRoot(root, requested) {
  const base = await realpath(root);
  const target = await realpath(path.resolve(base, requested));
  const rel = path.relative(base, target);
  fail(rel === '' || !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel), 'Directory must stay inside the device workspace.');
  return target;
}
export async function git(cwd, args, { includeStderr = false } = {}) {
  const { stdout, stderr } = await exec('git', args, { cwd, windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return (stdout + (includeStderr ? stderr : '')).trim();
}
export function repositoryUrl(value) {
  const url = new URL(str(value, 'Forgejo/Gitea repository URL', 2000));
  fail(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Use an HTTP(S) repository URL without embedded credentials.');
  const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  fail(parts.length === 2 && parts.every(p => /^[\w.-]+$/.test(p)), 'Use a Forgejo/Gitea URL in the form https://host/owner/repo.git.');
  return { url: url.href, api: `${url.origin}/api/v1/version` };
}
export async function syncRepository(root, input) {
  const cwd = await insideRoot(root, input.cwd);
  fail(['status', 'configure', 'pull', 'push'].includes(input.action), 'Unknown sync action.');
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  await insideRoot(root, top);
  if (input.action === 'configure') {
    const repo = repositoryUrl(input.url);
    const response = await fetch(repo.api, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    fail(response.ok && typeof (await response.json()).version === 'string', 'The host did not respond as a Forgejo/Gitea service.');
    const remotes = (await git(cwd, ['remote'])).split(/\s+/);
    await git(cwd, ['remote', remotes.includes('relaydeck') ? 'set-url' : 'add', 'relaydeck', repo.url]);
    await git(cwd, ['config', 'relaydeck.provider', 'forgejo-gitea']);
    return { output: 'Forgejo/Gitea remote configured.', cwd };
  }
  const status = await git(cwd, ['status', '--short', '--branch']);
  if (input.action === 'status') {
    let remote = ''; try { remote = await git(cwd, ['config', '--get', 'remote.relaydeck.url']); } catch {}
    return { output: status || 'Working tree is clean.', remote, cwd };
  }
  fail(await git(cwd, ['config', '--get', 'relaydeck.provider']) === 'forgejo-gitea', 'Configure a Forgejo/Gitea remote first.');
  repositoryUrl(await git(cwd, ['config', '--get', 'remote.relaydeck.url']));
  fail(!(await git(cwd, ['status', '--porcelain'])), 'Commit or stash local changes before syncing.');
  const branch = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  fail(branch && !branch.startsWith('-'), 'Check out a branch before syncing.');
  const output = input.action === 'pull'
    ? await git(cwd, ['pull', '--ff-only', 'relaydeck', branch], { includeStderr: true })
    : await git(cwd, ['push', 'relaydeck', `HEAD:refs/heads/${branch}`], { includeStderr: true });
  return { output: output || 'Repository is up to date.', cwd };
}
