import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, statSync } from 'node:fs';
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
  async status():Promise<EngineStatus>{return {id:this.id,name:'Fake test adapter',installed:true,authenticated:true,models:[],capabilities:{resume:true,approvals:true,modelDiscovery:false,permissions:['full-access'],nativeExtensions:false}};}
  async login(){return {status:'completed' as const,message:'Test only'};}
  run(input:EngineRunInput):Promise<EngineRunResult>{this.calls.push(input);return new Promise((resolve,reject)=>{this.pending.set(input.runId,{resolve,reject});input.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});}
  async approve(){}
  async dispose(){}
  complete(id:string,text='done'){this.pending.get(id)?.resolve({sessionId:`native-${id}`,text});this.pending.delete(id);}
}
const dirs:string[]=[];
const makeDir=()=>{const dir=mkdtempSync(path.join(os.tmpdir(),'ciel-host-test-'));dirs.push(dir);return dir;};
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const tick=async()=>{await new Promise(resolve=>setTimeout(resolve,10));};
const until=async(predicate:()=>boolean)=>{for(let i=0;i<100&&!predicate();i++)await tick();expect(predicate()).toBe(true);};

describe('host scheduler and persistence',()=>{
  it('serializes overlapping folders, runs independent folders, and deduplicates commands',async()=>{
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
    expect(app.ciel.store.task(taskB)?.title).toBe('My named session');
    await until(()=>fake.calls.length===2);expect(fake.calls.map(c=>c.runId).sort()).toEqual([first.id,third.id].sort());
    fake.complete(first.id);await until(()=>fake.calls.some(c=>c.runId===second.id));expect(fake.calls.map(c=>c.runId)).toContain(second.id);
    fake.complete(second.id);fake.complete(third.id);await tick();
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
    const first=await submit('Build the first thing','a','codex');await tick();
    expect(codex.calls[0]!.model).toBe('codex-only');
    expect((await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/runs`,payload:{prompt:'switch too early',commandId:'early',engine:'claude'}})).statusCode).toBe(409);
    codex.complete(first.id,'first result');await tick();
    const second=await submit('Continue with Claude','b','claude');await tick();
    expect(claude.calls[0]!.model).toBeUndefined();
    expect(claude.calls[0]!.prompt).toContain('Build the first thing');expect(claude.calls[0]!.prompt).toContain('first result');
    const historyPath=claude.calls[0]!.prompt.match(/(\/[^\s]+\.json)/)?.[1];expect(historyPath).toBeTruthy();
    expect(JSON.parse(readFileSync(historyPath!,'utf8')).runs).toHaveLength(2);expect(statSync(historyPath!).mode&0o777).toBe(0o600);
    claude.complete(second.id,'Claude result');await tick();
    const third=await submit('Return to Codex','c','codex');await tick();
    expect(codex.calls[1]!.sessionId).toBe(`native-${first.id}`);expect(codex.calls[1]!.prompt).toContain('Claude result');
    codex.complete(third.id);await tick();
    const reset=(await app.inject({method:'POST',url:`/api/v1/h/${h}/tasks/${task.id}/runs`,payload:{prompt:'Use default',commandId:'d',engine:'codex',model:null,effort:null}})).json();
    await tick();expect(codex.calls[2]!.model).toBeUndefined();expect(codex.calls[2]!.effort).toBeUndefined();
    codex.complete(reset.id);await tick();await app.close();
  });
});
