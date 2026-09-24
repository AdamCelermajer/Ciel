import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { Approval, ChangeSet, EngineId, HostEvent, HostSettings, Message, PermissionMode, Project, Run, RunStatus, Task, TaskDetail } from '@ciel/contracts';

const now = () => new Date().toISOString();
const parse = <T>(value: string): T => JSON.parse(value) as T;

export class Store {
  readonly db: DatabaseSync;
  private readonly ownerLock: DatabaseSync;
  readonly hostId: string;
  constructor(readonly dataDir: string, hostName?: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.ownerLock = new DatabaseSync(path.join(dataDir, 'host-owner.sqlite'));
    this.ownerLock.exec('PRAGMA busy_timeout=0');
    try { this.ownerLock.exec('BEGIN IMMEDIATE'); }
    catch { this.ownerLock.close(); throw new Error('Another CIEL host already owns this data directory.'); }
    this.db = new DatabaseSync(path.join(dataDir, 'ciel.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(task_id, command_id));
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, host_id TEXT NOT NULL, task_id TEXT, run_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (task_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL, last_run_id TEXT NOT NULL, PRIMARY KEY(task_id, engine));
      CREATE TABLE IF NOT EXISTS changes (run_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_options (run_id TEXT PRIMARY KEY, effort TEXT);
    `);
    this.hostId = this.meta('hostId') ?? randomUUID();
    if (!this.meta('hostId')) this.setMeta('hostId', this.hostId);
    if (!this.meta('settings')) this.setMeta('settings', JSON.stringify({ name: hostName || 'This computer', defaultPermission: 'full-access', notifications: false, autoUpdate: false } satisfies HostSettings));
    this.recover();
  }
  close() { this.db.close();this.ownerLock.exec('ROLLBACK');this.ownerLock.close(); }
  private meta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  private setMeta(key: string, value: string) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  settings(): HostSettings { return parse(this.meta('settings')!); }
  setSettings(value: HostSettings) { this.setMeta('settings', JSON.stringify(value)); }
  network():{url:string;port:number}|undefined { const value=this.meta('network');return value?parse(value):undefined; }
  setNetwork(value:{url:string;port:number}) { this.setMeta('network',JSON.stringify(value)); }
  private all<T>(table: 'projects' | 'tasks' | 'runs' | 'messages' | 'approvals', where = '', args: string[] = []): T[] {
    return (this.db.prepare(`SELECT value FROM ${table} ${where}`).all(...args) as { value: string }[]).map(row => parse<T>(row.value));
  }
  private one<T>(table: 'projects' | 'tasks' | 'runs' | 'approvals', id: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id) as { value: string } | undefined;
    return row && parse<T>(row.value);
  }
  private put(table: 'projects' | 'tasks' | 'runs' | 'messages' | 'approvals', value: { id: string }, extras: string[] = []) {
    const cols = ['id', ...extras, 'value'];
    const vals = [value.id, ...extras.map(k => String((value as unknown as Record<string, unknown>)[k])), JSON.stringify(value)];
    this.db.prepare(`INSERT INTO ${table} (${cols.map(k => k === 'projectId' ? 'project_id' : k === 'taskId' ? 'task_id' : k === 'commandId' ? 'command_id' : k === 'runId' ? 'run_id' : k).join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(...vals);
  }
  projects(): Project[] { return this.all<Project>('projects').sort((a,b) => a.createdAt.localeCompare(b.createdAt)); }
  project(id: string) { return this.one<Project>('projects', id); }
  addProject(name: string, folder: string): Project {
    const project: Project = { id: randomUUID(), hostId: this.hostId, name, path: folder, createdAt: now() };
    this.put('projects', project); return project;
  }
  tasks(): Task[] { return this.all<Task>('tasks').sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); }
  task(id: string) { return this.one<Task>('tasks', id); }
  addTask(projectId: string, title: string, engine: EngineId, model: string | undefined, effort: string | undefined, permission: PermissionMode): Task {
    const timestamp = now();
    const task: Task = { id: randomUUID(), hostId: this.hostId, projectId, title, engine, model, effort, permission, status: 'idle', archived: false, createdAt: timestamp, updatedAt: timestamp, lastReadSeq: 0, attentionSeq: 0 };
    this.put('tasks', task, ['projectId']); return task;
  }
  saveTask(task: Task) { task.updatedAt = now(); this.put('tasks', task, ['projectId']); }
  runs(taskId?: string): Run[] { return this.all<Run>('runs', taskId ? 'WHERE task_id=?' : '', taskId ? [taskId] : []).sort((a,b) => a.createdAt.localeCompare(b.createdAt)); }
  run(id: string) { return this.one<Run>('runs', id); }
  runByCommand(taskId: string, commandId: string): {run: Run; fingerprint: string} | undefined {
    const row = this.db.prepare('SELECT value,fingerprint FROM runs WHERE task_id=? AND command_id=?').get(taskId,commandId) as {value:string;fingerprint:string}|undefined;
    return row && { run: parse<Run>(row.value), fingerprint: row.fingerprint };
  }
  addRun(run: Run, fingerprint: string) {
    this.db.prepare('INSERT INTO runs(id,task_id,command_id,fingerprint,value) VALUES(?,?,?,?,?)').run(run.id,run.taskId,run.commandId,fingerprint,JSON.stringify(run));
  }
  saveRun(run: Run) { this.db.prepare('UPDATE runs SET value=? WHERE id=?').run(JSON.stringify(run),run.id); }
  saveRunEffort(runId:string,effort:string|undefined) { this.db.prepare('INSERT INTO run_options(run_id,effort) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET effort=excluded.effort').run(runId,effort??null); }
  runEffort(runId:string):string|undefined { return (this.db.prepare('SELECT effort FROM run_options WHERE run_id=?').get(runId) as {effort:string|null}|undefined)?.effort??undefined; }
  messages(taskId: string): Message[] { return this.all<Message>('messages','WHERE task_id=?',[taskId]).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); }
  addMessage(message: Message) { this.put('messages', message, ['taskId']); }
  appendMessageText(id:string,text:string) { const row=this.db.prepare('SELECT value FROM messages WHERE id=?').get(id) as {value:string}|undefined;if(!row)return;const message=parse<Message>(row.value);message.text+=text;this.db.prepare('UPDATE messages SET value=? WHERE id=?').run(JSON.stringify(message),id); }
  approval(id: string) { return this.one<Approval>('approvals', id); }
  approvals(taskId: string): Approval[] { return this.all<Approval>('approvals').filter(a => a.taskId === taskId); }
  saveApproval(approval: Approval) { this.put('approvals', approval, ['runId']); }
  session(taskId: string, engine: EngineId): {sessionId:string;lastRunId:string}|undefined {
    const row = this.db.prepare('SELECT session_id,last_run_id FROM sessions WHERE task_id=? AND engine=?').get(taskId,engine) as {session_id:string;last_run_id:string}|undefined;
    return row && {sessionId:row.session_id,lastRunId:row.last_run_id};
  }
  saveSession(taskId:string,engine:EngineId,sessionId:string,lastRunId:string) { this.db.prepare('INSERT INTO sessions(task_id,engine,session_id,last_run_id) VALUES(?,?,?,?) ON CONFLICT(task_id,engine) DO UPDATE SET session_id=excluded.session_id,last_run_id=excluded.last_run_id').run(taskId,engine,sessionId,lastRunId); }
  event(taskId: string | undefined, runId: string | undefined, type: string, data: Record<string,unknown>): HostEvent {
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO events(host_id,task_id,run_id,type,data,created_at) VALUES(?,?,?,?,?,?)').run(this.hostId,taskId ?? null,runId ?? null,type,JSON.stringify(data),createdAt);
    return {seq:Number(result.lastInsertRowid),hostId:this.hostId,taskId,runId,type,data,createdAt};
  }
  events(after = 0, limit = 1000): HostEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after,limit) as Array<{seq:number;host_id:string;task_id:string|null;run_id:string|null;type:string;data:string;created_at:string}>).map(r=>({seq:r.seq,hostId:r.host_id,taskId:r.task_id??undefined,runId:r.run_id??undefined,type:r.type,data:parse(r.data),createdAt:r.created_at}));
  }
  lastSeq(): number { return Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as {seq:number}).seq); }
  changes(taskId: string): ChangeSet[] {
    return (this.db.prepare('SELECT c.value FROM changes c JOIN runs r ON c.run_id=r.id WHERE r.task_id=?').all(taskId) as {value:string}[]).map(r=>parse<ChangeSet>(r.value));
  }
  saveChanges(changes: ChangeSet) { this.db.prepare('INSERT INTO changes(run_id,value) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET value=excluded.value').run(changes.runId,JSON.stringify(changes)); }
  detail(task: Task): TaskDetail { return {task,runs:this.runs(task.id),messages:this.messages(task.id),events:this.allEventsForTask(task.id),changes:this.changes(task.id),approvals:this.approvals(task.id)}; }
  writeHistory(taskId:string):string {
    const task=this.task(taskId);if(!task)throw new Error('Task not found');
    const dir=path.join(this.dataDir,'history');mkdirSync(dir,{recursive:true,mode:0o700});
    const file=path.join(dir,`${task.id}.json`),temporary=`${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary,JSON.stringify(this.detail(task),null,2),{mode:0o600});renameSync(temporary,file);return file;
  }
  private allEventsForTask(taskId:string): HostEvent[] { return (this.db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY seq').all(taskId) as Array<{seq:number;host_id:string;task_id:string;run_id:string|null;type:string;data:string;created_at:string}>).map(r=>({seq:r.seq,hostId:r.host_id,taskId:r.task_id,runId:r.run_id??undefined,type:r.type,data:parse(r.data),createdAt:r.created_at})); }
  recover() {
    for (const run of this.runs()) {
      if (!['queued','running','waiting'].includes(run.status)) continue;
      run.status = 'interrupted'; run.finishedAt = now(); run.error = 'Host service restarted before the run finished'; this.saveRun(run);
      const task = this.task(run.taskId);
      const event = this.event(run.taskId,run.id,'run.interrupted',{runId:run.id,reason:'host-restart'});
      if (task) { task.status='interrupted'; task.attentionSeq=event.seq; this.saveTask(task); }
    }
  }
}

export function terminal(status: RunStatus) { return ['completed','failed','interrupted','cancelled'].includes(status); }
