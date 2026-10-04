import { join } from 'node:path';
import { fsArtifactStore, type ArtifactStore } from '../artifacts/store.js';
import { settings, type Settings } from '../config/settings.js';
import { createDb, type Db } from '../db/pool.js';
import { loadSecretKey } from '../security/secrets.js';

export interface AppContext {
  settings: Settings;
  db: Db;
  pool: Db['$client'];
  artifacts: ArtifactStore;
  secretKey: Buffer;
}

export function createContext(overrides: Partial<Settings> = {}): AppContext {
  const s = { ...settings(), ...overrides };
  const db = createDb(s.databaseUrl);
  return {
    settings: s,
    db,
    pool: db.$client,
    artifacts: fsArtifactStore(s.artifactDir),
    secretKey: loadSecretKey(s.secretKey, join(s.dataDir, 'secret.key')),
  };
}
