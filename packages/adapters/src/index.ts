import type { AdapterOptions, EngineAdapter, EngineId } from '@ciel/contracts';
import { CodexAdapter } from './codex.js';
import { ClaudeAdapter } from './claude.js';
import { OpenCodeAdapter } from './opencode.js';

export function createAdapters(options: AdapterOptions): Record<EngineId, EngineAdapter> {
  return {
    codex: new CodexAdapter(options),
    claude: new ClaudeAdapter(options),
    opencode: new OpenCodeAdapter(options),
  };
}
