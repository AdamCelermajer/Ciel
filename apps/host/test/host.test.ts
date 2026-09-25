import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, get as httpGet } from 'node:http';
import { connect as netConnect } from 'node:net';
import { createHash } from 'node:crypto';
import type { EngineAdapter, EngineId, EngineRunInput, EngineRunResult, EngineStatus } from '@ciel/contracts';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';

class FakeAdapter implements EngineAdapter {
  constructor(readonly id:EngineId='codex'){}
  calls:EngineRunInput[]=[];
  pending=new Map<string,{resolve:(result:EngineRunResult)=>void;reject:(error:Error)=>void}>();
  steers:Array<{runId:string;prompt:string}>=[];
  async status():Promise<EngineStatus>{return {id:this.id,name:'Fake test adapter',installed:true,authenticated:true,models:[],capabilities:{resume:true,approvals:true,modelDiscovery:false,permissions:['full-access'],nativeExtensions:false}};}
  async login(){return {status:'completed' as const,message:'Test only'};}
  run(input:EngineRunInput):Promise<EngineRunResult>{this.calls.push(input);return new Promise((resolve,reject)=>{this.pending.set(input.runId,{resolve,reject});input.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});}
  async approve(){}
  async steer(runId:string,prompt:string){this.steers.push({runId,prompt});}
  async dispose(){}
  complete(id:string,text='done'){this.pending.get(id)?.resolve({sessionId:`native-${id}`,text});this.pending.delete(id);}
}
const dirs:string[]=[];
const makeDir=()=>{const dir=mkdtempSync(path.join(os.tmpdir(),'ciel-host-test-'));dirs.push(dir);return dir;};
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const tick=async()=>{await new Promise(resolve=>setTimeout(resolve,10));};
const until=async(predicate:()=>boolean)=>{for(let i=0;i<100&&!predicate();i++)await tick();expect(predicate()).toBe(true);};

