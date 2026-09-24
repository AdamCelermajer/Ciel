import { describe, expect, it } from 'vitest';
import type { EngineId, HostEvent, Run } from '@ciel/contracts';
import { activityForRun } from './activity';

const run: Run = { id: 'current', hostId: 'h', taskId: 't', engine: 'codex', status: 'completed', permission: 'ask', prompt: 'Search', commandId: 'once', createdAt: '2026-09-23T12:00:00Z', finishedAt: '2026-09-23T12:00:10Z' };
const event = (seq: number, type: string, data: Record<string, unknown>, runId = run.id): HostEvent => ({ seq, type, data, runId, hostId: 'h', taskId: 't', createdAt: `2026-09-23T12:00:0${seq}Z` });

describe('readable turn activity', () => {
  it('filters existing bookkeeping and other turns, pairing repeated tool events into one result', () => {
    const events = [
      event(1, 'task.read', { seq: 1 }),
      event(2, 'tool.started', { id: 'message', name: 'userMessage', input: '{}' }),
      event(3, 'tool.completed', { id: 'message', success: true, output: 'A prompt' }),
      event(4, 'tool.started', { id: 'same-native-id', name: 'webSearch', input: '{"action":{"query":"Malus domestica"}}' }),
      event(5, 'tool.started', { id: 'same-native-id', name: 'webSearch', input: '{"action":{"query":"Malus domestica"}}' }),
      event(6, 'tool.completed', { id: 'same-native-id', success: true, output: 'Wikipedia result' }),
      event(7, 'tool.started', { id: 'same-native-id', name: 'commandExecution', input: 'pwd' }, 'older-turn'),
      event(8, 'changes.captured', { files: 0 }),
    ];
    const [item, ...rest] = activityForRun(events, run);
    expect(rest).toHaveLength(0);
    expect(item).toMatchObject({ label: 'Web search', nativeName: 'webSearch', engine: 'codex', status: 'completed', output: 'Wikipedia result', startedAt: events[3]!.createdAt, finishedAt: events[5]!.createdAt });
    expect(item!.input).toContain('Malus domestica');
  });

  it.each<[EngineId, string]>([['codex', 'commandExecution'], ['claude', 'Bash'], ['opencode', 'bash']])('retains %s native tool names while using a shared action label', (engine, name) => {
    const items = activityForRun([event(1, 'tool.started', { id: 'cmd', name, input: 'pwd' }), event(2, 'tool.completed', { id: 'cmd', success: false, output: 'Permission denied' })], { ...run, engine });
    expect(items[0]).toMatchObject({ label: 'Run command', nativeName: name, engine, status: 'failed', output: 'Permission denied' });
  });

  it('recovers native MCP names in older Codex events and handles arbitrary names safely', () => {
    const items = activityForRun([
      event(1, 'tool.started', { id: 'mcp', name: 'mcpToolCall', input: JSON.stringify({ type: 'mcpToolCall', server: 'docs', tool: 'search', arguments: { query: 'PWA' } }) }),
      event(2, 'tool.completed', { id: 'mcp', success: true, output: 'Found documentation' }),
      event(3, 'tool.started', { id: 'odd', name: 'constructor', input: '{}' }),
      event(4, 'tool.completed', { id: 'unknown', success: true, output: 'Nameless result' }),
    ], run);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ label: 'Search', nativeName: 'docs/search', status: 'completed' });
    expect(items[0]!.input).toContain('PWA');
    expect(items[1]).toMatchObject({ label: 'Constructor', status: 'stopped' });
  });

  it('shows unresolved input and real failures without leaving stopped work spinning', () => {
    const events = [event(1, 'tool.started', { id: 'cmd', name: 'Bash', input: 'pwd' }), event(2, 'approval.requested', { id: 'approval', title: 'Approve command', description: 'Allow pwd?' })];
    expect(activityForRun(events, { ...run, status: 'waiting' }).map(item => item.status)).toEqual(['running', 'attention']);
    const interrupted = activityForRun(events, { ...run, status: 'interrupted', error: 'Host restarted' });
    expect(interrupted.map(item => item.status)).toEqual(['stopped', 'stopped', 'failed']);
    expect(interrupted[2]!.description).toBe('Host restarted');
    expect(activityForRun([...events, event(3, 'approval.resolved', { id: 'approval', decision: 'accept' })], run)[1]).toMatchObject({ status: 'completed', output: 'accept' });
  });
});
