import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/codex.js';
import type { AdapterEvent } from '@ciel/contracts';

const adapters: CodexAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.dispose())); });

async function fakeCodex(auth: 'chatgpt' | 'apiKey' = 'chatgpt', activity = false, image = false, duplicate = false) {
  const dir = await mkdtemp(join(tmpdir(), 'ciel-codex-test-'));
  const binary = join(dir, 'codex-fake');
  const generatedPath=join(dir,'generated.png');
  if(image)await writeFile(generatedPath,Buffer.from('89504e470d0a1a0a00000000','hex'));
  await writeFile(binary, `#!/usr/bin/env node
const readline = require('node:readline');
const activity = ${activity};
const image = ${image};
const duplicate = ${duplicate};
const generatedPath = ${JSON.stringify(generatedPath)};
const logPath = ${JSON.stringify(join(dir,'protocol.jsonl'))};
if (process.argv.includes('--version')) { console.log('codex-cli test'); process.exit(0); }
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  const {method,id,params={}} = msg;
  if (method === 'turn/start' || method === 'turn/steer') require('node:fs').appendFileSync(logPath,JSON.stringify({method,params})+'\\n');
  if (method === 'initialize') send({id,result:{}});
  if (method === 'account/read') send({id,result:{account:{type:'${auth}',email:'test@example.invalid'},requiresOpenaiAuth:true}});
  if (method === 'model/list') send({id,result:{data:[{id:'gpt-test',displayName:'Test model'}]}});
  if (method === 'account/login/start') send({id,result:{type:'chatgptDeviceCode',verificationUrl:'https://example.invalid/device',userCode:'ABCD-1234'}});
  if (method === 'thread/start' || method === 'thread/resume') send({id,result:{thread:{id:'thread-1'}}});
  if (method === 'turn/start') {
    send({id,result:{turn:{id:'turn-1'}}});
    if (activity) {
      const emit = (method,item) => send({method,params:{threadId:'thread-1',turnId:'turn-1',item}});
      for (const type of ['userMessage','hookPrompt','plan','reasoning','functionCallOutput','subAgentActivity']) {
        emit('item/started',{id:type,type}); emit('item/completed',{id:type,type});
      }
      const tools = [
        {id:'mcp-1',type:'mcpToolCall',server:'filesystem',tool:'read_file',status:'completed'},
        {id:'dynamic-1',type:'dynamicToolCall',namespace:'browser',tool:'click',status:'completed'},
        {id:'command-1',type:'commandExecution',command:'pwd',status:'completed',exitCode:0},
        {id:'command-error',type:'commandExecution',command:'false',status:'completed',exitCode:1},
        {id:'mcp-error',type:'mcpToolCall',server:'filesystem',tool:'read_file',status:'completed',error:{message:'not found'}},
        {id:'dynamic-error',type:'dynamicToolCall',namespace:'browser',tool:'click',status:'completed',success:false},
      ];
      for (const item of tools) { emit('item/started',item); emit('item/started',item); emit('item/completed',item); emit('item/completed',item); }
      if (image) { const item={id:'image-1',type:'imageGeneration',status:'completed',result:'aGVsbG8=',savedPath:generatedPath}; emit('item/started',{...item,result:null,savedPath:null});emit('item/completed',item); }
      if (duplicate) {
        for (const itemId of ['message-1','message-2']) {
          for (const delta of ['Hi!',' What would you like to work on?']) send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId,delta}});
          emit('item/completed',{id:itemId,type:'agentMessage',status:'completed'});
        }
      } else {
        send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'message-1',delta:'A fruit.'}});
        send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'message-2',delta:'Le pommier.'}});
      }
      if (image) setTimeout(()=>send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}}),30);
      else send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
    } else send({method:'item/commandExecution/requestApproval',id:999,params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-1',reason:'Run a command',command:'pwd'}});
  }
  if (method === 'turn/steer') send({id,result:{turnId:'turn-1'}});
  if (id === 999 && msg.result?.decision === 'accept') {
    send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'answer',delta:'Done'}});
    send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  }
});

`, { mode: 0o755 });
  const adapter = new CodexAdapter({ dataDir: join(dir, 'data'), binaries: { codex: binary } });
  adapters.push(adapter);
  return Object.assign(adapter,{fixtureDir:dir,generatedPath});
}