describe('host scheduler and persistence',()=>{
  it('reuses an unprompted session in the same project when requested',async()=>{
    const dir=makeDir(),folderA=path.join(dir,'a'),folderB=path.join(dir,'b');mkdirSync(folderA);mkdirSync(folderB);
    const fake=new FakeAdapter(),app=await createApp({dataDir:path.join(dir,'data'),adapters:{codex:fake},captureChanges:false});
    const host=app.ciel.host.id;
    const post=async(url:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:`/api/v1/h/${host}${url}`,payload});
    const projectA=(await post('/projects',{name:'A',path:folderA})).json();
    const projectB=(await post('/projects',{name:'B',path:folderB})).json();
    const create=(projectId:string)=>post('/tasks',{projectId,engine:'codex',reuseEmpty:true});
    const named=(await post('/tasks',{projectId:projectA.id,engine:'codex',title:'Named session'})).json();
    const first=(await create(projectA.id)).json();
    expect(first.id).not.toBe(named.id);
    const repeated=await create(projectA.id);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().id).toBe(first.id);
    expect(app.ciel.store.tasks()).toHaveLength(2);
    expect((await create(projectB.id)).json().id).not.toBe(first.id);
    const run=(await post(`/tasks/${first.id}/runs`,{prompt:'Start work',commandId:'first'})).json();
    const next=(await create(projectA.id)).json();
    expect(next.id).not.toBe(first.id);
    expect((await create(projectA.id)).json().id).toBe(next.id);
    await until(()=>fake.pending.has(run.id));fake.complete(run.id);
    await until(()=>app.ciel.store.run(run.id)?.status==='completed');await app.close();
  });
  it('lists host folders for the project picker and rejects duplicate projects',async()=>{
    const dir=makeDir(),folder=path.join(dir,'my-project');mkdirSync(folder);
    const app=await createApp({dataDir:path.join(dir,'data'),adapters:{codex:new FakeAdapter()},captureChanges:false});
    const h=app.ciel.host.id;
    const listed=await app.inject({method:'GET',url:`/api/v1/h/${h}/projects/folders?folder=${encodeURIComponent(dir)}`});
    expect(listed.statusCode).toBe(200);
    expect(listed.json().directories).toContain('my-project');
    const first=await app.inject({method:'POST',url:`/api/v1/h/${h}/projects`,payload:{name:'Project',path:folder}});
    expect(first.statusCode).toBe(201);
    const again=await app.inject({method:'POST',url:`/api/v1/h/${h}/projects`,payload:{name:'Duplicate',path:folder}});
    expect(again.statusCode).toBe(409);
    await app.close();
  });
  it('passes pasted images to Codex and records steering in the active turn',async()=>{
    const dir=makeDir(),folder=path.join(dir,'folder');mkdirSync(folder);
    const fake=new FakeAdapter(),app=await createApp({dataDir:path.join(dir,'data'),adapters:{codex:fake},captureChanges:false});
    const h=app.ciel.host.id;
    const project=(await app.inject({method:'POST',url:`/api/v1/h/${h}/projects`,payload:{name:'P',path:folder}})).json();
    const task=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks`,payload:{projectId:project.id,engine:'codex'}})).json();
    const png=Buffer.from('89504e470d0a1a0a00000000','hex');
    const endpoint=`/api/v1/h/${h}/tasks/${task.id}/runs`;
    const response=await app.inject({method:'POST',url:endpoint,payload:{prompt:'Inspect this',commandId:'image-1',images:[{mimeType:'image/png',base64:png.toString('base64')}]}});
    expect(response.statusCode).toBe(202);
    const run=response.json();
    await until(()=>fake.calls.length===1);
    expect(fake.calls[0]!.localImages).toHaveLength(1);
    expect(readFileSync(fake.calls[0]!.localImages![0]!)).toEqual(png);
    const message=app.ciel.store.messages(task.id).find(item=>item.role==='user')!;
    expect(message.images).toHaveLength(1);
    expect((await app.inject({method:'GET',url:`/api/v1/h/${h}/tasks/${task.id}/images/${message.images![0]!.id}`})).rawPayload).toEqual(png);
    const steer=await app.inject({method:'POST',url:`/api/v1/h/${h}/runs/${run.id}/steer`,payload:{prompt:'Look at the top left'}});
    expect(steer.statusCode).toBe(200);
    expect(fake.steers).toEqual([{runId:run.id,prompt:'Look at the top left'}]);
    expect(app.ciel.store.messages(task.id).map(item=>item.text)).toContain('Look at the top left');
    expect((await app.inject({method:'POST',url:endpoint,payload:{prompt:'Bad',commandId:'image-2',images:[{mimeType:'image/png',base64:Buffer.from('not an image').toString('base64')}]}})).statusCode).toBe(400);
    fake.complete(run.id);await tick();await app.close();
  });
  it('persists generated images as task-scoped attachments without exposing base64 in events',async()=>{
    const dir=makeDir(),folder=path.join(dir,'folder');mkdirSync(folder);
    const fake=new FakeAdapter(),dataDir=path.join(dir,'data');
    const app=await createApp({dataDir,adapters:{codex:fake},captureChanges:false}),h=app.ciel.host.id;
    const project=(await app.inject({method:'POST',url:`/api/v1/h/${h}/projects`,payload:{name:'P',path:folder}})).json();
    const task=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks`,payload:{projectId:project.id,engine:'codex'}})).json();
    const other=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks`,payload:{projectId:project.id,engine:'codex'}})).json();
    const run=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/runs`,payload:{prompt:'Draw',commandId:'draw'}})).json();
    await until(()=>fake.calls.length===1);
    const png=Buffer.from('89504e470d0a1a0a00000000','hex'),base64=png.toString('base64');
    fake.calls[0]!.emit({type:'image.generated',id:'native-image',base64});
    fake.calls[0]!.emit({type:'text.delta',text:'Here it is.'});
    fake.complete(run.id);await tick();
    const detail=app.ciel.store.detail(app.ciel.store.task(task.id)!);
    const message=detail.messages.find(item=>item.role==='assistant')!;
    expect(message.text).toBe('Here it is.');expect(message.images).toHaveLength(1);
    expect(JSON.stringify(detail.events)).not.toContain(base64);
    const url=`/api/v1/h/${h}/tasks/${task.id}/images/${message.images![0]!.id}`;
    const response=await app.inject({method:'GET',url});
    expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('image/png');expect(response.rawPayload).toEqual(png);
    expect((await app.inject({method:'GET',url:url.replace(`/tasks/${task.id}/`,`/tasks/${other.id}/`)})).statusCode).toBe(404);
    const follow=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/runs`,payload:{prompt:'Inspect that image',commandId:'inspect'}})).json();
    await until(()=>fake.calls.length===2);expect(fake.calls[1]?.localImages).toHaveLength(1);
    expect(fake.calls[1]!.localImages![0]).toMatch(/\.png$/);
    expect(readFileSync(fake.calls[1]!.localImages![0]!)).toEqual(png);
    fake.complete(follow.id);await tick();
    await app.close();
    const reopened=await createApp({dataDir,adapters:{codex:new FakeAdapter()},captureChanges:false});
    expect((await reopened.inject({method:'GET',url})).rawPayload).toEqual(png);await reopened.close();
  });
  it('recovers an image from a legacy Codex event and scrubs the event payload',()=>{
    const dir=makeDir(),dataDir=path.join(dir,'data'),store=new Store(dataDir);
    const project=store.addProject('P',dir),task=store.addTask(project.id,'T','codex',undefined,undefined,'full-access');
    const run={id:'run',taskId:task.id,hostId:store.hostId,engine:'codex' as const,permission:'full-access' as const,status:'completed' as const,prompt:'Draw',createdAt:new Date().toISOString(),commandId:'one'};
    store.addRun(run,'one');store.addMessage({id:'reply',taskId:task.id,runId:run.id,role:'assistant',text:'No image to show.',createdAt:new Date().toISOString()});
    const generated=path.join(dataDir,'engines','codex','generated_images','thread');mkdirSync(generated,{recursive:true});
    const file=path.join(generated,'image.png'),png=Buffer.from('89504e470d0a1a0a00000000','hex');writeFileSync(file,png);
    store.event(task.id,run.id,'tool.completed',{id:'native-image',output:'image data',native:{params:{item:{id:'native-image',type:'imageGeneration',status:'completed',result:png.toString('base64'),savedPath:file}}}});
    store.close();
    const restored=new Store(dataDir),detail=restored.detail(task),image=detail.messages.find(item=>item.id==='reply')?.images?.[0];
    expect(image).toBeDefined();expect(restored.image(task.id,image!.id)?.bytes).toEqual(png);
    const contextPath=restored.latestGeneratedImagePath(task.id,'next-run');
    expect(contextPath).toMatch(/\.png$/);expect(readFileSync(contextPath!)).toEqual(png);
    expect(JSON.stringify(detail.events)).not.toContain(png.toString('base64'));expect(JSON.stringify(detail.events)).not.toContain(file);
    restored.close();
  });
  it('runs separate sessions in the same folder concurrently while preserving turn order within one session',async()=>{
    const dir=makeDir(),folderA=path.join(dir,'a'),folderB=path.join(dir,'b');mkdirSync(folderA);mkdirSync(folderB);
    const fake=new FakeAdapter();const app=await createApp({dataDir:path.join(dir,'data'),adapters:{codex:fake},captureChanges:false});
    const host=app.ciel.host.id;
    const post=async(url:string,payload:Record<string,unknown>)=>await app.inject({method:'POST',url:`/api/v1/h/${host}${url}`,payload});
    const projectA=(await (await post('/projects',{name:'A',path:folderA})).json()).id;
    const projectB=(await (await post('/projects',{name:'B',path:folderB})).json()).id;
    const taskA=(await (await post('/tasks',{projectId:projectA,engine:'codex'})).json()).id;
    const taskA2=(await (await post('/tasks',{projectId:projectA,engine:'codex'})).json()).id;
    const taskB=(await (await post('/tasks',{projectId:projectB,engine:'codex',title:'My named session'})).json()).id;
    expect(app.ciel.store.task(taskA)?.title).toBe('New session');
    const first=(await post(`/tasks/${taskA}/runs`,{prompt:'first',commandId:'one'})).json();
    const duplicate=await post(`/tasks/${taskA}/runs`,{prompt:'first',commandId:'one'});
    expect(duplicate.statusCode).toBe(202);expect(duplicate.json().id).toBe(first.id);
    expect(app.ciel.store.task(taskA)?.title).toBe('first');
    expect((await post(`/tasks/${taskA}/runs`,{prompt:'different',commandId:'one'})).statusCode).toBe(409);
    const second=(await post(`/tasks/${taskA2}/runs`,{prompt:'second',commandId:'two'})).json();
    const third=(await post(`/tasks/${taskB}/runs`,{prompt:'third',commandId:'three'})).json();
    const followup=(await post(`/tasks/${taskA}/runs`,{prompt:'follow-up',commandId:'four'})).json();
    expect(app.ciel.store.task(taskB)?.title).toBe('My named session');
    await until(()=>fake.calls.length===3);expect(fake.calls.map(c=>c.runId).sort()).toEqual([first.id,second.id,third.id].sort());
    expect(app.ciel.store.run(followup.id)?.status).toBe('queued');
    fake.complete(first.id);await until(()=>fake.calls.some(c=>c.runId===followup.id));
    fake.complete(second.id);fake.complete(third.id);fake.complete(followup.id);await tick();
    expect(app.ciel.store.run(first.id)?.status).toBe('completed');
    await app.close();
  });
  it('keeps completion unread until an existing event cursor is explicitly marked read',async()=>{
    const dir=makeDir(),folder=path.join(dir,'folder');mkdirSync(folder);
    const fake=new FakeAdapter();const app=await createApp({dataDir:path.join(dir,'data'),adapters:{codex:fake},captureChanges:false});const h=app.ciel.host.id;
    const project=(await app.inject({method:'POST',url:`/api/v1/h/${h}/projects`,payload:{name:'P',path:folder}})).json();
    const task=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks`,payload:{projectId:project.id,engine:'codex'}})).json();
    const run=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/runs`,payload:{prompt:'hello',commandId:'x'}})).json();
    await tick();fake.complete(run.id);await tick();
    const unread=app.ciel.store.task(task.id)!;expect(unread.attentionSeq).toBeGreaterThan(unread.lastReadSeq);
    expect((await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/read`,payload:{seq:unread.attentionSeq+100}})).statusCode).toBe(400);
    expect(app.ciel.store.task(task.id)!.lastReadSeq).toBe(0);
    expect((await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/read`,payload:{seq:unread.attentionSeq}})).statusCode).toBe(200);
    expect(app.ciel.store.task(task.id)!.lastReadSeq).toBe(unread.attentionSeq);
    await app.close();
    const reopened=await createApp({dataDir:path.join(dir,'data'),adapters:{codex:new FakeAdapter()},captureChanges:false});
    expect(reopened.ciel.store.task(task.id)!.lastReadSeq).toBe(unread.attentionSeq);await reopened.close();
  });
  it('cancels queued work without starting it and waits for an active adapter to stop',async()=>{
    const dir=makeDir(),folder=path.join(dir,'folder');mkdirSync(folder);
    const fake=new FakeAdapter();const app=await createApp({dataDir:path.join(dir,'data'),adapters:{codex:fake},captureChanges:false});const h=app.ciel.host.id;
    const project=(await app.inject({method:'POST',url:`/api/v1/h/${h}/projects`,payload:{name:'P',path:folder}})).json();
    const task=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks`,payload:{projectId:project.id,engine:'codex'}})).json();
    const first=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/runs`,payload:{prompt:'first',commandId:'a'}})).json();
    const second=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/runs`,payload:{prompt:'second',commandId:'b'}})).json();
    await tick();expect(fake.calls).toHaveLength(1);
    await app.inject({method:'POST',url:`/api/v1/h/${h}/runs/${second.id}/interrupt`});
    expect(app.ciel.store.run(second.id)?.status).toBe('cancelled');expect(fake.calls).toHaveLength(1);
    await app.inject({method:'POST',url:`/api/v1/h/${h}/runs/${first.id}/interrupt`});await tick();
    expect(app.ciel.store.run(first.id)?.status).toBe('cancelled');
    await app.close();
  });
  it('interrupts unfinished runs on recovery without replay',()=>{
    const dir=makeDir(),store=new Store(path.join(dir,'data'));
    const project=store.addProject('P',dir),task=store.addTask(project.id,'T','codex',undefined,undefined,'full-access');
    const run={id:'run',taskId:task.id,hostId:store.hostId,engine:'codex' as const,permission:'full-access' as const,status:'running' as const,prompt:'edit',createdAt:new Date().toISOString(),commandId:'once'};
    store.addRun(run,'fingerprint');store.close();
    const reopened=new Store(path.join(dir,'data'));expect(reopened.run('run')?.status).toBe('interrupted');expect(reopened.task(task.id)?.attentionSeq).toBeGreaterThan(0);reopened.close();
  });
  it('allows only one live owner of a data directory',()=>{
    const dir=makeDir(),first=new Store(path.join(dir,'data'));
    expect(()=>new Store(path.join(dir,'data'))).toThrow(/already owns/);
    first.close();const second=new Store(path.join(dir,'data'));second.close();
  });
  it('serves previews on a separate authenticated port without forwarding CIEL credentials',async()=>{
    const dir=makeDir(),folder=path.join(dir,'folder');mkdirSync(folder);
    let receivedCookie='',receivedAuth='',wsCookie='',wsAuth='';const backendWebSockets=new Set<import('node:stream').Duplex>();
    const backend=createServer((req,res)=>{receivedCookie=String(req.headers.cookie??'');receivedAuth=String(req.headers.authorization??'');res.end('preview-ok');});
    backend.on('upgrade',(req,socket)=>{backendWebSockets.add(socket);socket.once('close',()=>backendWebSockets.delete(socket));socket.resume();wsCookie=String(req.headers.cookie??'');wsAuth=String(req.headers.authorization??'');const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);});
    await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));const backendPort=(backend.address() as {port:number}).port;
    const dataDir=path.join(dir,'data'),app=await createApp({dataDir,adapters:{codex:new FakeAdapter()},captureChanges:false});const h=app.ciel.host.id;
    const project=(await app.inject({method:'POST',url:`/api/v1/h/${h}/projects`,payload:{name:'P',path:folder}})).json();
    const created=await app.inject({method:'POST',url:`/api/v1/h/${h}/previews`,payload:{projectId:project.id,name:'Dev',port:backendPort}});
    expect(created.statusCode).toBe(201);const preview=created.json();
    const first=await fetch(preview.url,{redirect:'manual'}).catch(error=>{throw new Error(`initial preview fetch: ${String(error)}`)});expect(first.status).toBe(302);
    const cookie=first.headers.get('set-cookie')!.split(';')[0]!;
    const content=await fetch(new URL('/',preview.url),{headers:{cookie:`${cookie}; ciel_session=should-not-forward`,authorization:'Bearer should-not-forward',connection:'close'}}).catch(error=>{throw new Error(`authenticated preview fetch: ${String(error)}`)});
    expect(await content.text()).toBe('preview-ok');expect(receivedCookie).toBe('');expect(receivedAuth).toBe('');
    const proxy=new URL(preview.url);
    const handshake=await new Promise<string>((resolve,reject)=>{const socket=netConnect(Number(proxy.port),'127.0.0.1');socket.once('error',reject);socket.once('connect',()=>socket.write(`GET /socket HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: ${cookie}; ciel_session=should-not-forward\r\nAuthorization: Bearer should-not-forward\r\n\r\n`));socket.once('data',data=>{resolve(data.toString());socket.destroy();});});
    expect(handshake).toContain('101 Switching Protocols');expect(wsCookie).toBe('');expect(wsAuth).toBe('');
    await app.close();
    const reopened=await createApp({dataDir,adapters:{codex:new FakeAdapter()},captureChanges:false});
    expect(reopened.ciel.previews.list()[0]?.id).toBe(preview.id);
    const again=await new Promise<{status:number;text:string}>((resolve,reject)=>httpGet(new URL('/',preview.url),{headers:{cookie},agent:false},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode??0,text}));}).on('error',reject));
    expect(again.status).toBe(200);expect(again.text).toBe('preview-ok');
    await reopened.ciel.previews.stop(preview.id);await reopened.close();
    for(const socket of backendWebSockets)socket.destroy();
    await new Promise<void>(resolve=>backend.close(()=>resolve()));
  });
  it('hands visible history and intervening work to a different engine and back',async()=>{
    const dir=makeDir(),folder=path.join(dir,'folder');mkdirSync(folder);
    const codex=new FakeAdapter('codex'),claude=new FakeAdapter('claude');
    const app=await createApp({dataDir:path.join(dir,'data'),adapters:{codex,claude},captureChanges:false});const h=app.ciel.host.id;
    const project=(await app.inject({method:'POST',url:`/api/v1/h/${h}/projects`,payload:{name:'P',path:folder}})).json();
    const task=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks`,payload:{projectId:project.id,engine:'codex',model:'codex-only'}})).json();
    const submit=async(prompt:string,commandId:string,engine:EngineId)=>(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/runs`,payload:{prompt,commandId,engine}})).json();
    const first=await submit('Build the first thing','a','codex');await until(()=>codex.calls.length===1);
    expect(codex.calls[0]!.model).toBe('codex-only');
    expect((await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/runs`,payload:{prompt:'switch too early',commandId:'early',engine:'claude'}})).statusCode).toBe(409);
    codex.complete(first.id,'first result');await until(()=>app.ciel.store.run(first.id)?.status==='completed');
    const second=await submit('Continue with Claude','b','claude');await until(()=>claude.calls.length===1);
    expect(claude.calls[0]!.model).toBeUndefined();
    expect(claude.calls[0]!.prompt).toContain('Build the first thing');expect(claude.calls[0]!.prompt).toContain('first result');
    const historyPath=claude.calls[0]!.prompt.match(/(\/[^\s]+\.json)/)?.[1];expect(historyPath).toBeTruthy();
    expect(JSON.parse(readFileSync(historyPath!,'utf8')).runs).toHaveLength(2);expect(statSync(historyPath!).mode&0o777).toBe(0o600);
    claude.complete(second.id,'Claude result');await until(()=>app.ciel.store.run(second.id)?.status==='completed');
    const third=await submit('Return to Codex','c','codex');await until(()=>codex.calls.length===2);
    expect(codex.calls[1]!.sessionId).toBe(`native-${first.id}`);expect(codex.calls[1]!.prompt).toContain('Claude result');
    codex.complete(third.id);await until(()=>app.ciel.store.run(third.id)?.status==='completed');
    const reset=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/runs`,payload:{prompt:'Use default',commandId:'d',engine:'codex',model:null,effort:null}})).json();
    await until(()=>codex.calls.length===3);expect(codex.calls[2]!.model).toBeUndefined();expect(codex.calls[2]!.effort).toBeUndefined();
    codex.complete(reset.id);await until(()=>app.ciel.store.run(reset.id)?.status==='completed');await app.close();
  });
});
