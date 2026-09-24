import { expect, test } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/codex.js';

const binary = process.env.CIEL_NATIVE_CODEX_TEST;
test.skipIf(!binary)('installed Codex App Server initializes and discovers models in an unsigned profile', async () => {
  const adapter = new CodexAdapter({ dataDir: await mkdtemp(join(tmpdir(), 'ciel-native-codex-')), binaries: { codex: binary } });
  try {
    const status = await adapter.status();
    expect(status.installed).toBe(true);
    expect(status.protocolHealthy).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.models.length).toBeGreaterThan(0);
    await adapter.dispose();
    expect((await adapter.status()).protocolHealthy).toBe(true);
  } finally { await adapter.dispose(); }
});
