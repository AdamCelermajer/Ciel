import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineRunInput } from '@ciel/contracts';
import { jsonSafe, object, redactNative, string } from './common.js';

// The MCP subprocess has no access to CIEL internals. A one-run loopback bridge keeps
// permission requests pending until the host's approval endpoint answers them.
const MCP_BRIDGE = String.raw`
const readline = require('node:readline');
const url = process.env.CIEL_PERMISSION_URL;
const token = process.env.CIEL_PERMISSION_TOKEN;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const rl = readline.createInterface({input: process.stdin});
rl.on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const {id, method} = message;
  try {
    if (method === 'initialize') {
      send({jsonrpc:'2.0', id, result:{protocolVersion:'2025-06-18', capabilities:{tools:{}}, serverInfo:{name:'ciel-permissions', version:'0.1.0'}}});
    } else if (method === 'tools/list') {
      send({jsonrpc:'2.0', id, result:{tools:[{name:'approve',description:'Ask the CIEL user whether to permit a Claude Code tool call',inputSchema:{type:'object',properties:{tool_name:{type:'string'},input:{type:'object',additionalProperties:true}},required:['tool_name','input']}}]}});
    } else if (method === 'tools/call') {
      const response = await fetch(url, {method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify(message.params?.arguments ?? {})});
      if (!response.ok) throw new Error('CIEL permission bridge unavailable');
      const decision = await response.json();
      send({jsonrpc:'2.0', id, result:{content:[{type:'text',text:JSON.stringify(decision)}]}});
    } else {
      send({jsonrpc:'2.0', id, error:{code:-32601,message:'Method not found'}});
    }
  } catch (error) {
    send({jsonrpc:'2.0', id, result:{content:[{type:'text',text:JSON.stringify({behavior:'deny',message:String(error.message ?? error)})}],isError:false}});
  }
});
`;

type Pending = { resolve: (allowed: boolean) => void; input: Record<string, unknown> };

export class ClaudePermissionBridge {
  private server?: Server;
  private pending = new Map<string, Pending>();
  private readonly token = randomUUID();

  constructor(private readonly run: EngineRunInput, private readonly profile: string) {}

  async start(): Promise<{ config: string; tool: string }> {
    const script = join(this.profile, 'ciel-permission-bridge.cjs');
    await writeFile(script, MCP_BRIDGE, { mode: 0o600 });
    this.server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${this.token}`) {
        response.writeHead(403).end(); return;
      }
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 1024 * 1024) { response.writeHead(413).end(); return; }
      }
      let args: Record<string, unknown>;
      try { args = object(JSON.parse(body)); }
      catch { response.writeHead(400).end(); return; }
      const tool = string(args.tool_name) ?? 'tool';
      const toolInput = object(args.input);
      const id = `${this.run.runId}:${randomUUID()}`;
      const allowed = await new Promise<boolean>(resolve => {
        this.pending.set(id, { resolve, input: toolInput });
        this.run.emit({ type: 'approval', id, title: `Approve ${tool}`, description: jsonSafe(redactNative(toolInput)), choices: ['allow', 'deny'], native: redactNative(args) });
        response.on('close', () => { const pending = this.pending.get(id); if (pending) { this.pending.delete(id); pending.resolve(false); } });
      });
      if (response.destroyed) return;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(allowed ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: 'Denied in CIEL' }));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Claude permission bridge failed to bind');
    const config = JSON.stringify({ mcpServers: { ciel_permission: {
      command: process.execPath,
      args: [script],
      env: { CIEL_PERMISSION_URL: `http://127.0.0.1:${address.port}`, CIEL_PERMISSION_TOKEN: this.token },
    } } });
    return { config, tool: 'mcp__ciel_permission__approve' };
  }

  approve(id: string, decision: string): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    if (!['allow', 'deny'].includes(decision)) throw new Error('Unsupported Claude approval decision');
    this.pending.delete(id);
    pending.resolve(decision === 'allow');
    return true;
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) pending.resolve(false);
    this.pending.clear();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}
