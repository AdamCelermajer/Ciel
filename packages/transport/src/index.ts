import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HostInfo, HostConnection } from '@ciel/contracts';
import { z } from 'zod';

interface Peer { host: HostConnection; token: string }
interface Credentials { localToken: string; incoming: string[]; peers: Peer[] }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const localHostname = (name: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(name);
const pairedHostSchema = z.object({id:z.string().uuid(),name:z.string().min(1).max(120),platform:z.string().min(1).max(100),version:z.string().min(1).max(100),online:z.boolean(),local:z.boolean()});

export class HostGateway {
  private file: string;
  private credentials: Credentials;
  private remoteServer?: HttpServer;
  private streams=new Set<()=>void>();
  private pairing?: { hash: string; expires: number };
  private pairAttempts: number[] = [];
  constructor(dataDir: string, private local: HostInfo) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 }); this.file = path.join(dataDir, 'connections.json');
    try { this.credentials = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Host connection storage is unreadable.', { cause: error });
      this.credentials = { localToken: randomBytes(32).toString('base64url'), incoming: [], peers: [] }; this.save();
    }
  }
  private save() { const tmp = this.file + '.tmp'; writeFileSync(tmp, JSON.stringify(this.credentials), { mode: 0o600 }); renameSync(tmp, this.file); }
  async listHosts(): Promise<HostConnection[]> {
    const peers = await Promise.all(this.credentials.peers.map(async peer => {
      let online = false;
      try {
        const response = await fetch(new URL('/api/v1/health', peer.host.url), {
          signal: AbortSignal.timeout(3000), redirect: 'error',
        });
        if (response.ok) {
          const result = z.object({ host: pairedHostSchema }).safeParse(await response.json());
          online = result.success && result.data.host.id === peer.host.id;
        }
      } catch { /* A failed health check means this peer is unavailable. */ }
      peer.host.online = online;
      if (online) peer.host.lastSeenAt = new Date().toISOString();
      return { ...peer.host, local: false };
    }));
    return [{ ...this.local, local: true, online: true }, ...peers];
  }
  private validToken(token: string) { return same(token, this.credentials.localToken) || this.credentials.incoming.includes(digest(token)); }
  async startRemoteIngress(controlPort:number,ingressPort:number):Promise<number> {
    if(this.remoteServer)return (this.remoteServer.address() as {port:number}).port;
    if(!Number.isInteger(ingressPort)||ingressPort<0||ingressPort>65535||ingressPort===controlPort)throw new Error('Invalid CIEL remote ingress port');
    const allowed=(raw:string)=>{
      const pathname=raw.split('?')[0];
      return pathname==='/api/v1/health'||pathname==='/api/v1/pair'||pathname==='/api/v1/revoke'||pathname.startsWith('/api/v1/h/');
    };
    const server=createServer((req,res)=>{
      if(!allowed(req.url??'/')){res.writeHead(404,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:'Not found'}));return;}
      const headers:Record<string,string|string[]|undefined>={...req.headers,host:`127.0.0.1:${controlPort}`};
      for(const key of ['cookie','proxy-authorization','x-forwarded-for','x-forwarded-host','x-forwarded-proto','forwarded','x-real-ip'])delete headers[key];
      headers['x-ciel-remote-ingress']='1';
      const upstream=httpRequest({hostname:'127.0.0.1',port:controlPort,method:req.method,path:req.url,headers},response=>{
        const responseHeaders={...response.headers};delete responseHeaders['set-cookie'];
        res.writeHead(response.statusCode??502,responseHeaders);response.pipe(res);
      });
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'Local CIEL host unavailable'}));});
      res.once('close',()=>upstream.destroy());req.pipe(upstream);
    });
    server.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'));
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(ingressPort,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    this.remoteServer=server;
    return (server.address() as {port:number}).port;
  }
  async close():Promise<void> {for(const stop of this.streams)stop();this.streams.clear();const server=this.remoteServer;if(!server)return;this.remoteServer=undefined;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  private originAllowed(req: FastifyRequest) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const url = new URL(origin);
      const requestHost = String(req.headers.host ?? '');
      return url.host === requestHost || (localHostname(url.hostname) && localHostname(new URL(`http://${requestHost}`).hostname) && ['4317', '5173', ''].includes(url.port));
    } catch { return false; }
  }
  async register(app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      reply.header('cache-control', 'no-store');
      if (!this.originAllowed(req)) return reply.code(403).send({ error: 'This origin is not allowed.' });
      const pathname = req.url.split('?')[0];
      if (pathname === '/api/v1/health' || pathname === '/api/v1/pair') return;
      if (pathname === '/api/v1/bootstrap') {
        let hostname = '';
        try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { /* rejected below */ }
        const forwarded = ['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip','x-ciel-remote-ingress'].some(key=>req.headers[key]!==undefined);
        if (!localHostname(hostname)||forwarded||!localHostname(req.socket.remoteAddress??'')) return reply.code(401).send({ error: 'Open CIEL on this device first, then pair the remote host.' });
        return;
      }
      const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      const cookie = String(req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('ciel_session='))?.slice('ciel_session='.length) ?? '';
      if (!this.validToken(bearer || cookie)) return reply.code(401).send({ error: 'Open the local CIEL app to connect.' });
    });
    app.post('/api/v1/bootstrap', async (_req, reply) => {
      reply.header('set-cookie', `ciel_session=${this.credentials.localToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
      return { hostId: this.local.id };
    });
    app.get('/api/v1/health', async () => ({ host: this.local }));
    app.post('/api/v1/pairing', async () => {
      const code = randomBytes(9).toString('base64url'); const expires = Date.now() + 300000;
      this.pairing = { hash: digest(code), expires };
      return { code, expiresAt: new Date(expires).toISOString() };
    });
    app.post('/api/v1/pair', async (req, reply) => {
      this.pairAttempts = this.pairAttempts.filter(t => Date.now() - t < 60000);
      if (this.pairAttempts.length >= 10) return reply.code(429).send({ error: 'Too many pairing attempts. Try again in a minute.' });
      this.pairAttempts.push(Date.now());
      const body = z.object({ code: z.string().max(128) }).safeParse(req.body);
      if (!body.success || !this.pairing || this.pairing.expires < Date.now() || !same(digest(body.data.code), this.pairing.hash)) return reply.code(403).send({ error: 'Pairing code is invalid or expired.' });
      this.pairing = undefined;
      const token = randomBytes(32).toString('base64url'); this.credentials.incoming.push(digest(token)); this.save();
      return { host: this.local, token };
    });
    app.post('/api/v1/revoke',async(req,reply)=>{
      const token=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
      const tokenHash=digest(token);
      if(!token||!this.credentials.incoming.includes(tokenHash))return reply.code(403).send({error:'Pairing token not found'});
      this.credentials.incoming=this.credentials.incoming.filter(value=>value!==tokenHash);this.save();
      return {ok:true};
    });
    app.post('/api/v1/hosts', async (req, reply) => {
      const body = z.object({ url: z.string().url(), code: z.string().min(1).max(128) }).parse(req.body);
      const url = new URL(body.url);
      if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return reply.code(400).send({ error: 'Use the host base URL without a path or credentials.' });
      if (!(url.protocol === 'https:' && url.hostname.endsWith('.ts.net')) && !(url.protocol === 'http:' && localHostname(url.hostname))) return reply.code(400).send({ error: 'Use a private Tailscale HTTPS URL (or localhost for local testing).' });
      let response:Response;
      try{response=await fetch(new URL('/api/v1/pair', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: body.code }), signal: AbortSignal.timeout(15000), redirect: 'error' });}
      catch{return reply.code(502).send({error:'Remote host could not be reached for pairing.'});}
      let raw:unknown;
      try{raw=await response.json();}catch{return reply.code(400).send({error:'Remote host returned an invalid pairing response.'});}
      const parsed=z.object({host:pairedHostSchema,token:z.string().min(16).max(512)}).safeParse(raw);
      if(!response.ok||!parsed.success)return reply.code(400).send({error:'Remote host rejected pairing or returned invalid host credentials.'});
      const result=parsed.data;
      if (result.host.id === this.local.id) return reply.code(400).send({ error: 'This is already your local host.' });
      const host: HostConnection = { ...result.host, local: false, online: true, url: url.origin, lastSeenAt: new Date().toISOString() };
      this.credentials.peers = this.credentials.peers.filter(p => p.host.id !== host.id);
      this.credentials.peers.push({ host, token: result.token }); this.save();
      return host;
    });
    app.delete('/api/v1/hosts/:id', async req => {
      const { id } = req.params as { id: string };
      const peer=this.credentials.peers.find(p=>p.host.id===id);
      if(!peer)return {ok:true,forgottenLocally:false,revokedRemote:false};
      let revokedRemote=false;
      try{
        const response=await fetch(new URL('/api/v1/revoke',peer.host.url),{method:'POST',headers:{authorization:`Bearer ${peer.token}`},signal:AbortSignal.timeout(5000),redirect:'error'});
        revokedRemote=response.ok;
      }catch{/* Host may be offline; local credentials are still removed. */}
      this.credentials.peers = this.credentials.peers.filter(p => p.host.id !== id); this.save();
      return {ok:true,forgottenLocally:true,revokedRemote,...(!revokedRemote?{warning:'Remote host was unavailable or could not revoke its token. This host forgot the connection locally.'}:{})};
    });
    // Fixed paired-host routing: a client cannot turn this into an arbitrary URL proxy.
    app.addHook('preHandler', async (req, reply) => {
      const match = req.url.match(/^\/api\/v1\/h\/([^/?]+)(?:\/|$)/);
      if (!match || decodeURIComponent(match[1]!) === this.local.id) return;
      const id = decodeURIComponent(match[1]!); const peer = this.credentials.peers.find(p => p.host.id === id);
      if (!peer) return reply.code(404).send({ error: 'Host is not paired.' });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const close = () => controller.abort(); reply.raw.once('close', close);
      try {
        const response = await fetch(new URL(req.url, peer.host.url), {
          method: req.method, headers: { authorization: `Bearer ${peer.token}`, ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),...(typeof req.headers['last-event-id']==='string'?{'last-event-id':req.headers['last-event-id']}:{}) },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body),
          signal: controller.signal, redirect: 'error',
        });
        clearTimeout(timeout); peer.host.online = true; peer.host.lastSeenAt = new Date().toISOString();
        reply.code(response.status);
        const contentType = response.headers.get('content-type') ?? 'application/json'; reply.header('content-type', contentType);
        if (contentType.includes('text/event-stream')) {
          reply.hijack();
          reply.raw.writeHead(response.status,{'content-type':contentType,'cache-control':'no-cache','x-accel-buffering':'no'});
          const reader=response.body?.getReader();
          if(!reader){reply.raw.end();return reply;}
          const onClose=()=>{controller.abort();void reader.cancel().catch(()=>{});if(!reply.raw.destroyed)reply.raw.destroy();};
          this.streams.add(onClose);
          reply.raw.once('close',onClose);
          void (async()=>{
            try{while(true){
              const chunk=await reader.read();if(chunk.done||reply.raw.destroyed)break;
              if(!reply.raw.write(Buffer.from(chunk.value)))await new Promise<void>(resolve=>{
                const done=()=>{reply.raw.off('drain',done);reply.raw.off('close',done);resolve();};
                reply.raw.once('drain',done);reply.raw.once('close',done);
              });
            }}
            catch{/* Viewer disconnects do not fail the host API. */}
            finally{controller.abort();this.streams.delete(onClose);reply.raw.off('close',onClose);if(!reply.raw.destroyed&&!reply.raw.writableEnded)reply.raw.end();}
          })();
          return reply;
        }
        const body = contentType.startsWith('image/') ? Buffer.from(await response.arrayBuffer()) : await response.text(); reply.raw.removeListener('close', close);
        return reply.send(body);
      } catch {
        clearTimeout(timeout); peer.host.online = false;
        if (reply.raw.destroyed||reply.raw.headersSent)return reply;
        return reply.code(502).send({ error: `${peer.host.name} is unavailable. Its tasks remain on that computer.` });
      }
    });
  }
}