test('Codex forwards generated images without storing image bytes in tool activity', async () => {
  const adapter = await fakeCodex('chatgpt', true, true);
  const events: AdapterEvent[] = [];
  await adapter.run({ taskId:'task',runId:'run',cwd:tmpdir(),prompt:'Generate an image',permission:'full-access',signal:new AbortController().signal,emit:event=>events.push(event) });
  const generated=events.find(event=>event.type==='image.generated');
  expect(generated).toMatchObject({type:'image.generated',id:'image-1',base64:'aGVsbG8=',savedPath:adapter.generatedPath});
  const completed=events.find(event=>event.type==='tool.completed'&&event.id==='image-1');
  expect(JSON.stringify(completed)).not.toContain('aGVsbG8=');
  expect(JSON.stringify(completed)).not.toContain(adapter.generatedPath);
  const requests=(await readFile(join(adapter.fixtureDir,'protocol.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(requests).toContainEqual(expect.objectContaining({method:'turn/steer',params:expect.objectContaining({expectedTurnId:'turn-1',input:expect.arrayContaining([{type:'localImage',path:adapter.generatedPath}])})}));
});

test('Codex steers text into the active native turn', async () => {
  const adapter=await fakeCodex();
  const events:AdapterEvent[]=[];
  const run=adapter.run({taskId:'task',runId:'run',cwd:tmpdir(),prompt:'First request',permission:'full-access',signal:new AbortController().signal,emit:event=>events.push(event)});
  for(let attempt=0;attempt<100&&!events.some(event=>event.type==='approval');attempt++)await new Promise(resolve=>setTimeout(resolve,10));
  expect(events.some(event=>event.type==='approval')).toBe(true);
  await adapter.steer('run','Second instruction');
  const requests=(await readFile(join(adapter.fixtureDir,'protocol.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(requests).toContainEqual(expect.objectContaining({method:'turn/steer',params:expect.objectContaining({expectedTurnId:'turn-1',input:[{type:'text',text:'Second instruction'}]})}));
  const approval=events.find(event=>event.type==='approval');
  if(approval?.type==='approval')await adapter.approve('run',approval.id,'accept');
  await run;
});

test('Codex includes a saved generated image in the next turn input',async()=>{
  const adapter=await fakeCodex('chatgpt',true);
  const events:AdapterEvent[]=[];
  await adapter.run({taskId:'task',runId:'run',cwd:tmpdir(),prompt:'Inspect this image',localImages:[adapter.generatedPath],permission:'full-access',signal:new AbortController().signal,emit:event=>events.push(event)});
  const requests=(await readFile(join(adapter.fixtureDir,'protocol.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(requests[0]).toMatchObject({method:'turn/start',params:{input:[{type:'text',text:'Inspect this image'},expect.objectContaining({type:'text'}),{type:'localImage',path:adapter.generatedPath}]}});
});

test('Codex uses native device login and carries an approval through a streamed turn', async () => {
  const adapter = await fakeCodex();
  const status = await adapter.status();
  expect(status.authenticated).toBe(true);
  expect(status.models.map(model => model.id)).toEqual(['gpt-test']);
  expect(await adapter.login()).toMatchObject({ status: 'pending', userCode: 'ABCD-1234' });
  const events: AdapterEvent[] = [];
  const result = await adapter.run({
    taskId: 'task', runId: 'run', cwd: tmpdir(), prompt: 'Do it', permission: 'ask',
    signal: new AbortController().signal,
    emit: event => {
      events.push(event);
      if (event.type === 'approval') void adapter.approve('run', event.id, 'accept');
    },
  });
  expect(result).toEqual({ sessionId: 'thread-1', text: 'Done' });
  expect(events.some(event => event.type === 'approval')).toBe(true);
  expect(events.some(event => event.type === 'text.delta' && event.text === 'Done')).toBe(true);
});

test('Codex refuses API-key authentication before starting a turn', async () => {
  const adapter = await fakeCodex('apiKey');
  const status = await adapter.status();
  expect(status.authenticated).toBe(false);
  await expect(adapter.run({
    taskId: 'task', runId: 'run', cwd: tmpdir(), prompt: 'Do it', permission: 'full-access',
    signal: new AbortController().signal, emit: () => {},
  })).rejects.toThrow(/ChatGPT subscription login/);
});

test('Codex emits only native tools, keeps their names and IDs, and separates assistant messages', async () => {
  const adapter = await fakeCodex('chatgpt', true);
  const events: AdapterEvent[] = [];
  const result = await adapter.run({
    taskId: 'task', runId: 'run', cwd: tmpdir(), prompt: 'Inspect', permission: 'full-access',
    signal: new AbortController().signal, emit: event => events.push(event),
  });
  expect(result.text).toBe('A fruit.\n\nLe pommier.');
  expect(events.filter(event => event.type === 'tool.started').map(event => [event.id, event.name])).toEqual([
    ['mcp-1', 'filesystem/read_file'], ['dynamic-1', 'browser/click'], ['command-1', 'commandExecution'],
    ['command-error', 'commandExecution'], ['mcp-error', 'filesystem/read_file'], ['dynamic-error', 'browser/click'],
  ]);
  expect(events.filter(event => event.type === 'tool.completed').map(event => [event.id, event.success])).toEqual([
    ['mcp-1', true], ['dynamic-1', true], ['command-1', true],
    ['command-error', false], ['mcp-error', false], ['dynamic-error', false],
  ]);
  expect(events.filter(event => event.type === 'text.delta').map(event => event.text).join('')).toBe(result.text);
});

test('Codex suppresses an identical second agent message', async () => {
  const adapter = await fakeCodex('chatgpt', true, false, true);
  const events: AdapterEvent[] = [];
  const result = await adapter.run({ taskId:'task',runId:'run',cwd:tmpdir(),prompt:'hi',permission:'full-access',signal:new AbortController().signal,emit:event=>events.push(event) });
  expect(result.text).toBe('Hi! What would you like to work on?');
  expect(events.filter(event => event.type === 'text.delta').map(event => event.text).join('')).toBe(result.text);
});
