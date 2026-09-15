import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

test('API streams and persists chat, protects writes, and saves both comparison arms', {timeout:30000}, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ghost-api-'));
  const requests=[];
  const fake=http.createServer(async(req,res)=>{
    if(req.url==='/api/tags'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({models:[{name:'test-local',digest:'fixture-only',size:1}]}));}
    let input='';for await(const chunk of req)input+=chunk;
    requests.push(JSON.parse(input));
    res.setHeader('Content-Type','application/x-ndjson');
    res.write(JSON.stringify({message:{content:'Fixture answer: '}})+'\n');
    res.end(JSON.stringify({message:{content:'323.'},done:true,eval_count:5,prompt_eval_count:25,total_duration:1e8,eval_duration:5e7})+'\n');
  });
  await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const appPath=fileURLToPath(new URL('../server.mjs',import.meta.url));
  const child=spawn(process.execPath,[appPath],{env:{...process.env,STUDIO_PORT:String(port),STUDIO_DATA_DIR:dir,STUDIO_OLLAMA_URL:`http://127.0.0.1:${fake.address().port}`},stdio:['ignore','pipe','pipe']});
  const origin=`http://127.0.0.1:${port}`;
  try{
    await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>child.once('exit',code=>reject(new Error(`Server exited ${code}`))))]);
    const boot=await fetch(origin+'/api/bootstrap').then(r=>r.json());
    assert.equal(boot.name,'Ghost');
    const headers={'Content-Type':'application/json','X-Studio-Token':boot.token,Origin:origin};
    const request=(url,body,method='POST',extra={})=>fetch(origin+url,{method,headers:{...headers,...extra},body:JSON.stringify(body)});
    assert.equal((await fetch(origin+'/api/sessions',{method:'POST',body:'{}'})).status,403);
    assert.equal((await request('/api/sessions',{},'POST',{Origin:'https://example.com'})).status,403);
    assert.equal((await fetch(origin+'/api/file?root=source&path=../README.md')).status,400);
    const session=await request('/api/sessions',{}).then(r=>r.json());
    const result=await request('/api/chat',{sessionId:session.id,model:'test-local',prompt:'What is 17 times 19?',framework:true,profile:'balanced'}).then(r=>r.text());
    const events=result.trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e=>e.type==='context'));
    assert.equal(events.at(-1).type,'done');
    const saved=await fetch(origin+`/api/session?id=${session.id}`).then(r=>r.json());
    assert.equal(saved.messages.at(-1).content,'Fixture answer: 323.');
    assert.ok(requests[0].messages[0].content.includes('Semantic Integrity Stress-Test Pack'));
    const create=await request('/api/file',{name:'demo.md'}).then(r=>r.json());
    assert.equal(create.path,'demo.md');
    const original=await fetch(origin+'/api/file?root=workspace&path=demo.md').then(r=>r.json());
    assert.equal((await request('/api/file',{root:'workspace',path:'demo.md',hash:original.hash,content:'saved'},'PUT')).status,200);
    assert.equal((await request('/api/file',{root:'workspace',path:'demo.md',hash:original.hash,content:'stale'},'PUT')).status,409);
    const caseId=(await fetch(origin+'/api/cases').then(r=>r.json()))[0].id;
    const comparison=await request('/api/compare',{caseId,model:'test-local'}).then(r=>r.text());
    assert.equal(JSON.parse(comparison.trim().split('\n').at(-1)).run.status,'complete');
    assert.deepEqual(requests[1].messages[1],requests[2].messages[1]);
    assert.ok(!requests[1].messages[0].content.includes('Priority Loader Prompt'));
    assert.ok(requests[2].messages[0].content.includes('Priority Loader Prompt'));
    const runs=await fetch(origin+'/api/runs').then(r=>r.json());
    assert.equal(runs[0].review,'pending');
    assert.equal(runs[0].results.length,2);
  }finally{
    child.kill();await once(child,'exit').catch(()=>{});
    await new Promise(resolve=>fake.close(resolve));
    const resolved=fs.realpathSync(dir);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep+'ghost-api-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
