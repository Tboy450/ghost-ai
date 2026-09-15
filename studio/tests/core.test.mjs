import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile, saveFile, safeFile, listFiles, modelStream } from '../core.mjs';
import { packContext, packAdaptive, itemize, estimateTokens, relevantFile, PROFILES } from '../memory.mjs';

test('file saves create an exact backup and reject stale writes',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ghost-files-'));
  try {
    fs.writeFileSync(path.join(dir,'note.md'),'old text');
    const initial=readFile(dir,'note.md');
    const saved=saveFile(dir,'note.md','new text',initial.hash,path.join(dir,'backups'));
    assert.equal(fs.readFileSync(path.join(dir,'backups',saved.backup),'utf8'),'old text');
    assert.equal(readFile(dir,'note.md').content,'new text');
    assert.throws(()=>saveFile(dir,'note.md','stale replacement',initial.hash,path.join(dir,'backups')),e=>e.status===409);
    assert.equal(readFile(dir,'note.md').content,'new text');
    for(const name of ['../note.md','/note.md','C:/note.md','note.md:secret','x\\note.md','.git/config','file.exe']) assert.throws(()=>safeFile(dir,name));
    assert.deepEqual(listFiles(dir),['note.md']);
  }finally{const resolved=fs.realpathSync(dir);assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep+'ghost-files-'));fs.rmSync(resolved,{recursive:true,force:true});}
});

test('long histories recall an old relevant constraint and stay within the budget',()=>{
  const history=[{role:'user',content:'Remember: the lighthouse project must store timestamps in UTC and use SQLite.'}];
  for(let i=0;i<120;i++)history.push({role:i%2?'user':'assistant',content:`Unrelated progress ${i}. `+'Discuss the orchard and apples. '.repeat(45)});
  history.push({role:'user',content:'For the lighthouse project, which database and time zone did we agree on?'});
  const snapshot=JSON.stringify(history);
  const packed=packContext(history,'You are Ghost.',null,'eco',['Use British English.']);
  assert.ok(packed.messages[0].content.includes('SQLite'));
  assert.ok(packed.messages[0].content.includes('Use British English.'));
  assert.equal(packed.messages.at(-1).content,history.at(-1).content);
  assert.ok(packed.stats.archivedMessages>100);
  assert.ok(packed.stats.estimatedInputTokens<=packed.stats.inputBudget);
  assert.equal(JSON.stringify(history),snapshot);
});

test('UTF-8 budgeting, deduplication, and explicit over-budget errors',()=>{
  assert.ok(estimateTokens('界'.repeat(100))>=100);
  assert.throws(()=>packContext([{role:'user',content:'x'.repeat(40000)}],'system',null,'eco'),/budget/);
  const history=[{role:'user',content:'Always use SQLite.'},{role:'assistant',content:'x'.repeat(9000)},{role:'user',content:'Always use SQLite.'},{role:'assistant',content:'x'.repeat(9000)},{role:'user',content:'Which database?'}];
  const packed=packContext(history,'system',null,'eco');
  assert.equal(packed.stats.recalledItems.filter(c=>c.text==='Always use SQLite.').length,1);
  assert.ok(itemize(history).every(c=>c.kind==='constraint'||c.kind==='context'));
});

test('relevant file excerpts have source line numbers and a bounded size',()=>{
  const content=Array.from({length:500},(_,i)=>i===300?'function launchSpaceship() { return 42; }':'// unrelated filler').join('\n');
  const selected=relevantFile({path:'ship.js',content},'Explain launchSpaceship',400);
  assert.ok(selected.text.includes('301: function launchSpaceship'));
  assert.ok(estimateTokens(selected.text)<=400);
  assert.equal(selected.partial,true);
});

test('each profile reserves output and keeps the latest request unchanged',()=>{
  for(const profile of Object.keys(PROFILES)){
    const result=packContext([{role:'user',content:'Old instruction'},{role:'assistant',content:'Discard this failed answer',error:true},{role:'user',content:'New instruction wins.'}],'system',null,profile);
    assert.equal(result.messages.at(-1).content,'New instruction wins.');
    assert.ok(!JSON.stringify(result.messages).includes('failed answer'));
    assert.ok(result.stats.estimatedInputTokens+result.stats.outputReserve<result.stats.contextLimit);
  }
});

test('recall matches paraphrased wording, not just exact keywords',()=>{
  const filler='Discuss the orchard and apples. '.repeat(45);
  const history=[{role:'user',content:'The database for the lighthouse project must be PostgreSQL.'}];
  for(let i=0;i<120;i++)history.push({role:i%2?'user':'assistant',content:`Unrelated progress ${i}. `+filler});
  history.push({role:'user',content:'Reminder: which db should the lighthouse service use?'});
  const packed=packContext(history,'You are Ghost.',null,'eco');
  assert.ok(packed.messages[0].content.includes('PostgreSQL'));
});

