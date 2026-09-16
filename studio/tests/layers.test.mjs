// The recall ladder is covered unit-by-unit in recall.test.mjs. What is not covered there is
// whether the running server exposes it: that a rule added through the API survives into the
// next chat turn, and that a bad request is refused rather than quietly stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

// Boots a real server against a fake Ollama so the test exercises the routes, not a mock of them.
async function withServer(run){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ghost-layers-')));
  const prompts=[];
  const fake=http.createServer(async(req,res)=>{
    if(req.url==='/api/tags'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({models:[{name:'test-local',digest:'fixture-only',size:1}]}));}
    let input='';for await(const chunk of req)input+=chunk;
    prompts.push(JSON.parse(input));
    res.setHeader('Content-Type','application/x-ndjson');
    res.end(JSON.stringify({message:{content:'Fixture answer.'},done:true,eval_count:4,prompt_eval_count:20,total_duration:1e8,eval_duration:5e7})+'\n');
  });
  await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const appPath=fileURLToPath(new URL('../server.mjs',import.meta.url));
  const child=spawn(process.execPath,[appPath],{env:{...process.env,STUDIO_PORT:String(port),STUDIO_DATA_DIR:dir,STUDIO_OLLAMA_URL:`http://127.0.0.1:${fake.address().port}`},stdio:['ignore','pipe','pipe']});
  const origin=`http://127.0.0.1:${port}`;
  try{
    await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>child.once('exit',code=>reject(new Error(`Server exited ${code}`))))]);
    const boot=await fetch(origin+'/api/bootstrap').then(r=>r.json());
    const headers={'Content-Type':'application/json','X-Studio-Token':boot.token,Origin:origin};
    const request=(url,body,method='POST')=>fetch(origin+url,{method,headers,body:JSON.stringify(body)});
    const read=url=>fetch(origin+url,{headers}).then(r=>r.json());
    await run({request,read,origin,prompts,headers});
  } finally {
    child.kill();await once(child,'exit').catch(()=>{});
    await new Promise(resolve=>fake.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

test('a standing rule added over the API reaches the next turn and can be removed', {timeout:30000}, async()=>{
  await withServer(async({request,read,prompts})=>{
    const empty=await read('/api/layers');
    assert.deepEqual(empty.reflexes,[],'a fresh install carries no rules');
    assert.ok(Array.isArray(empty.depths),'state reports the ladder');

    const added=await request('/api/layers/reflex',{text:'Never add a build step.'}).then(r=>r.json());
    assert.equal(added.reflexes.length,1);
    assert.deepEqual(added.entry.trigger,[],'no trigger means the rule is unconditional');

    const session=await request('/api/sessions',{}).then(r=>r.json());
    // The question is deliberately unrelated to the rule. An unconditional rule that only
    // survives when the question resembles it is the bug this guards against.
    await request('/api/chat',{sessionId:session.id,model:'test-local',prompt:'What colour is the sky?',profile:'balanced'}).then(r=>r.text());
    const sent=prompts.at(-1).messages.map(m=>m.content).join('\n');
    assert.ok(sent.includes('Never add a build step.'),'the rule was carried into the prompt');

    const removed=await request('/api/layers/reflex',{id:added.entry.id},'DELETE').then(r=>r.json());
    assert.deepEqual(removed.reflexes,[]);
  });
});

test('layer routes refuse malformed input instead of storing it', {timeout:30000}, async()=>{
  await withServer(async({request,read})=>{
    assert.equal((await request('/api/layers/reflex',{text:'   '})).status,400,'an empty rule is not a rule');
    assert.equal((await request('/api/layers/reflex',{text:'x'.repeat(401)})).status,400,'over-length rule refused');
    assert.equal((await request('/api/layers/reflex',{text:'Fine.',trigger:'y'.repeat(201)})).status,400,'over-length trigger refused');
    assert.equal((await request('/api/layers/reflex',{id:'does-not-exist'},'DELETE')).status,404,'removing a ghost is a 404, not a silent success');
    assert.equal((await request('/api/layers/status',{patch:['not','an','object']},'PUT')).status,400);
    const wide=Object.fromEntries(Array.from({length:13},(_,i)=>[`k${i}`,'v']));
    assert.equal((await request('/api/layers/status',{patch:wide},'PUT')).status,400,'state stays small enough to be free');
    assert.deepEqual((await read('/api/layers')).reflexes,[],'nothing refused was stored');
  });
});

test('current state persists and learning refreshes rules and the link map', {timeout:30000}, async()=>{
  await withServer(async({request,read})=>{
    const saved=await request('/api/layers/status',{patch:{task:'wiring recall',file:'server.mjs'}},'PUT').then(r=>r.json());
    assert.equal(saved.status.task,'wiring recall');
    const merged=await request('/api/layers/status',{patch:{file:'app.js'}},'PUT').then(r=>r.json());
    assert.equal(merged.status.task,'wiring recall','a patch merges rather than replaces');
    assert.equal(merged.status.file,'app.js');
    assert.equal((await read('/api/layers')).status.task,'wiring recall','state survived the round trip');

    // Learning on an empty archive must be a no-op that still succeeds; the button should
    // never fail just because there is nothing to learn from yet.
    const learned=await request('/api/layers/learn',{}).then(r=>r.json());
    assert.equal(learned.added,0);
    assert.equal(learned.links,0);
    assert.deepEqual(learned.reflexes,[]);
  });
});
