import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile, saveFile, safeFile, listFiles } from '../core.mjs';
import { packContext, itemize, estimateTokens, relevantFile, PROFILES } from '../memory.mjs';

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
