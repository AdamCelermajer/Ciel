import type { Task, TaskDetail } from '@ciel/contracts';

/** Captures the destination of every read and command before asynchronous work starts. */
export class HostScope {
  private generation = 0;
  private active: { hostId: string; generation: number; controller: AbortController } | null = null;

  switchTo(hostId: string) {
    this.active?.controller.abort();
    const selection = { hostId, generation: ++this.generation, controller: new AbortController() };
    this.active = selection;
    return selection;
  }

  clear() {
    this.active?.controller.abort();
    this.active = null;
    this.generation++;
  }

  capture() { return this.active; }
  isCurrent(selection: ReturnType<HostScope['capture']>) {
    return selection !== null && this.active === selection && !selection.controller.signal.aborted;
  }
}

export function isUnread(task: Task): boolean {
  return task.attentionSeq > task.lastReadSeq;
}

/** Detail must contain the attention event before its completion can be acknowledged. */
export function visibleAttentionSeq(task: Task, detail: TaskDetail | null): number | null {
  if (!detail || detail.task.id !== task.id || !isUnread(task)) return null;
  const seq = task.attentionSeq;
  return detail.events.some(event => event.seq >= seq) ? seq : null;
}

export function notificationKey(hostId: string, event: { seq: number; runId?: string; type: string }) {
  return `${hostId}:${event.runId || ''}:${event.seq}:${event.type}`;
}
