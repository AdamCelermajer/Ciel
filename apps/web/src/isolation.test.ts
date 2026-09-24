import { describe, expect, it } from 'vitest';
import type { Task, TaskDetail } from '@ciel/contracts';
import { HostScope, isUnread, notificationKey, visibleAttentionSeq } from './isolation';

const task = (attentionSeq: number, lastReadSeq: number) => ({ id: 'same-id', attentionSeq, lastReadSeq }) as Task;
const detail = (seqs: number[]) => ({ task: task(0, 0), events: seqs.map(seq => ({ seq })) }) as TaskDetail;

describe('host isolation', () => {
  it('invalidates old reads before the new host can render and captures command destinations', async () => {
    const scope = new HostScope();
    const oldSelection = scope.switchTo('host-a');
    const submittedDestination = oldSelection.hostId;
    let resolveOld!: (value: string) => void;
    const lateRead = new Promise<string>(resolve => { resolveOld = resolve; });
    const nextSelection = scope.switchTo('host-b');
    resolveOld('old host data');
    expect(await lateRead).toBe('old host data');
    expect(oldSelection.controller.signal.aborted).toBe(true);
    expect(scope.isCurrent(oldSelection)).toBe(false);
    expect(scope.isCurrent(nextSelection)).toBe(true);
    expect(submittedDestination).toBe('host-a');
  });

  it('keeps completion unread until the result-bearing detail has been displayed', () => {
    expect(isUnread(task(9, 8))).toBe(true);
    expect(visibleAttentionSeq(task(9, 8), detail([8]))).toBeNull();
    expect(visibleAttentionSeq(task(9, 8), detail([8, 9]))).toBe(9);
    expect(visibleAttentionSeq(task(9, 9), detail([9]))).toBeNull();
    expect(visibleAttentionSeq(task(0, 0), detail([]))).toBeNull();
  });

  it('deduplicates notifications by host and event', () => {
    const event = { seq: 7, runId: 'run', type: 'run.completed' };
    expect(notificationKey('a', event)).not.toBe(notificationKey('b', event));
    expect(notificationKey('a', event)).toBe(notificationKey('a', event));
  });
});
