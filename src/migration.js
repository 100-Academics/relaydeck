import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';

// Preserve existing workspace identities and history when adopting the new name.
// SQLite's backup API includes committed WAL data and leaves the source intact.
export async function migrateWorkspace(directory, legacyDirectory) {
  const destination = path.join(directory, 'relaydeck.sqlite');
  const source = path.join(legacyDirectory, 'amoeba.sqlite');
  if (existsSync(destination) || !existsSync(source)) return false;
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, destination); } finally { db.close(); }
  const oldKey = path.join(legacyDirectory, 'local-device.key');
  const newKey = path.join(directory, 'local-device.key');
  if (existsSync(oldKey) && !existsSync(newKey)) copyFileSync(oldKey, newKey);
  return true;
}
