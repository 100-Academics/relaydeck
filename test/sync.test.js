import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { syncRepository, git } from '../src/sync.js';

test('Forgejo/Gitea sync configures a remote and safely pushes/pulls between checkouts', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-sync-'));
  const fakeForge = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: '1.24.0' })); });
  await new Promise(resolve => fakeForge.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => fakeForge.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const remote = path.join(root, 'remote.git'), a = path.join(root, 'a'), b = path.join(root, 'b');
  await git(root, ['init', '--bare', remote]); await git(root, ['init', '-b', 'main', a]);
  await git(a, ['config', 'user.name', 'Relaydeck test']); await git(a, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(a, 'hello.txt'), 'first\n'); await git(a, ['add', '.']); await git(a, ['commit', '-m', 'Initial']);
  const url = `http://127.0.0.1:${fakeForge.address().port}/team/project.git`;
  await syncRepository(root, { cwd: a, action: 'configure', url });
  // Exercise real Git transport locally while the URL and version endpoint have
  // the same shape as a Forgejo/Gitea service. No external account is required.
  const localRemote = remote.replaceAll('\\', '/');
  await git(a, ['config', `url.${localRemote}.insteadOf`, url]);
  await syncRepository(root, { cwd: a, action: 'push' });
  await git(root, ['clone', '-b', 'main', remote, b]);
  await syncRepository(root, { cwd: b, action: 'configure', url });
  await git(b, ['config', `url.${localRemote}.insteadOf`, url]);
  await writeFile(path.join(a, 'hello.txt'), 'second\n');
  await assert.rejects(() => syncRepository(root, { cwd: a, action: 'push' }), /Commit or stash/);
  await git(a, ['add', '.']); await git(a, ['commit', '-m', 'Second']);
  await syncRepository(root, { cwd: a, action: 'push' });
  const pulled = await syncRepository(root, { cwd: b, action: 'pull' });
  assert.match(pulled.output, /Fast-forward|Updating/);
  assert.equal(await git(a, ['rev-parse', 'HEAD']), await git(b, ['rev-parse', 'HEAD']));
});
