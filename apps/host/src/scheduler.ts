import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AdapterEvent, ChangeSet, EngineAdapter, EngineId, HostEvent, Run, Task } from '@ciel/contracts';
import { Store, terminal } from './store.js';

export type AdapterMap = Partial<Record<EngineId, EngineAdapter>>;
export interface ChangeCapture {
  before(cwd: string): Promise<unknown>;
  after(cwd: string, before: unknown, runId: string): Promise<ChangeSet>;
}
interface Active { run: Run; folder: string; controller: AbortController; nativeApprovals: Map<string,string>; assistantMessageId?:string }
const now = () => new Date().toISOString();
const contains = (parent:string,child:string) => { const relative=path.relative(parent,child);return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative); };
const overlaps = (a:string,b:string) => contains(a,b)||contains(b,a);

export class Scheduler {
  private active = new Map<string,Active>();
  private jobs = new Set<Promise<void>>();
  private queued: string[] = [];
  private maintenance = new Set<EngineId>();
  private projectionLocks=new Map<EngineId,Promise<void>>();
  private closed = false;
  constructor(readonly store:Store, readonly adapters:AdapterMap, readonly publish:(event:HostEvent)=>void, readonly capture?:ChangeCapture, readonly libraryContext?:(engine:EngineId)=>string, readonly projectLibrary?:(engine:EngineId)=>Promise<{applied:string[];rejected:{id:string;reason:string}[]}>) {}
  enqueue(run:Run) { this.queued.push(run.id); this.drain(); }
  private drain() {
    if (this.closed) return;
    for (const id of [...this.queued]) {
      const run = this.store.run(id); if (!run || run.status !== 'queued') { this.queued=this.queued.filter(x=>x!==id); continue; }
      if(this.maintenance.has(run.engine))continue;
      const task = this.store.task(run.taskId); const project = task && this.store.project(task.projectId);
      if (!task || !project) { this.queued=this.queued.filter(x=>x!==id); this.failOrphan(run); continue; }
      if ([...this.active.values()].some(a => a.run.taskId === run.taskId || overlaps(a.folder,project.path))) continue;
      const active:Active = {run,folder:project.path,controller:new AbortController(),nativeApprovals:new Map()};
      this.active.set(run.id,active); this.queued=this.queued.filter(x=>x!==id);
      const job=this.execute(active,task);this.jobs.add(job);void job.finally(()=>this.jobs.delete(job));
    }
  }
  private failOrphan(run:Run) { run.status='failed';run.error='Task or project missing';run.finishedAt=now();this.store.saveRun(run);this.publish(this.store.event(run.taskId,run.id,'run.failed',{error:run.error})); }
  private buildPrompt(run:Run,task:Task): {prompt:string;sessionId?:string} {
    const previous = this.store.session(task.id,run.engine);
    const runs = this.store.runs(task.id).filter(r=>r.id!==run.id);
    const last = runs.at(-1);
    const library=this.libraryContext?.(run.engine);
    const history=`Full CIEL task history is available in this host-local file: ${this.store.writeHistory(task.id)}. Read it when earlier details are needed.`;
    if (!last || (previous && previous.lastRunId === last.id)) return {prompt:`${history}${library?`\n\nCIEL shared library context:\n${library}`:''}\n\nCurrent user request:\n${run.prompt}`,sessionId:previous?.sessionId};
    const after = previous ? runs.slice(Math.max(0,runs.findIndex(r=>r.id===previous.lastRunId)+1)) : runs;
    const recent = after.slice(-8).map(r=>`[${r.engine} ${r.status}] User: ${r.prompt.slice(0,1800)}\nAssistant: ${(this.store.messages(task.id).filter(m=>m.runId===r.id&&m.role==='assistant').map(m=>m.text).join('\n')).slice(0,2500)}`).join('\n\n');
    const changes = this.store.changes(task.id).slice(-4).flatMap(c=>c.files.map(f=>`${f.kind}: ${f.path}`)).slice(-30).join(', ');
    const context = `CIEL handoff context (concise visible history; native internal state is not transferred). Workspace: ${this.store.project(task.projectId)?.path}.\n${history}\n${recent.slice(-12000)}${changes ? `\nObserved workspace changes: ${changes}` : ''}${library?`\nShared library context:\n${library}`:''}\n\nCurrent user request:\n${run.prompt}`;
    return {prompt:context,sessionId:previous?.sessionId};
  }
  private emit(run:Run, type:string, data:Record<string,unknown>) { this.publish(this.store.event(run.taskId,run.id,type,data)); }
  private async project(engine:EngineId) {
    if(!this.projectLibrary)return {applied:[],rejected:[]};
    const prior=this.projectionLocks.get(engine)??Promise.resolve();
    const work=prior.then(()=>this.projectLibrary!(engine));
    this.projectionLocks.set(engine,work.then(()=>{},()=>{}));
    return work;
  }
  private onAdapterEvent(active:Active,event:AdapterEvent) {
    const run=active.run;if(terminal(run.status))return;
    if (event.type==='session') { run.nativeSessionId=event.sessionId;this.store.saveRun(run);this.store.saveSession(run.taskId,run.engine,event.sessionId,run.id); }
    if (event.type==='image.generated') {
      const image=this.store.addGeneratedImage(run.taskId,run.id,event.id,event.savedPath,event.base64);
      if(image)active.assistantMessageId=this.store.assistantMessage(run.id)?.id;
      this.emit(run,image?'image.added':'image.warning',image?{id:image.id}:{message:'Generated image could not be saved'});
      return;
    }
    if (event.type==='approval') {
      const id=randomUUID(); active.nativeApprovals.set(id,event.id);
      this.store.saveApproval({id,taskId:run.taskId,runId:run.id,title:event.title,description:event.description,choices:event.choices,status:'pending'});
      run.status='waiting';this.store.saveRun(run);
      const task=this.store.task(run.taskId); const published=this.store.event(run.taskId,run.id,'approval.requested',{id,title:event.title,description:event.description,choices:event.choices});this.publish(published);
      if (task) {task.status='waiting';task.attentionSeq=published.seq;this.store.saveTask(task);}
      return;
    }
    if (event.type==='text.delta' && event.channel !== 'reasoning') {
      if(active.assistantMessageId)this.store.appendMessageText(active.assistantMessageId,event.text);
      else {active.assistantMessageId=randomUUID();this.store.addMessage({id:active.assistantMessageId,taskId:run.taskId,runId:run.id,role:'assistant',text:event.text,createdAt:now(),engine:run.engine});}
    }
    this.emit(run,event.type,event as unknown as Record<string,unknown>);
  }
  private async execute(active:Active,task:Task) {
    const run=active.run; const adapter=this.adapters[run.engine];
    if (!adapter) {this.finish(active,'failed','Engine adapter unavailable');this.active.delete(run.id);this.drain();return;}
    run.status='running';run.startedAt=now();this.store.saveRun(run);task.status='running';this.store.saveTask(task);this.emit(run,'run.started',{runId:run.id});
    let before:unknown;
    try { if (this.capture) before=await this.capture.before(active.folder); } catch (error) {this.emit(run,'changes.warning',{message:String(error)});}
    try {
      if(this.projectLibrary){const report=await this.project(run.engine);if(report.applied.length||report.rejected.length)this.emit(run,'library.projection',{applied:report.applied,rejected:report.rejected});if(report.rejected.length)throw new Error(`Shared library projection failed: ${report.rejected.map(f=>`${f.id}: ${f.reason}`).join('; ')}`);}
      const context=this.buildPrompt(run,task);
      const latestImage=run.engine==='codex'?this.store.latestGeneratedImagePath(task.id,run.id):undefined;
      const localImages=[...this.store.inputImagePaths(run),...(latestImage?[latestImage]:[])];
      const result=await adapter.run({taskId:task.id,runId:run.id,cwd:active.folder,prompt:context.prompt,sessionId:context.sessionId,model:run.model,effort:this.store.runEffort(run.id),permission:run.permission,...(localImages.length?{localImages}:{}),signal:active.controller.signal,emit:e=>this.onAdapterEvent(active,e)});
      if (result.sessionId) {run.nativeSessionId=result.sessionId;this.store.saveSession(task.id,run.engine,result.sessionId,run.id);}
      if (result.text && !this.store.messages(task.id).some(m=>m.runId===run.id&&m.role==='assistant')) this.store.addMessage({id:randomUUID(),taskId:task.id,runId:run.id,role:'assistant',text:result.text,createdAt:now(),engine:run.engine});
      this.finish(active,active.controller.signal.aborted?(this.closed?'interrupted':'cancelled'):'completed');
    } catch(error) { this.finish(active,active.controller.signal.aborted?(this.closed?'interrupted':'cancelled'):'failed',String(error)); }
    finally {
      if (this.capture && before !== undefined) try { const changes=await this.capture.after(active.folder,before,run.id);this.store.saveChanges(changes);this.emit(run,'changes.captured',{runId:run.id,files:changes.files.length,warning:changes.warning}); } catch(error) {this.emit(run,'changes.warning',{message:String(error)});}
      this.active.delete(run.id); this.drain();
    }
  }
  private finish(active:Active,status:'completed'|'failed'|'cancelled'|'interrupted',error?:string) {
    const run=active.run; if (terminal(run.status)) return;
    run.status=status;run.finishedAt=now();if(error)run.error=error;this.store.saveRun(run);
    const event=this.store.event(run.taskId,run.id,`run.${status}`,{runId:run.id,...(error?{error}:{})});this.publish(event);
    const task=this.store.task(run.taskId);if(task){task.status=this.queued.some(id=>this.store.run(id)?.taskId===task.id)?'queued':status;task.attentionSeq=event.seq;this.store.saveTask(task);}
  }
  interrupt(id:string): Run | undefined {
    const run=this.store.run(id);if(!run)return;
    if(run.status==='queued') {this.queued=this.queued.filter(x=>x!==id);run.status='cancelled';run.finishedAt=now();this.store.saveRun(run);const event=this.store.event(run.taskId,run.id,'run.cancelled',{runId:run.id});this.publish(event);const task=this.store.task(run.taskId);if(task){task.status=this.isActive(task.id)?task.status:'cancelled';task.attentionSeq=event.seq;this.store.saveTask(task);}this.drain();return run;}
    const active=this.active.get(id);if(active&&!active.controller.signal.aborted){active.controller.abort();this.emit(run,'run.interrupting',{runId:id});}
    return this.store.run(id);
  }
  async steer(id:string,prompt:string) {
    const active=this.active.get(id);
    if(!active||active.run.status!=='running')throw new Error('Run is no longer running');
    const adapter=this.adapters[active.run.engine];
    if(!adapter?.steer)throw new Error('This agent does not support steering a running turn; queue a message instead');
    await adapter.steer(id,prompt);
    this.store.addMessage({id:randomUUID(),taskId:active.run.taskId,runId:id,role:'user',text:prompt,createdAt:now(),engine:active.run.engine});
    this.emit(active.run,'run.steered',{runId:id});
  }
  async approve(id:string,decision:string) {
    const approval=this.store.approval(id);if(!approval)throw new Error('Approval not found');
    if(approval.status!=='pending')throw new Error('Approval already resolved');
    if(!approval.choices.includes(decision))throw new Error('Invalid approval decision');
    const active=this.active.get(approval.runId);if(!active)throw new Error('Run is no longer active');
    const nativeId=active.nativeApprovals.get(id);if(!nativeId)throw new Error('Native approval unavailable');
    const adapter=this.adapters[active.run.engine];if(!adapter)throw new Error('Engine adapter unavailable');
    await adapter.approve(approval.runId,nativeId,decision);
    approval.status='resolved';approval.decision=decision;this.store.saveApproval(approval);active.nativeApprovals.delete(id);
    active.run.status='running';this.store.saveRun(active.run);const task=this.store.task(active.run.taskId);if(task){task.status='running';this.store.saveTask(task);}
    this.emit(active.run,'approval.resolved',{id,decision});return approval;
  }
  isActive(taskId:string) { return [...this.active.values()].some(a=>a.run.taskId===taskId); }
  isEngineBusy(engine:EngineId) { return [...this.active.values()].some(a=>a.run.engine===engine)||this.queued.some(id=>this.store.run(id)?.engine===engine); }
  setEngineMaintenance(engine:EngineId,enabled:boolean) {if(enabled)this.maintenance.add(engine);else{this.maintenance.delete(engine);this.drain();}}
  async close() {this.closed=true;for(const a of this.active.values())a.controller.abort();await Promise.allSettled(Object.values(this.adapters).filter(Boolean).map(a=>a!.dispose()));await Promise.allSettled([...this.jobs]);}
}
