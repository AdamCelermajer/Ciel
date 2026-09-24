import path from 'node:path';
import os from 'node:os';
import { createApp } from './app.js';
import { HostGateway } from '../../../packages/transport/src/index.js';
import { RuntimeManager, enableTailscale } from '../../../packages/platform/src/index.js';
import { ENGINE_IDS, type EngineId } from '@ciel/contracts';
import { CielUpdater } from './update.js';

async function main() {
process.env.PATH = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter).filter(entry=>entry!==path.dirname(process.execPath))].join(path.delimiter);
const defaultDataDir=process.platform==='win32'
  ? path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'CIEL','data')
  : path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'),'ciel');
const dataDir=process.env.CIEL_DATA_DIR || defaultDataDir;
const port=Number(process.env.CIEL_PORT || '4317');
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('CIEL_PORT must be a valid TCP port');
const remotePort=Number(process.env.CIEL_REMOTE_PORT || String(port+1));
if(!Number.isInteger(remotePort)||remotePort<1||remotePort>65535||remotePort===port)throw new Error('CIEL_REMOTE_PORT must be a distinct valid TCP port');
let gateway:HostGateway;
const app=await createApp({dataDir,port,
  configure:async(server,context)=>{
    gateway=new HostGateway(dataDir,context.host);await gateway.register(server);await gateway.startRemoteIngress(port,remotePort);server.addHook('onClose',async()=>gateway.close());
    const runtimes=new RuntimeManager(dataDir,engine=>context.scheduler.isEngineBusy(engine));
    const updater=new CielUpdater(dataDir,port,()=>context.store.settings().updateDirectory,()=>context.store.runs().some(run=>['queued','running','waiting'].includes(run.status)));
    server.addHook('preHandler',async(request,reply)=>{
      if(updater.isPending()&&request.method==='POST'&&/^\/api\/v1\/h\/[^/]+\/tasks\/[^/]+\/runs$/.test(request.url))return reply.code(503).send({error:'CIEL is restarting for an update. Try again after it reconnects.'});
    });
    const updating=new Set<EngineId>();
    const installEngine=async(id:EngineId)=>{
      if(updating.has(id))throw new Error('Engine installation is already running');
      if(context.scheduler.isEngineBusy(id))throw new Error('Engine has active or queued runs');
      updating.add(id);context.scheduler.setEngineMaintenance(id,true);
      try{await context.pauseEngine(id);return await runtimes.install(id);}
      finally{context.resumeEngine(id);updating.delete(id);context.scheduler.setEngineMaintenance(id,false);}
    };
    const base='/api/v1/h/:hostId';
    const local=(raw:unknown)=>(raw as {hostId?:string}).hostId===context.host.id;
    const engine=(raw:unknown):EngineId|undefined=>{const id=(raw as {engine?:string}).engine;return ENGINE_IDS.find(value=>value===id);};
    server.get(`${base}/updates`,async(request,reply)=>local(request.params)?updater.status():reply.code(404).send({error:'Host not found'}));
    server.post(`${base}/updates/apply`,async(request,reply)=>{
      if(!local(request.params))return reply.code(404).send({error:'Host not found'});
      try{return reply.code(202).send(await updater.apply());}
      catch(error){return reply.code(409).send({error:(error as Error).message});}
    });
    server.get(`${base}/runtimes`,async(request,reply)=>local(request.params)?runtimes.status():reply.code(404).send({error:'Host not found'}));
    server.post(`${base}/runtimes/:engine/check`,async(request,reply)=>{if(!local(request.params))return reply.code(404).send({error:'Host not found'});const id=engine(request.params);if(!id)return reply.code(400).send({error:'Invalid engine'});return runtimes.check(id);});
    server.post(`${base}/runtimes/:engine/install`,async(request,reply)=>{
      if(!local(request.params))return reply.code(404).send({error:'Host not found'});
      const id=engine(request.params);if(!id)return reply.code(400).send({error:'Invalid engine'});
      if(updating.has(id)||context.scheduler.isEngineBusy(id))return reply.code(409).send({error:'Engine is busy or updating'});
      void installEngine(id).catch(error=>server.log.error(error));
      return reply.code(202).send({engine:id,state:'checking'});
    });
    server.get(`${base}/network`,async(request,reply)=>local(request.params)?context.store.network()??{url:null,port:null}:reply.code(404).send({error:'Host not found'}));
    server.post(`${base}/network/enable`,async(request,reply)=>{
      if(!local(request.params))return reply.code(404).send({error:'Host not found'});
      try{const result=await enableTailscale(remotePort,8443,port);context.store.setNetwork(result);return result;}
      catch(error){return reply.code(503).send({error:(error as Error).message});}
    });
    const updateTimer=setInterval(()=>{
      if(!context.store.settings().autoUpdate)return;
      void (async()=>{
        for(const installed of await runtimes.status()){
          if(!installed.installedVersion||updating.has(installed.engine)||context.scheduler.isEngineBusy(installed.engine))continue;
          const checked=await runtimes.check(installed.engine);
          if(checked.latestVersion&&checked.latestVersion!==installed.installedVersion&&!context.scheduler.isEngineBusy(installed.engine))await installEngine(installed.engine);
        }
      })().catch(error=>server.log.error(error));
    },6*60*60*1000);updateTimer.unref();server.addHook('onClose',async()=>clearInterval(updateTimer));
  },
  listHosts:()=>gateway.listHosts(),
});
for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{void app.close().finally(()=>process.exit(0));});
await app.listen({host:'127.0.0.1',port});
process.stdout.write(`CIEL host listening on http://127.0.0.1:${port}\n`);
}

void main().catch(error=>{process.stderr.write(`CIEL host failed: ${(error as Error).message}\n`);process.exitCode=1;});
