import { expect, test } from 'vitest';
import type { AdapterEvent, EngineRunInput } from '@ciel/contracts';
import { OpenCodeAdapter } from '../src/opencode.js';

test('OpenCode streams only assistant text and emits one lifecycle for repeated tool states', async () => {
  const events: AdapterEvent[] = [];
  const input: EngineRunInput = {
    taskId: 'task', runId: 'run', cwd: '/tmp', prompt: 'Inspect', permission: 'ask',
    signal: new AbortController().signal, emit: event => events.push(event),
  };
  const toolPart = (id: string, status: string) => ({ id, sessionID: 'session', messageID: 'assistant-1',
    type: 'tool', callID: `call-${id}`, tool: 'mcp__filesystem__read_file',
    state: status === 'running' ? { status, input: { path: 'a.txt' }, time: { start: 1 } }
      : { status, input: { path: 'a.txt' }, output: 'content', title: 'Read file', metadata: {}, time: { start: 1, end: 2 } } });
  const toolEvent = (id: string, status: string) => ({ type: 'message.part.updated',
    properties: { sessionID: 'session', part: toolPart(id, status), time: 1 } });
  const native = [
    { type: 'message.part.delta', properties: { sessionID: 'session', messageID: 'user-1', partID: 'part-user', field: 'text', delta: 'Inspect' } },
    { type: 'message.updated', properties: { sessionID: 'session', info: { id: 'user-1', role: 'user' } } },
    { type: 'message.part.delta', properties: { sessionID: 'session', messageID: 'assistant-1', partID: 'part-text', field: 'text', delta: 'Done' } },
    { type: 'message.updated', properties: { sessionID: 'session', info: { id: 'assistant-1', role: 'assistant' } } },
    { type: 'message.part.delta', properties: { sessionID: 'session', messageID: 'assistant-1', partID: 'part-text', field: 'text', delta: '.' } },
    toolEvent('part-tool', 'running'), toolEvent('part-tool', 'running'),
    toolEvent('part-tool', 'completed'), toolEvent('part-tool', 'completed'),
    // Older or transformed event payloads may omit the outer sessionID.
    { type: 'message.part.updated', properties: { part: toolPart('part-nested', 'running'), time: 1 } },
    { type: 'message.part.updated', properties: { part: toolPart('part-nested', 'completed'), time: 2 } },
    { type: 'session.idle', properties: { sessionID: 'session' } },
  ];
  const response = new Response(native.map((event, index) => `data: ${JSON.stringify({ id: `evt_${index}`, ...event })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const adapter = new OpenCodeAdapter({ dataDir: '/tmp/ciel-opencode-event-test' });
  const stream = (adapter as unknown as { stream: (response: Response, server: never, sessionId: string, input: EngineRunInput) => Promise<void> }).stream.bind(adapter);
  await stream(response, undefined as never, 'session', input);
  expect(events.filter(event => event.type === 'text.delta').map(event => event.text).join('')).toBe('Done.');
  expect(events.filter(event => event.type === 'tool.started').map(event => [event.id, event.name])).toEqual([
    ['part-tool', 'mcp__filesystem__read_file'], ['part-nested', 'mcp__filesystem__read_file'],
  ]);
  expect(events.filter(event => event.type === 'tool.completed').map(event => event.id)).toEqual(['part-tool', 'part-nested']);
});