test('a later instruction supersedes an earlier conflicting one on the same topic',()=>{
  const filler='Discuss the orchard and apples. '.repeat(45);
  const history=[{role:'user',content:'Always use SQLite for the lighthouse project database.'}];
  for(let i=0;i<40;i++)history.push({role:i%2?'user':'assistant',content:`Unrelated progress ${i}. `+filler});
  history.push({role:'user',content:'Actually, switch the lighthouse project database to PostgreSQL instead.'});
  for(let i=0;i<40;i++)history.push({role:i%2?'user':'assistant',content:`More progress ${i}. `+filler});
  history.push({role:'user',content:'Which database does the lighthouse project use?'});
  const packed=packContext(history,'You are Ghost.',null,'eco');
  assert.ok(packed.messages[0].content.includes('PostgreSQL'));
  assert.ok(!packed.messages[0].content.includes('Always use SQLite'));
});

test('adaptive selection uses the cheapest profile that fits a short conversation',()=>{
  const packed=packAdaptive([{role:'user',content:'Say hello in one short sentence.'}],'You are Ghost.',null,[]);
  assert.equal(packed.stats.profile,'eco');
  assert.equal(packed.stats.adaptive,true);
  assert.match(packed.stats.adaptiveReason,/fits within/);
});

test('adaptive selection escalates to a larger profile when pinned notes would not otherwise fit',()=>{
  const bigNote='Critical requirement: '+'keep every detail of this long pinned specification in view. '.repeat(160);
  const packed=packAdaptive([{role:'user',content:'What are the current requirements?'}],'You are Ghost.',null,[bigNote]);
  assert.notEqual(packed.stats.profile,'eco');
  assert.equal(packed.stats.omittedPinCount,0);
  assert.ok(packed.messages[0].content.includes('keep every detail'));
});

test('explicit profile selection bypasses adaptive escalation',()=>{
  const result=packContext([{role:'user',content:'Say hello.'}],'You are Ghost.',null,'deep');
  assert.equal(result.stats.profile,'deep');
  assert.equal(result.stats.adaptive,undefined);
});

test('recalled context records carry a source turn and timestamp reference',()=>{
  const filler='Discuss the orchard and apples. '.repeat(45);
  const history=[{role:'user',content:'Always use UTC timestamps for the lighthouse project.',time:'2026-01-01T00:00:00.000Z'}];
  for(let i=0;i<120;i++)history.push({role:i%2?'user':'assistant',content:`Unrelated progress ${i}. `+filler});
  history.push({role:'user',content:'What timezone did we agree on for the lighthouse project?'});
  const packed=packContext(history,'You are Ghost.',null,'eco');
  assert.ok(packed.messages[0].content.includes('at 2026-01-01T00:00:00.000Z'));
  const recalled=packed.stats.recalledItems.find(item=>item.text.includes('UTC'));
  assert.equal(recalled.time,'2026-01-01T00:00:00.000Z');
  assert.equal(recalled.turn,0);
});

test('model streaming exposes tokens and terminal metrics',async()=>{
  const server = await import('node:http').then(({default:http}) => new Promise(resolve => {
    const fixture = http.createServer((req,res)=>{
      res.setHeader('Content-Type','application/x-ndjson');
      res.write(JSON.stringify({message:{content:'Hello '}})+'\n');
      res.end(JSON.stringify({message:{content:'Ghost.'},done:true,eval_count:2,prompt_eval_count:7,total_duration:2e9,eval_duration:1e9})+'\n');
    });
    fixture.listen(0,'127.0.0.1',()=>resolve(fixture));
  }));
  try {
    const events = [];
    for await (const event of modelStream(`http://127.0.0.1:${server.address().port}`,'fixture',[],new AbortController().signal)) events.push(event);
    assert.deepEqual(events.map(event=>event.type),['token','token','metrics']);
    assert.equal(events.filter(event=>event.type==='token').map(event=>event.text).join(''),'Hello Ghost.');
    assert.deepEqual(events.at(-1),{type:'metrics',tokens:2,promptTokens:7,seconds:2,generationSeconds:1,finishReason:'stop'});
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});

test('model streaming stops when its signal is aborted',async()=>{
  const http = await import('node:http').then(module=>module.default);
  const server = http.createServer((req,res)=>{
    res.setHeader('Content-Type','application/x-ndjson');
    res.write(JSON.stringify({message:{content:'first'}})+'\n');
    setTimeout(()=>res.end(JSON.stringify({message:{content:'late'},done:true})+'\n'),1000);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const controller = new AbortController();
  try {
    const stream = modelStream(`http://127.0.0.1:${server.address().port}`,'fixture',[],controller.signal);
    assert.equal((await stream.next()).value.text,'first');
    controller.abort();
    await assert.rejects(async()=>{ for await (const _event of stream) {} },error=>error.name==='AbortError');
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});
