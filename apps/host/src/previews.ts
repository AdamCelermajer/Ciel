import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Preview } from '@ciel/contracts';
import { enableTailscale } from '../../../packages/platform/src/index.js';
import type { Store } from './store.js';

interface RecordValue { preview:Preview; token:string; proxyPort:number; command?:string; pid?:number; remoteUrl?:string }
const hash=(value:string)=>createHash('sha256').update(value).digest();
const equal=(a:string,b:string)=>timingSafeEqual(hash(a),hash(b));
const cookieName=(id:string)=>`ciel_preview_${id.replace(/-/g,'')}`;
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}};

export class PreviewManager {
  private servers=new Map<string,Server>();
  private sockets=new Map<string,Set<Duplex>>();
  private upstreamSockets=new Map<string,Set<Socket>>();
  private children=new Map<string,ChildProcess>();
  constructor(private store:Store,private controlPort:number) {
    store.db.exec('CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, value TEXT NOT NULL)');
  }
  private rows():RecordValue[] {return (this.store.db.prepare('SELECT value FROM previews').all() as {value:string}[]).map(r=>JSON.parse(r.value) as RecordValue);}
  private get(id:string):RecordValue|undefined {const row=this.store.db.prepare('SELECT value FROM previews WHERE id=?').get(id) as {value:string}|undefined;return row&&JSON.parse(row.value) as RecordValue;}
  private save(value:RecordValue) {this.store.db.prepare('INSERT INTO previews(id,project_id,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.preview.id,value.preview.projectId,JSON.stringify(value));}
  list():Preview[] {return this.rows().map(r=>r.preview);}
  async restore() {
    for(const value of this.rows()) {
      if(value.preview.status==='stopped'||value.preview.status==='failed')continue;
      if(value.command&&(!value.pid||!alive(value.pid))){value.preview.status='failed';value.preview.error='Managed preview process stopped while CIEL was offline';this.save(value);continue;}
      if(value.command){value.preview.status='registered';value.preview.error='CIEL cannot verify ownership of the process after restart; stopping this link will leave the server process running.';this.save(value);}
      try{await this.listen(value,value.proxyPort);}catch(error){value.preview.status='failed';value.preview.error=`Preview proxy could not restart: ${(error as Error).message}`;this.save(value);}
    }
  }
  private authorized(req:IncomingMessage,value:RecordValue):boolean {
    const cookies=String(req.headers.cookie??'').split(';').map(s=>s.trim());
    const candidate=cookies.find(s=>s.startsWith(`${cookieName(value.preview.id)}=`))?.slice(cookieName(value.preview.id).length+1);
    return Boolean(candidate&&equal(candidate,value.token));
  }
  private strippedHeaders(req:IncomingMessage,value:RecordValue):Record<string,string|string[]|undefined> {
    const headers:{[key:string]:string|string[]|undefined}={...req.headers};
    for(const key of ['cookie','authorization','proxy-authorization','x-ciel-token','x-forwarded-authorization','forwarded','host'])delete headers[key];
    headers.host=`127.0.0.1:${value.preview.port}`;
    if(headers.origin)headers.origin=`http://127.0.0.1:${value.preview.port}`;
    return headers;
  }
  private pathname(raw:string):string {const url=new URL(raw,'http://preview.invalid');url.searchParams.delete('ciel_preview');return url.pathname+(url.searchParams.size?`?${url.searchParams.toString()}`:'');}
  private handle(req:IncomingMessage,res:ServerResponse,value:RecordValue) {
    const url=new URL(req.url||'/','http://preview.invalid'),token=url.searchParams.get('ciel_preview');
    if(token&&equal(token,value.token)){
      res.writeHead(302,{'set-cookie':`${cookieName(value.preview.id)}=${value.token}; HttpOnly; SameSite=Strict; Path=/${value.remoteUrl?'; Secure':''}`,'location':this.pathname(req.url||'/'),'cache-control':'no-store'});res.end();return;
    }
    if(!this.authorized(req,value)){res.writeHead(401,{'content-type':'text/plain','cache-control':'no-store'});res.end('Preview access required');return;}
    const upstream=httpRequest({hostname:'127.0.0.1',port:value.preview.port,method:req.method,path:this.pathname(req.url||'/'),headers:this.strippedHeaders(req,value)},response=>{
      const headers={...response.headers};delete headers['set-cookie'];delete headers['www-authenticate'];
      res.writeHead(response.statusCode||502,headers);response.pipe(res);
    });
    upstream.on('error',error=>{if(!res.headersSent)res.writeHead(502,{'content-type':'text/plain'});res.end(`Preview server unavailable: ${error.message}`);});
    req.pipe(upstream);
  }
  private upgrade(req:IncomingMessage,socket:Duplex,head:Buffer,value:RecordValue) {
    if(!this.authorized(req,value)){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
    const upstream=netConnect(value.preview.port,'127.0.0.1');
    const upstreams=this.upstreamSockets.get(value.preview.id);upstreams?.add(upstream);upstream.once('close',()=>upstreams?.delete(upstream));
    upstream.once('connect',()=>{
      const headers=this.strippedHeaders(req,value);
      const lines=[`${req.method||'GET'} ${this.pathname(req.url||'/')} HTTP/1.1`,...Object.entries(headers).filter(([,v])=>v!==undefined).map(([key,val])=>`${key}: ${Array.isArray(val)?val.join(', '):val}`),'',''];
      upstream.write(lines.join('\r\n'));if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
    upstream.once('close',()=>socket.destroy());socket.once('close',()=>upstream.destroy());
  }
  private async listen(value:RecordValue,port:number):Promise<number> {
    const server=createServer((req,res)=>this.handle(req,res,value));
    const sockets=new Set<Duplex>();this.sockets.set(value.preview.id,sockets);this.upstreamSockets.set(value.preview.id,new Set());
    server.on('upgrade',(req,socket,head)=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));this.upgrade(req,socket,head,value);});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    this.servers.set(value.preview.id,server);return (server.address() as {port:number}).port;
  }
  async create(input:{projectId:string;name:string;port:number;command?:string;remote?:boolean}):Promise<Preview> {
    const project=this.store.project(input.projectId);if(!project)throw new Error('Project not found');
    if(input.port===this.controlPort)throw new Error('Preview target cannot be the CIEL control port');
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    const preview:Preview={id,projectId:project.id,name:input.name,port:input.port,status:input.command?'running':'registered'};
    const value:RecordValue={preview,token,proxyPort:0,command:input.command};
    value.proxyPort=await this.listen(value,0);
    const localUrl=`http://127.0.0.1:${value.proxyPort}`;
    if(input.remote){try{value.remoteUrl=(await enableTailscale(value.proxyPort,8500)).url;}catch(error){preview.error=`Private remote link unavailable: ${(error as Error).message}`;}}
    preview.url=`${value.remoteUrl??localUrl}/?ciel_preview=${encodeURIComponent(token)}`;
    if(input.command){
      const logDir=path.join(this.store.dataDir,'preview-logs');mkdirSync(logDir,{recursive:true,mode:0o700});const fd=openSync(path.join(logDir,`${id}.log`),'a',0o600);
      try{
        const child=spawn(input.command,{cwd:project.path,shell:true,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});
        if(!child.pid)throw new Error('Could not start preview command');
        value.pid=child.pid;this.children.set(id,child);child.unref();
        child.once('exit',(code,signal)=>{this.children.delete(id);const current=this.get(id);if(!current||current.preview.status==='stopped')return;current.preview.status='failed';current.preview.error=`Preview command exited (${code??signal??'unknown'})`;this.save(current);});
        child.once('error',error=>{const current=this.get(id);if(!current)return;current.preview.status='failed';current.preview.error=error.message;this.save(current);});
      }catch(error){preview.status='failed';preview.error=(error as Error).message;}finally{closeSync(fd);}
    }
    this.save(value);return preview;
  }
  async stop(id:string):Promise<Preview|undefined> {
    const value=this.get(id);if(!value)return;
    value.preview.status='stopped';this.save(value);
    const server=this.servers.get(id);if(server){for(const socket of this.sockets.get(id)??[])socket.destroy();for(const socket of this.upstreamSockets.get(id)??[])socket.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));this.servers.delete(id);this.sockets.delete(id);this.upstreamSockets.delete(id);}
    const child=this.children.get(id);
    if(child?.pid&&child.pid===value.pid){
      if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).unref();
      else try{process.kill(-child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
    }else if(value.command)value.preview.error='Preview link stopped. The server process may still be running because CIEL restarted.';
    this.save(value);this.children.delete(id);return value.preview;
  }
  async close() {for(const [id,server] of this.servers){for(const socket of this.sockets.get(id)??[])socket.destroy();for(const socket of this.upstreamSockets.get(id)??[])socket.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}this.servers.clear();this.sockets.clear();this.upstreamSockets.clear();}
}
