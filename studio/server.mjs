import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { listFiles, readFile, saveFile, modelStream, BASE_PROMPT } from './core.mjs';
import { packContext, PROFILES } from './memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DATA = process.env.STUDIO_DATA_DIR || path.join(ROOT,'.ghost');
const PORT = Number(process.env.STUDIO_PORT || 4317);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OLLAMA = process.env.STUDIO_OLLAMA_URL || 'http://127.0.0.1:11435';
if (!['127.0.0.1','localhost','[::1]'].includes(new URL(OLLAMA).hostname)) throw new Error('The model endpoint must be local.');
const TOKEN = randomBytes(32).toString('hex');
for (const dir of [DATA,path.join(DATA,'sessions'),path.join(DATA,'runs'),path.join(DATA,'backups'),path.join(DATA,'workspace')]) fs.mkdirSync(dir,{recursive:true});
const ROOTS = {
  source:{label:'Ghost · application',path:HERE},
  framework:{label:'Semantic Integrity',path:path.join(ROOT,'ai-bias-and-creation')},
  workspace:{label:'My workspace',path:path.join(DATA,'workspace')},
};
if (fs.existsSync(path.join(ROOT,'claude-code-2.1.88/src'))) ROOTS.archive={label:'Claude Code · local archive',path:path.join(ROOT,'claude-code-2.1.88/src')};
const welcomeFile = path.join(ROOTS.workspace.path,'Getting started.md');
if (!fs.existsSync(welcomeFile)) fs.writeFileSync(welcomeFile, '# Welcome to Ghost\n\nA local space to think, build, and test.\n\n- Start a conversation in the center.\n- Browse the recovered source or your framework on the right.\n- Attach a file to ask the assistant about it.\n- Use Compare to run the same prompt with and without the framework.\n\nThe assistant suggests edits; Save writes the editor contents and creates a backup.\n');
const activityPath = path.join(DATA,'activity.jsonl');
const active = new Set();
const idValid = id => typeof id === 'string' && /^[a-z0-9-]{1,80}$/i.test(id);
function eventLog(type, detail) { fs.appendFileSync(activityPath,JSON.stringify({time:new Date().toISOString(),type,detail})+'\n'); }
function json(res,status,value) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); }
function fail(message,status=400) { return Object.assign(new Error(message),{status}); }
function rootFor(key) { if (!ROOTS[key]) throw fail('Unknown project.'); return ROOTS[key].path; }
function sessionFile(id) { if (!idValid(id)) throw fail('Invalid conversation.'); return path.join(DATA,'sessions',id+'.json'); }
function loadSession(id) { return JSON.parse(fs.readFileSync(sessionFile(id),'utf8')); }
function saveSession(session) { session.updatedAt = new Date().toISOString(); fs.writeFileSync(sessionFile(session.id),JSON.stringify(session,null,2)); }
function sessionList() { return fs.readdirSync(path.join(DATA,'sessions')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(DATA,'sessions',n),'utf8'))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)); }
function frameworkPrompt() { return fs.readFileSync(path.join(ROOTS.framework.path,'prompts/priority_loader_prompt.md'),'utf8'); }
async function body(req) {
  let data=''; for await (const chunk of req) { data+=chunk; if (Buffer.byteLength(data)>1500000) throw fail('Request too large.',413); }
  try { return JSON.parse(data || '{}'); } catch { throw fail('Invalid JSON.'); }
}
async function modelStatus() {
  try {
    const response = await fetch(`${OLLAMA}/api/tags`,{signal:AbortSignal.timeout(2500)});
    if (!response.ok) throw new Error('Unavailable');
    const data = await response.json();
    return {online:true,models:(data.models || []).map(m=>({name:m.name,size:m.size,digest:m.digest})),endpoint:OLLAMA};
  } catch { return {online:false,models:[],endpoint:OLLAMA}; }
}
function streamStart(req,res) {
  res.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new Error('Model request timed out.')),600000);
  res.on('close',()=>{ clearTimeout(timer); if (!res.writableEnded) controller.abort(); });
  return {controller,send:event=>{if (!res.destroyed) res.write(JSON.stringify(event)+'\n');},end:()=>{clearTimeout(timer);res.end();}};
}
async function chat(req,res,input) {
  if (typeof input.prompt!=='string' || !input.prompt.trim() || input.prompt.length>24000) throw fail('Enter a message under 24,000 characters.');
  const status=await modelStatus();
  if (!status.online) throw fail('Local model engine is starting or offline. Start the studio with Start Studio.cmd.',503);
  if (!status.models.some(m=>m.name===input.model)) throw fail('Choose a downloaded local model.',400);
  const session=loadSession(input.sessionId);
  if (active.size) throw fail('The local model is already working. Finish or stop the current task first.',409);
  const context=input.context;
  if (context && (typeof context.content!=='string' || typeof context.path!=='string' || context.content.length>1200000)) throw fail('Invalid file attachment.');
  active.add(session.id);
  session.title=session.messages.length ? session.title : input.prompt.trim().slice(0,55);
  session.model=input.model; session.framework=Boolean(input.framework);
  session.messages.push({role:'user',content:input.prompt,time:new Date().toISOString(),attachment:context?.path});
  saveSession(session);
  const stream=streamStart(req,res);
  stream.send({type:'session',session});
  let content='',metrics={};
  try {
    const profile=PROFILES[input.profile]?input.profile:'balanced';
    const system=BASE_PROMPT+(input.framework?'\n\nReasoning framework:\n'+frameworkPrompt():'');
    const packed=packContext(session.messages,system,context,profile,session.pinned || []);
    session.lastContext=packed.stats;session.profile=profile;saveSession(session);
    stream.send({type:'context',stats:packed.stats});
    for await (const event of modelStream(OLLAMA,input.model,packed.messages,stream.controller.signal,PROFILES[profile])) {
      if (event.type==='token') content+=event.text;
      if (event.type==='metrics') metrics=event;
      stream.send(event);
    }
    if (!content.trim()) throw new Error('The model returned no answer. Try a shorter request.');
    session.messages.push({role:'assistant',content,time:new Date().toISOString(),model:input.model,framework:Boolean(input.framework),...metrics});
    saveSession(session); eventLog('chat',`${session.title} · ${input.model}`);
    stream.send({type:'done',session});
  } catch (error) {
    const stopped=stream.controller.signal.aborted;
    const message=stopped?'Response stopped.':error.message;
    session.messages.push({role:'assistant',content:content || message,error:true,interrupted:stopped,time:new Date().toISOString()});
    saveSession(session); stream.send({type:'error',message});
    eventLog('chat_error',message);
  } finally { active.delete(session.id); stream.end(); }
}
function comparisonCases() {
  return fs.readFileSync(path.join(ROOT,'comparison/prepared/requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
}
async function compare(req,res,input) {
  const requests=comparisonCases().filter(r=>r.case_id===input.caseId);
  if (requests.length!==2) throw fail('Choose a comparison case.');
  const status=await modelStatus();
  const model=status.models.find(m=>m.name===input.model);
  if (!status.online || !model) throw fail('Select an available local model first.',503);
  if (active.size) throw fail('The local model is already working. Finish or stop the current task first.',409);
  active.add('comparison');
  const run={id:randomUUID(),time:new Date().toISOString(),caseId:input.caseId,model:input.model,modelDigest:model.digest,status:'running',results:[],review:'pending',settings:{temperature:0.35,num_ctx:8192,num_predict:1600}};
  const save=()=>fs.writeFileSync(path.join(DATA,'runs',run.id+'.json'),JSON.stringify(run,null,2));
  save(); const stream=streamStart(req,res); stream.send({type:'run',run});
  try {
    for (const request of requests) {
      const result={variant:request.variant,content:'',metrics:{}};
      // Read the CURRENT editable framework for new experiments.
      const supplement=request.variant==='framework' ? frameworkPrompt() : '';
      run.frameworkPrompt=supplement || run.frameworkPrompt;
      stream.send({type:'variant',variant:request.variant});
      const messages=[{role:'system',content:BASE_PROMPT+(supplement?'\n\n'+supplement:'')},{role:'user',content:request.user_prompt}];
      for await (const event of modelStream(OLLAMA,input.model,messages,stream.controller.signal)) {
        if (event.type==='token') result.content+=event.text;
        if (event.type==='metrics') result.metrics=event;
        stream.send({...event,variant:request.variant});
      }
      if (!result.content.trim()) throw new Error('The model returned an empty answer.');
      run.results.push(result); save();
    }
    run.status='complete'; run.completedCount=run.results.filter(r=>Boolean(r.content)).length;save();
    eventLog('comparison',`${run.caseId} · ${run.model} · review pending`);
    stream.send({type:'done',run});
  } catch(error) {
    run.status=stream.controller.signal.aborted?'stopped':'failed';run.error=error.message;save();
    stream.send({type:'error',message:run.status==='stopped'?'Comparison stopped.':error.message});
  } finally { active.delete('comparison');stream.end(); }
}

const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  try {
    if (![ `127.0.0.1:${PORT}`,`localhost:${PORT}` ].includes(req.headers.host)) throw fail('Invalid host.',403);
    const url=new URL(req.url,ORIGIN);
    if (req.method!=='GET' && (req.headers['x-studio-token']!==TOKEN || (req.headers.origin && ![ORIGIN,`http://localhost:${PORT}`].includes(req.headers.origin)))) throw fail('Refresh the studio to continue.',403);
    if (req.method==='GET' && url.pathname==='/api/bootstrap') {
      return json(res,200,{token:TOKEN,name:'Ghost',version:'0.1.0',roots:Object.entries(ROOTS).map(([id,r])=>({id,label:r.label})),sessions:sessionList(),profiles:PROFILES,model:await modelStatus()});
    }
    if (req.method==='GET' && url.pathname==='/api/status') return json(res,200,await modelStatus());
    if (req.method==='GET' && url.pathname==='/api/files') return json(res,200,{files:listFiles(rootFor(url.searchParams.get('root')))});
    if (req.method==='GET' && url.pathname==='/api/file') return json(res,200,readFile(rootFor(url.searchParams.get('root')),url.searchParams.get('path')));
    if (req.method==='PUT' && url.pathname==='/api/file') { const input=await body(req); const result=saveFile(rootFor(input.root),input.path,input.content,input.hash,path.join(DATA,'backups'));eventLog('file_saved',`${input.root}/${input.path}`);return json(res,200,result); }
    if (req.method==='POST' && url.pathname==='/api/file') {
      const input=await body(req);
      if (typeof input.name!=='string' || !/^[a-zA-Z0-9 _-]{1,80}\.(md|txt|py|js|html|css|json|ts)$/.test(input.name)) throw fail('Use a simple filename such as notes.md or app.py.');
      fs.writeFileSync(path.join(ROOTS.workspace.path,input.name),'',{flag:'wx'});eventLog('file_created',input.name);return json(res,201,{root:'workspace',path:input.name});
    }
    if (req.method==='POST' && url.pathname==='/api/sessions') { const s={id:randomUUID(),title:'New conversation',messages:[],framework:true,model:'qwen3:4b-instruct'};saveSession(s);return json(res,201,s); }
    if (req.method==='GET' && url.pathname==='/api/session') { const id=url.searchParams.get('id');return json(res,200,{...loadSession(id),running:active.has(id)}); }
    if (req.method==='PUT' && url.pathname==='/api/memory') {
      const input=await body(req);const session=loadSession(input.sessionId);
      if (active.has(session.id)) throw fail('Wait for the current response before editing memory.',409);
      if (!Array.isArray(input.pinned) || input.pinned.length>12 || input.pinned.some(s=>typeof s!=='string' || s.length>800)) throw fail('Use up to 12 notes, each under 800 characters.');
      session.pinned=input.pinned;saveSession(session);return json(res,200,session);
    }
    if (req.method==='POST' && url.pathname==='/api/chat') return await chat(req,res,await body(req));
    if (req.method==='GET' && url.pathname==='/api/cases') return json(res,200,comparisonCases().filter(r=>r.variant==='baseline').map(r=>({id:r.case_id,prompt:r.user_prompt.split('Request:\n')[1]})));
    if (req.method==='POST' && url.pathname==='/api/compare') return await compare(req,res,await body(req));
    if (req.method==='GET' && url.pathname==='/api/runs') return json(res,200,fs.readdirSync(path.join(DATA,'runs')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(DATA,'runs',n),'utf8'))).sort((a,b)=>b.time.localeCompare(a.time)));
    if (req.method==='GET' && url.pathname==='/api/activity') return json(res,200,fs.existsSync(activityPath)?fs.readFileSync(activityPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).reverse().slice(0,100):[]);
    const assets={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css','/ghost.css':'ghost.css'};
    if (req.method==='GET' && assets[url.pathname]) {
      const file=assets[url.pathname];res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});return res.end(fs.readFileSync(path.join(HERE,'public',file)));
    }
    json(res,404,{error:'Not found.'});
  } catch(error) {
    if (!res.headersSent) json(res,error.status || (error.code==='ENOENT'?404:error.code==='EEXIST'?409:500),{error:error.code==='EEXIST'?'A file with that name already exists.':error.message});
    else res.end();
  }
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Ghost ready at ${ORIGIN}`));
