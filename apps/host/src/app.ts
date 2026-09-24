import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { CIEL_VERSION, ENGINE_IDS, type EngineId, type EngineStatus, type HostConnection, type HostEvent, type HostInfo, type HostState, type Run, type SubmitRunInput } from '@ciel/contracts';
import { LibraryStore } from '../../../packages/library/src/index.js';
import { snapshotWorkspace, compareSnapshots, type WorkspaceSnapshot } from '../../../packages/workspace/src/index.js';
import { Scheduler, type AdapterMap } from './scheduler.js';
import { Store } from './store.js';
import { PreviewManager } from './previews.js';
import { listFolders, pickFolder } from './folders.js';
import { titleFromPrompt } from './session-title.js';

const engineSchema = z.enum(ENGINE_IDS);
const permissionSchema = z.enum(['full-access','ask','read-only']);
const idSchema = z.string().min(1).max(200);
const projectSchema = z.object({name:z.string().trim().min(1).max(120),path:z.string().trim().min(1).max(4096)}).strict();
const taskSchema = z.object({projectId:idSchema,title:z.string().trim().min(1).max(160).optional(),engine:engineSchema,model:z.string().min(1).max(200).optional(),effort:z.string().min(1).max(100).optional(),permission:permissionSchema.optional()}).strict();
const patchTaskSchema = z.object({title:z.string().trim().min(1).max(160).optional(),engine:engineSchema.optional(),model:z.string().min(1).max(200).nullable().optional(),effort:z.string().min(1).max(100).nullable().optional(),permission:permissionSchema.optional(),archived:z.boolean().optional()}).strict().refine(v=>Object.keys(v).length>0);
const imageSchema=z.object({mimeType:z.enum(['image/png','image/jpeg','image/webp']),base64:z.string().min(1).max(6*1024*1024).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict();
const validImage=(image:{mimeType:'image/png'|'image/jpeg'|'image/webp';bytes:Buffer})=>{
  const {mimeType,bytes}=image;
  if(!bytes.length||bytes.length>4*1024*1024)return false;
  if(mimeType==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mimeType==='image/jpeg')return bytes.subarray(0,3).equals(Buffer.from([255,216,255]));
  return bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
};
const runSchema = z.object({prompt:z.string().trim().min(1).max(200000),commandId:z.string().trim().min(1).max(200),engine:engineSchema.optional(),model:z.string().min(1).max(200).nullable().optional(),effort:z.string().min(1).max(100).nullable().optional(),permission:permissionSchema.optional(),images:z.array(imageSchema).max(3).optional()}).strict();
const settingsSchema = z.object({name:z.string().trim().min(1).max(120).optional(),defaultPermission:permissionSchema.optional(),notifications:z.boolean().optional(),autoUpdate:z.boolean().optional(),updateDirectory:z.string().trim().max(4096).optional()}).strict();
const params = z.object({hostId:idSchema,id:idSchema.optional()});
const now = () => new Date().toISOString();

export interface HostContext { store:Store; scheduler:Scheduler; adapters:AdapterMap; library:LibraryStore; previews:PreviewManager; host:HostInfo; publish:(event:HostEvent)=>void; pauseEngine:(engine:EngineId)=>Promise<void>; resumeEngine:(engine:EngineId)=>void }
export interface CreateAppOptions {
  dataDir:string; adapters?:AdapterMap; hostName?:string; captureChanges?:boolean; port?:number;
  listHosts?:()=>HostConnection[]|Promise<HostConnection[]>;
  configure?:(app:FastifyInstance,context:HostContext)=>void|Promise<void>;
}

export async function createApp(options:CreateAppOptions):Promise<FastifyInstance & {ciel:HostContext}> {
  const app=Fastify({logger:false,bodyLimit:2*1024*1024,forceCloseConnections:true});
  const store=new Store(options.dataDir,options.hostName);
  const library=new LibraryStore(options.dataDir);
  const previews=new PreviewManager(store,options.port??4317);await previews.restore();
  const adapters:AdapterMap=options.adapters ?? await import('@ciel/adapters').then(m=>m.createAdapters({dataDir:options.dataDir}));
  const host:HostInfo={id:store.hostId,name:store.settings().name,platform:process.platform,version:CIEL_VERSION,online:true,local:true};
  const bus=new EventEmitter();bus.setMaxListeners(0);
  const publish=(event:HostEvent)=>bus.emit('event',event);
  const scheduler=new Scheduler(store,adapters,publish,options.captureChanges===false?undefined:{before:snapshotWorkspace,after:async(cwd,before,runId)=>compareSnapshots(before as WorkspaceSnapshot,await snapshotWorkspace(cwd),runId)},engine=>library.renderContext(engine),engine=>library.projectToEngine(engine,options.dataDir));
  const pausedEngines=new Set<EngineId>();
  const pendingStatus=new Map<EngineId,Promise<void>>();
  const pauseEngine=async(engine:EngineId)=>{pausedEngines.add(engine);await pendingStatus.get(engine);await adapters[engine]?.dispose();};
  const resumeEngine=(engine:EngineId)=>{pausedEngines.delete(engine);void refreshStatus(true);};
  const context:HostContext={store,scheduler,adapters,library,previews,host,publish,pauseEngine,resumeEngine};
  Object.assign(app,{ciel:context});
  app.addHook('onClose',async()=>{await scheduler.close();await previews.close();store.close();});
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ZodError) return reply.code(400).send({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')});
    if((error as {statusCode?:number}).statusCode) return reply.code((error as {statusCode:number}).statusCode).send({error:String((error as {message?:string}).message ?? 'Request error')});
    request.log.error(error);return reply.code(500).send({error:'Internal host error'});
  });
  const bad=(reply: {code:(n:number)=>{send:(v:unknown)=>unknown}},message:string,status=400)=>reply.code(status).send({error:message});
  const scoped=(raw:unknown,reply:any)=>{const p=params.parse(raw);if(p.hostId!==host.id){bad(reply,'Host not found',404);return false;}return true;};
  const key=(raw:unknown)=>idSchema.parse((raw as {id:string}).id);
  const engineStatus=new Map<EngineId,EngineStatus>();
  let lastStatus=0,refreshing:Promise<void>|undefined;
  const refreshStatus=(force=false)=>{
    if(refreshing)return refreshing;
    if(!force && Date.now()-lastStatus<15000)return Promise.resolve();
    refreshing=Promise.allSettled(Object.values(adapters).filter(Boolean).filter(adapter=>!pausedEngines.has(adapter!.id)).map(async adapter=>{const pending=adapter!.status().then(status=>{engineStatus.set(status.id,status);});pendingStatus.set(adapter!.id,pending);try{await pending;}finally{pendingStatus.delete(adapter!.id);}})).then(()=>{lastStatus=Date.now();refreshing=undefined;});
    return refreshing;
  };
  void refreshStatus();
  if(options.configure)await options.configure(app,context);
  app.get('/api/v1/hosts',async()=>options.listHosts?options.listHosts():[{...host}]);
  app.get('/api/v1/h/:hostId/state',async(request,reply)=>{
    if(!scoped(request.params,reply))return;
    void refreshStatus();
    const state:HostState={host:{...host,name:store.settings().name},projects:store.projects(),tasks:store.tasks(),engines:[...engineStatus.values()],library:library.list(),settings:store.settings(),lastSeq:store.lastSeq(),previews:previews.list()};
    return state;
  });
  app.get('/api/v1/h/:hostId/projects',async(request,reply)=>{if(!scoped(request.params,reply))return;return store.projects();});
  app.get('/api/v1/h/:hostId/projects/folders',async(request,reply)=>{
    if(!scoped(request.params,reply))return;
    const {folder}=z.object({folder:z.string().min(1).max(4096).optional()}).strict().parse(request.query);
    try{return await listFolders(folder);}catch{return bad(reply,'Cannot open this folder',400);}
  });
  app.post('/api/v1/h/:hostId/projects/pick-folder',async(request,reply)=>{
    if(!scoped(request.params,reply))return;
    try{return {path:await pickFolder()};}catch(error){return bad(reply,(error as Error).message,501);}
  });
  app.post('/api/v1/h/:hostId/projects',async(request,reply)=>{
    if(!scoped(request.params,reply))return;
    const input=projectSchema.parse(request.body);
    let folder:string;
    try {folder=realpathSync(input.path);if(!statSync(folder).isDirectory())return bad(reply,'Project path is not a directory');}
    catch{return bad(reply,'Project path does not exist');}
    if(store.projects().some(project=>project.path===folder))return bad(reply,'This folder is already a project',409);
    const project=store.addProject(input.name,folder);publish(store.event(undefined,undefined,'project.created',{projectId:project.id}));return reply.code(201).send(project);
  });
  app.post('/api/v1/h/:hostId/tasks',async(request,reply)=>{
    if(!scoped(request.params,reply))return;
    const input=taskSchema.parse(request.body);if(!store.project(input.projectId))return bad(reply,'Project not found',404);
    const task=store.addTask(input.projectId,input.title??'New session',input.engine,input.model,input.effort,input.permission??store.settings().defaultPermission);
    publish(store.event(task.id,undefined,'task.created',{taskId:task.id}));return reply.code(201).send(task);
  });
  app.get('/api/v1/h/:hostId/tasks/:id',async(request,reply)=>{if(!scoped(request.params,reply))return;const task=store.task(key(request.params));if(!task)return bad(reply,'Task not found',404);return store.detail(task);});
  app.get('/api/v1/h/:hostId/tasks/:id/images/:imageId',async(request,reply)=>{
    if(!scoped(request.params,reply))return;
    const taskId=key(request.params),imageId=idSchema.parse((request.params as {imageId:string}).imageId);
    if(!store.task(taskId))return bad(reply,'Task not found',404);
    const image=store.image(taskId,imageId);if(!image)return bad(reply,'Image not found',404);
    return reply.header('content-type',image.mimeType).header('cache-control','private, max-age=3600').header('x-content-type-options','nosniff').send(image.bytes);
  });
  app.patch('/api/v1/h/:hostId/tasks/:id',async(request,reply)=>{
    if(!scoped(request.params,reply))return;const task=store.task(key(request.params));if(!task)return bad(reply,'Task not found',404);
    const input=patchTaskSchema.parse(request.body);
    if(scheduler.isActive(task.id) && (input.engine || input.permission))return bad(reply,'Cannot change engine or permission during an active run',409);
    if(input.title!==undefined)task.title=input.title;if(input.engine!==undefined)task.engine=input.engine;
    if(input.model!==undefined)task.model=input.model??undefined;if(input.effort!==undefined)task.effort=input.effort??undefined;
    if(input.permission!==undefined)task.permission=input.permission;if(input.archived!==undefined)task.archived=input.archived;
    store.saveTask(task);publish(store.event(task.id,undefined,'task.updated',{taskId:task.id}));return task;
  });
  app.post('/api/v1/h/:hostId/tasks/:id/runs',{bodyLimit:18*1024*1024},async(request,reply)=>{
    if(!scoped(request.params,reply))return;const task=store.task(key(request.params));if(!task)return bad(reply,'Task not found',404);
    const input=runSchema.parse(request.body) satisfies SubmitRunInput;
    const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior=store.runByCommand(task.id,input.commandId);
    if(prior)return prior.fingerprint===fingerprint?reply.code(202).send(prior.run):bad(reply,'Command ID already used with different input',409);
    const engine=input.engine??task.engine;if(!adapters[engine])return bad(reply,'Engine adapter unavailable',503);
    if(input.images?.length&&engine!=='codex')return bad(reply,'Image attachments are currently supported by Codex only',400);
    const images=(input.images??[]).map(image=>({mimeType:image.mimeType,bytes:Buffer.from(image.base64,'base64')}));
    if(images.some(image=>!validImage(image)))return bad(reply,'Invalid image or image larger than 4 MB',400);
    if(engine!==task.engine&&store.runs(task.id).some(run=>['queued','running','waiting'].includes(run.status)))return bad(reply,'Finish or cancel the current engine run before switching engines',409);
    const sameEngine=engine===task.engine;
    const model=input.model===undefined?(sameEngine?task.model:undefined):input.model??undefined;
    const effort=input.effort===undefined?(sameEngine?task.effort:undefined):input.effort??undefined;
    if ((task.title === 'New session' || task.title === 'New task') && store.runs(task.id).length === 0) {
      task.title = titleFromPrompt(input.prompt);
    }
    const run:Run={id:randomUUID(),taskId:task.id,hostId:host.id,engine,model,permission:input.permission??task.permission,status:'queued',prompt:input.prompt,createdAt:now(),commandId:input.commandId};
    store.addRun(run,fingerprint);store.saveRunEffort(run.id,effort);
    const attachments=images.map((image,index)=>store.addInputImage(task.id,run.id,index,image.mimeType,image.bytes));
    if(attachments.length){run.inputImageIds=attachments.map(image=>image.id);store.saveRun(run);}
    store.addMessage({id:randomUUID(),taskId:task.id,runId:run.id,role:'user',text:run.prompt,createdAt:run.createdAt,engine,images:attachments});task.status=scheduler.isActive(task.id)?task.status:'queued';task.engine=engine;task.model=model;task.effort=effort;task.permission=run.permission;store.saveTask(task);
    publish(store.event(task.id,run.id,'run.queued',{runId:run.id}));scheduler.enqueue(run);return reply.code(202).send(run);
  });
  app.post('/api/v1/h/:hostId/tasks/:id/read',async(request,reply)=>{
    if(!scoped(request.params,reply))return;const task=store.task(key(request.params));if(!task)return bad(reply,'Task not found',404);
    const {seq}=z.object({seq:z.number().int().min(0)}).strict().parse(request.body);
    if(seq>store.lastSeq())return bad(reply,'Event cursor does not exist');
    if(seq>0){const event=store.events(seq-1,1)[0];if(event?.seq!==seq||event.taskId!==task.id)return bad(reply,'Event cursor does not belong to this task');}
    if(seq>task.lastReadSeq){task.lastReadSeq=seq;store.saveTask(task);publish(store.event(task.id,undefined,'task.read',{seq}));}
    return task;
  });
  app.post('/api/v1/h/:hostId/runs/:id/interrupt',async(request,reply)=>{if(!scoped(request.params,reply))return;const run=scheduler.interrupt(key(request.params));if(!run)return bad(reply,'Run not found',404);return run;});
  app.post('/api/v1/h/:hostId/runs/:id/steer',async(request,reply)=>{
    if(!scoped(request.params,reply))return;
    const {prompt}=z.object({prompt:z.string().trim().min(1).max(200000)}).strict().parse(request.body);
    try{await scheduler.steer(key(request.params),prompt);return {ok:true};}
    catch(error){return bad(reply,String((error as Error).message),409);}
  });
  app.post('/api/v1/h/:hostId/approvals/:id',async(request,reply)=>{
    if(!scoped(request.params,reply))return;const {decision}=z.object({decision:z.string().min(1).max(200)}).strict().parse(request.body);
    try{return await scheduler.approve(key(request.params),decision);}catch(error){return bad(reply,String((error as Error).message),409);}
  });
  app.get('/api/v1/h/:hostId/previews',async(request,reply)=>{if(!scoped(request.params,reply))return;return previews.list();});
  app.post('/api/v1/h/:hostId/previews',async(request,reply)=>{
    if(!scoped(request.params,reply))return;
    const input=z.object({projectId:idSchema,name:z.string().trim().min(1).max(120),port:z.number().int().min(1).max(65535),command:z.string().trim().min(1).max(4000).optional(),remote:z.boolean().optional()}).strict().parse(request.body);
    try{const preview=await previews.create(input);publish(store.event(undefined,undefined,'preview.created',{previewId:preview.id}));return reply.code(201).send(preview);}
    catch(error){return bad(reply,(error as Error).message,400);}
  });
  app.post('/api/v1/h/:hostId/previews/:id/stop',async(request,reply)=>{if(!scoped(request.params,reply))return;const preview=await previews.stop(key(request.params));if(!preview)return bad(reply,'Preview not found',404);publish(store.event(undefined,undefined,'preview.stopped',{previewId:preview.id}));return preview;});
  app.get('/api/v1/h/:hostId/events',async(request,reply)=>{
    if(!scoped(request.params,reply))return;
    const query=z.object({after:z.coerce.number().int().min(0).optional()}).parse(request.query);
    const header=request.headers['last-event-id'];const headerCursor=typeof header==='string'?Number(header):0;if(!Number.isSafeInteger(headerCursor)||headerCursor<0)return bad(reply,'Invalid event cursor');let after=Math.max(query.after??0,headerCursor);
    reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
    const write=(event:HostEvent)=>{if(event.seq<=after||reply.raw.destroyed)return;reply.raw.write(`id: ${event.seq}\nevent: host-event\ndata: ${JSON.stringify(event)}\n\n`);after=event.seq;};
    const onEvent=(event:HostEvent)=>write(event);bus.on('event',onEvent);
    let batch:HostEvent[];do{batch=store.events(after,1000);for(const event of batch)write(event);}while(batch.length===1000);
    const heartbeat=setInterval(()=>{if(!reply.raw.destroyed)reply.raw.write(': heartbeat\n\n');},25000);
    const cleanup=()=>{clearInterval(heartbeat);bus.off('event',onEvent);};request.raw.once('close',cleanup);reply.raw.once('close',cleanup);
  });
  app.get('/api/v1/h/:hostId/engines',async(request,reply)=>{if(!scoped(request.params,reply))return;await refreshStatus(true);return [...engineStatus.values()];});
  app.post('/api/v1/h/:hostId/engines/:id/login',async(request,reply)=>{if(!scoped(request.params,reply))return;const id=engineSchema.parse(key(request.params));if(pausedEngines.has(id))return bad(reply,'Engine maintenance in progress',409);const adapter=adapters[id];if(!adapter)return bad(reply,'Engine adapter unavailable',503);const result=await adapter.login();void refreshStatus(true);return result;});
  app.put('/api/v1/h/:hostId/engines/opencode/key',async(request,reply)=>{if(!scoped(request.params,reply))return;if(pausedEngines.has('opencode'))return bad(reply,'Engine maintenance in progress',409);const {key}=z.object({key:z.string().min(1).max(10000)}).strict().parse(request.body);const adapter=adapters.opencode;if(!adapter?.setApiKey)return bad(reply,'OpenCode key configuration unavailable',503);await adapter.setApiKey(key);void refreshStatus(true);return {ok:true};});
  app.get('/api/v1/h/:hostId/library',async(request,reply)=>{if(!scoped(request.params,reply))return;return library.list();});
  app.post('/api/v1/h/:hostId/library',async(request,reply)=>{if(!scoped(request.params,reply))return;const item=library.create(request.body);publish(store.event(undefined,undefined,'library.updated',{id:item.id}));return reply.code(201).send(item);});
  app.patch('/api/v1/h/:hostId/library/:id',async(request,reply)=>{if(!scoped(request.params,reply))return;try{const item=library.update(key(request.params),request.body);publish(store.event(undefined,undefined,'library.updated',{id:item.id}));return item;}catch(error){return bad(reply,(error as Error).message,404);}});
  app.delete('/api/v1/h/:hostId/library/:id',async(request,reply)=>{if(!scoped(request.params,reply))return;const id=key(request.params);if(!library.remove(id))return bad(reply,'Library item not found',404);publish(store.event(undefined,undefined,'library.updated',{id}));return {ok:true};});
  app.get('/api/v1/h/:hostId/library/export',async(request,reply)=>{if(!scoped(request.params,reply))return;return library.export();});
  app.post('/api/v1/h/:hostId/library/import',async(request,reply)=>{if(!scoped(request.params,reply))return;const items=library.import(request.body);publish(store.event(undefined,undefined,'library.updated',{count:items.length}));return items;});
  app.get('/api/v1/h/:hostId/settings',async(request,reply)=>{if(!scoped(request.params,reply))return;return store.settings();});
  app.patch('/api/v1/h/:hostId/settings',async(request,reply)=>{if(!scoped(request.params,reply))return;const patch=settingsSchema.parse(request.body);const settings={...store.settings(),...patch};store.setSettings(settings);host.name=settings.name;publish(store.event(undefined,undefined,'settings.updated',{}));return settings;});
  const webDir=path.resolve(process.cwd(),'dist/web');
  if(existsSync(webDir)){await app.register(fastifyStatic,{root:webDir,prefix:'/'});app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api/')?reply.code(404).send({error:'Not found'}):reply.sendFile('index.html'));}
  return app as unknown as FastifyInstance & {ciel:HostContext};
}
