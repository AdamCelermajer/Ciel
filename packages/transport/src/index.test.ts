import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { HostGateway } from './index.js';

const roots:string[]=[];
const temp=()=>{const dir=mkdtempSync(path.join(os.tmpdir(),'ciel-transport-test-'));roots.push(dir);return dir;};
afterEach(()=>{for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});

async function host(name:string) {
  const dir=temp(),id=randomUUID(),app=Fastify({forceCloseConnections:true});
  const gateway=new HostGateway(dir,{id,name,platform:'linux',version:'test',online:true,local:true});
  await gateway.register(app);
  app.get('/api/v1/h/:hostId/tasks/:id',async request=>({owner:id,taskId:(request.params as {id:string}).id}));
  app.get('/api/v1/h/:hostId/tasks/:id/images/:imageId',async(_request,reply)=>reply.type('image/png').send(Buffer.from([137,80,78,71,13,10,26,10,255,0,128])));
  app.post('/api/v1/h/:hostId/ping', async () => ({ ok: true }));
  app.get('/api/v1/h/:hostId/events',async(request,reply)=>{
    const query=request.query as {after?:string;hold?:string};const after=Number(query.after??request.headers['last-event-id']??0);
    reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream'});
    reply.raw.write(`id: ${after+1}\nevent: host-event\ndata: ${JSON.stringify({hostId:id,seq:after+1})}\n\n`);
    if(!query.hold)setTimeout(()=>reply.raw.end(),5);
  });
  await app.listen({host:'127.0.0.1',port:0});
  const port=(app.server.address() as {port:number}).port;
  const remotePort=await gateway.startRemoteIngress(port,0);
  const local=`http://127.0.0.1:${port}`,remote=`http://127.0.0.1:${remotePort}`;
  const bootstrap=await fetch(`${local}/api/v1/bootstrap`,{method:'POST'});
  const cookie=bootstrap.headers.get('set-cookie')!.split(';')[0]!;
  return {dir,id,app,gateway,local,remote,cookie,close:async()=>{await gateway.close();await app.close();}};
}

it('keeps bootstrap local, routes only the selected host, resumes SSE, and revokes unpaired tokens',async()=>{
  const a=await host('A'),b=await host('B');
  try{
    expect((await fetch(`${b.remote}/api/v1/bootstrap`,{method:'POST',headers:{host:'127.0.0.1'}})).status).toBe(404);
    expect((await fetch(`${b.remote}/api/v1/hosts`)).status).toBe(404);
    expect((await fetch(`${b.local}/api/v1/bootstrap`,{method:'POST',headers:{'x-forwarded-for':'127.0.0.1'}})).status).toBe(401);
    const pairing=await fetch(`${b.local}/api/v1/pairing`,{method:'POST',headers:{cookie:b.cookie}});
    const {code}=await pairing.json() as {code:string};
    const paired=await fetch(`${a.local}/api/v1/hosts`,{method:'POST',headers:{cookie:a.cookie,'content-type':'application/json'},body:JSON.stringify({url:b.remote,code})});
    expect(paired.status).toBe(200);expect((await paired.json() as {id:string}).id).toBe(b.id);
    const own=await fetch(`${a.local}/api/v1/h/${a.id}/tasks/shared`,{headers:{cookie:a.cookie}});
    const remote=await fetch(`${a.local}/api/v1/h/${b.id}/tasks/shared`,{headers:{cookie:a.cookie}});
    expect((await own.json() as {owner:string}).owner).toBe(a.id);
    expect((await remote.json() as {owner:string}).owner).toBe(b.id);
    const image=await fetch(`${a.local}/api/v1/h/${b.id}/tasks/shared/images/generated`,{headers:{cookie:a.cookie}});
    expect(image.headers.get('content-type')).toContain('image/png');expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from([137,80,78,71,13,10,26,10,255,0,128]));
    expect((await fetch(`${a.local}/api/v1/h/${b.id}/ping`,{method:'POST',headers:{cookie:a.cookie}})).status).toBe(200);
    const first=await fetch(`${a.local}/api/v1/h/${b.id}/events?after=0`,{headers:{cookie:a.cookie}});
    expect(first.headers.get('content-type')).toContain('text/event-stream');expect(await first.text()).toContain('id: 1');
    const second=await fetch(`${a.local}/api/v1/h/${b.id}/events?after=1`,{headers:{cookie:a.cookie}});
    expect(await second.text()).toContain('id: 2');
    const headerResume=await fetch(`${a.local}/api/v1/h/${b.id}/events`,{headers:{cookie:a.cookie,'last-event-id':'2'}});
    expect(await headerResume.text()).toContain('id: 3');
    for(let i=0;i<3;i++){
      const controller=new AbortController();
      const live=await fetch(`${a.local}/api/v1/h/${b.id}/events?hold=1`,{headers:{cookie:a.cookie},signal:controller.signal});
      expect((await live.body!.getReader().read()).value?.length).toBeGreaterThan(0);
      controller.abort();
    }
    await new Promise(resolve=>setTimeout(resolve,20));
    expect((await fetch(`${a.local}/api/v1/h/${a.id}/tasks/still-alive`,{headers:{cookie:a.cookie}})).status).toBe(200);
    const token=(JSON.parse(readFileSync(path.join(a.dir,'connections.json'),'utf8')) as {peers:{token:string}[]}).peers[0]!.token;
    expect((await fetch(`${b.remote}/api/v1/h/${b.id}/tasks/shared`,{headers:{authorization:`Bearer ${token}`}})).status).toBe(200);
    const removed=await fetch(`${a.local}/api/v1/hosts/${b.id}`,{method:'DELETE',headers:{cookie:a.cookie}});
    expect((await removed.json() as {revokedRemote:boolean}).revokedRemote).toBe(true);
    expect((await fetch(`${b.remote}/api/v1/h/${b.id}/tasks/shared`,{headers:{authorization:`Bearer ${token}`}})).status).toBe(401);
  }finally{await a.close();await b.close();}
});

