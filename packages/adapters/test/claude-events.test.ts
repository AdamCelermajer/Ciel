import { expect, test } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent } from '@ciel/contracts';
import { ClaudeAdapter } from '../src/claude.js';

test('Claude keeps native tool-use and result IDs without duplicating message snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ciel-claude-events-'));
  const binary = join(dir, 'claude-fake');
  await writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.test'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'})); process.exit(0); }
const send = value => console.log(JSON.stringify(value));
send({type:'system',session_id:'session-1'});
const assistant={type:'assistant',message:{content:[{type:'text',text:'Checking'},{type:'tool_use',id:'tool-1',name:'mcp__filesystem__read_file',input:{path:'a.txt'}}]}};
send(assistant);send(assistant);
const user={type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'content'}]}};
send(user);send(user);
send({type:'result',result:'Done'});
`, { mode: 0o755 });
  const adapter = new ClaudeAdapter({ dataDir: join(dir, 'data'), binaries: { claude: binary } });
  try {
    const events: AdapterEvent[] = [];
    const result = await adapter.run({ taskId: 'task', runId: 'run', cwd: dir, prompt: 'Inspect', permission: 'full-access',
      signal: new AbortController().signal, emit: event => events.push(event) });
    expect(result).toEqual({ sessionId: 'session-1', text: 'Done' });
    expect(events.filter(event => event.type === 'tool.started').map(event => [event.id, event.name])).toEqual([['tool-1', 'mcp__filesystem__read_file']]);
    expect(events.filter(event => event.type === 'tool.completed').map(event => event.id)).toEqual(['tool-1']);
  } finally { await adapter.dispose(); }
});