it('reports a paired host offline when it stops responding and online after it returns',async()=>{
  const a=await host('A'),b=await host('B');
  try{
    const pairing=await fetch(`${b.local}/api/v1/pairing`,{method:'POST',headers:{cookie:b.cookie}});
    const {code}=await pairing.json() as {code:string};
    const paired=await fetch(`${a.local}/api/v1/hosts`,{method:'POST',headers:{cookie:a.cookie,'content-type':'application/json'},body:JSON.stringify({url:b.remote,code})});
    expect(paired.status).toBe(200);
    expect((await a.gateway.listHosts()).find(item=>item.id===b.id)?.online).toBe(true);

    await b.gateway.close();
    expect((await a.gateway.listHosts()).find(item=>item.id===b.id)?.online).toBe(false);

    await b.gateway.startRemoteIngress(Number(new URL(b.local).port),Number(new URL(b.remote).port));
    expect((await a.gateway.listHosts()).find(item=>item.id===b.id)?.online).toBe(true);
  }finally{await a.close();await b.close();}
});

it('rejects malformed pairing responses and reports a local forget when the peer is offline',async()=>{
  const a=await host('A'),b=await host('B');
  const malformed=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end('{"host":{},"token":"bad"}');});
  await new Promise<void>(resolve=>malformed.listen(0,'127.0.0.1',resolve));
  try{
    const port=(malformed.address() as {port:number}).port;
    const bad=await fetch(`${a.local}/api/v1/hosts`,{method:'POST',headers:{cookie:a.cookie,'content-type':'application/json'},body:JSON.stringify({url:`http://127.0.0.1:${port}`,code:'anything'})});
    expect(bad.status).toBe(400);
    const pairing=await fetch(`${b.local}/api/v1/pairing`,{method:'POST',headers:{cookie:b.cookie}});
    const {code}=await pairing.json() as {code:string};
    expect((await fetch(`${a.local}/api/v1/hosts`,{method:'POST',headers:{cookie:a.cookie,'content-type':'application/json'},body:JSON.stringify({url:b.remote,code})})).status).toBe(200);
    await b.close();
    const result=await fetch(`${a.local}/api/v1/hosts/${b.id}`,{method:'DELETE',headers:{cookie:a.cookie}});
    expect(await result.json()).toMatchObject({forgottenLocally:true,revokedRemote:false});
  }finally{await a.close();await new Promise<void>(resolve=>malformed.close(()=>resolve()));}
});
