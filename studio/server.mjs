import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { listFiles, readFile, saveFile, searchProject, modelStream, BASE_PROMPT } from './core.mjs';
import { packContext, packAdaptive, PROFILES, chipProfileFor } from './memory.mjs';
import { rememberConversation, forgetConversation, recall, archiveStats, expandPocket, buildLinks } from './archive.mjs';
import { recallLayered, memoryState, parseRequests, addReflex, removeReflex, readReflexes, learnReflexes, setStatus, readStatus } from './recall.mjs';
import { openProject, listProjects, activeProject, switchProject, closeProject, ensureProjectDirs } from './projects.mjs';
import * as git from './git.mjs';
import { listProviders, getFocus, setFocus, runCycle, listHistory, setProviderKey, clearProviderKey, testProvider, PROVIDERS } from './selfimprove.mjs';
import { relayState, startRelay, clearRelay, submitGuidance, implementSegments, applyRelay } from './relay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
// Global config: only the project registry lives here. Each project's
// conversations, memory, runs, and backups live inside that project's own
// folder at `<project>/.ghost/`, so opening a folder elsewhere keeps its data with it.
const CONFIG_DIR = process.env.STUDIO_DATA_DIR || path.join(ROOT,'.ghost');
const REGISTRY_PATH = path.join(CONFIG_DIR,'projects.json');
const PORT = Number(process.env.STUDIO_PORT || 4317);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OLLAMA = process.env.STUDIO_OLLAMA_URL || 'http://127.0.0.1:11435';
if (!['127.0.0.1','localhost','[::1]'].includes(new URL(OLLAMA).hostname)) throw new Error('The model endpoint must be local.');
const TOKEN = randomBytes(32).toString('hex');
fs.mkdirSync(CONFIG_DIR,{recursive:true});
const ROOTS = {
  source:{label:'Ghost · application',path:HERE},
  framework:{label:'Semantic Integrity',path:path.join(ROOT,'ai-bias-and-creation')},
};
if (fs.existsSync(path.join(ROOT,'claude-code-2.1.88/src'))) ROOTS.archive={label:'Claude Code · local archive',path:path.join(ROOT,'claude-code-2.1.88/src')};

let project = activeProject(REGISTRY_PATH);
let dirs = null;
function applyProject(nextProject) {
  project = nextProject;
  dirs = ensureProjectDirs(project);
  ROOTS.workspace = {label:project.name,path:project.path};
  const entries = fs.readdirSync(project.path).filter(n=>!n.startsWith('.'));
  const welcomeFile = path.join(project.path,'Getting started.md');
  if (!entries.length && !fs.existsSync(welcomeFile)) fs.writeFileSync(welcomeFile, '# Welcome to Ghost\n\nA local space to think, build, and test.\n\n- Start a conversation in the center.\n- Browse the recovered source or your framework on the right.\n- Attach a file to ask the assistant about it.\n- Ghost remembers decisions across conversations in this project and recalls them when they matter.\n\nThe assistant suggests edits; Save writes the editor contents and creates a backup.\n');
}
applyProject(project || openProject(REGISTRY_PATH, path.join(CONFIG_DIR,'workspace'), 'My workspace'));
const active = new Set();
// The associative link graph is rebuilt wholesale, so it runs on a cadence instead of on
// every turn. Recall degrades to its other four layers in between, never to nothing.
const LINK_REBUILD_EVERY = 10;
let turnsSinceLinks = LINK_REBUILD_EVERY;
let selfImproveBusy = false;
let relayBusy = false;
const PROVIDERS_SET = new Set(Object.keys(PROVIDERS));
const idValid = id => typeof id === 'string' && /^[a-z0-9-]{1,80}$/i.test(id);
function eventLog(type, detail) { fs.appendFileSync(path.join(dirs.ghost,'activity.jsonl'),JSON.stringify({time:new Date().toISOString(),type,detail})+'\n'); }
function json(res,status,value) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); }
function fail(message,status=400) { return Object.assign(new Error(message),{status}); }
function rootFor(key) { if (!ROOTS[key]) throw fail('Unknown project root.'); return ROOTS[key].path; }
function sessionFile(id) { if (!idValid(id)) throw fail('Invalid conversation.'); return path.join(dirs.sessions,id+'.json'); }
function loadSession(id) { return JSON.parse(fs.readFileSync(sessionFile(id),'utf8')); }
function saveSession(session) { session.updatedAt = new Date().toISOString(); fs.writeFileSync(sessionFile(session.id),JSON.stringify(session,null,2)); }
function sessionList() { return fs.readdirSync(dirs.sessions).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dirs.sessions,n),'utf8'))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)); }
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
    const profile=PROFILES[input.profile]?input.profile:'auto';
    let system=BASE_PROMPT+(input.framework?'\n\nReasoning framework:\n'+frameworkPrompt():'');
    // Long-term recall runs as its own level on top of the planner. It only adds notes the
    // live transcript cannot supply, and any failure here must never cost the user a turn.
    let recalled=[],depths=[];
    try {
      // Addresses the model asked for last turn are honoured first, so a request to see a
      // digest in full survives the turn boundary instead of evaporating with the answer.
      const asked=parseRequests(session.messages.filter(m=>m.role==='assistant').slice(-1)[0]?.content || '');
      // Recall runs before packing, so on 'auto' the profile this turn resolves to is not
      // known yet; the previous turn's choice is the best available estimate and is stable
      // in practice, because conversations grow rather than shrink.
      const chipProfile = session.chipProfile
        || chipProfileFor(profile === 'auto' ? (session.lastContext?.profile || 'balanced') : profile);
      const layered=recallLayered(dirs,input.prompt,{
        profile:chipProfile,
        explicit:asked,
        excludeConversation:session.id,
      });
      if (layered.text) system+='\n\n'+layered.text;
      depths=layered.depths || [];
      recalled=(layered.chip?.lines || []).filter(line=>line.tier!=='packed').map(line=>({
        id:line.id,conversation:String(line.id || '').split(':')[0],title:line.title,kind:line.kind,
        digest:String(line.digest || ''),address:line.address,tier:line.tier,
      }));
    } catch { recalled=[];depths=[]; }
    const packed = profile==='auto' ? packAdaptive(session.messages,system,context,session.pinned || []) : packContext(session.messages,system,context,profile,session.pinned || []);
    packed.stats.recalled=recalled.map(pocket=>({id:pocket.id,conversation:pocket.conversation,title:pocket.title,kind:pocket.kind,digest:pocket.digest.slice(0,180),address:pocket.address,tier:pocket.tier}));
    packed.stats.depths=depths;
    session.lastContext=packed.stats;session.profile=input.profile==='auto'?'auto':packed.stats.profile;saveSession(session);
    stream.send({type:'context',stats:packed.stats});
    for await (const event of modelStream(OLLAMA,input.model,packed.messages,stream.controller.signal,PROFILES[packed.stats.profile])) {
      if (event.type==='token') content+=event.text;
      if (event.type==='metrics') metrics=event;
      stream.send(event);
    }
    if (!content.trim()) throw new Error('The model returned no answer. Try a shorter request.');
    session.messages.push({role:'assistant',content,time:new Date().toISOString(),model:input.model,framework:Boolean(input.framework),...metrics});
    saveSession(session); eventLog('chat',`${session.title} · ${input.model}`);
    // Index the finished exchange so later conversations can recall it.
    try { rememberConversation(dirs,session.id,session.title,session.messages); } catch { /* recall is optional */ }
    // The link graph is a full rebuild, so it runs on a cadence rather than every turn.
    // Recall still works without it; it only loses the associative layer until it refreshes.
    try { if (++turnsSinceLinks>=LINK_REBUILD_EVERY) { turnsSinceLinks=0; buildLinks(dirs); } } catch { /* optional */ }
    stream.send({type:'done',session});
  } catch (error) {
    const stopped=stream.controller.signal.aborted;
    const message=stopped?'Response stopped.':error.message;
    session.messages.push({role:'assistant',content:content || message,error:true,interrupted:stopped,time:new Date().toISOString()});
    saveSession(session); stream.send({type:'error',message});
    eventLog('chat_error',message);
  } finally { active.delete(session.id); stream.end(); }
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
      return json(res,200,{token:TOKEN,name:'Ghost',version:'0.1.0',roots:Object.entries(ROOTS).map(([id,r])=>({id,label:r.label})),sessions:sessionList(),profiles:PROFILES,model:await modelStatus(),projects:listProjects(REGISTRY_PATH),activeProject:{id:project.id,name:project.name,path:project.path}});
    }
    if (req.method==='GET' && url.pathname==='/api/status') return json(res,200,await modelStatus());
    if (req.method==='GET' && url.pathname==='/api/projects') return json(res,200,{projects:listProjects(REGISTRY_PATH),activeId:project.id});
    if (req.method==='POST' && url.pathname==='/api/projects') {
      if (active.size) throw fail('Wait for the current response before switching projects.',409);
      const input=await body(req); applyProject(openProject(REGISTRY_PATH,input.path,input.name));
      eventLog('project_opened',project.name); return json(res,201,{id:project.id,name:project.name,path:project.path});
    }
    if (req.method==='PUT' && url.pathname==='/api/projects/active') {
      if (active.size) throw fail('Wait for the current response before switching projects.',409);
      const input=await body(req); applyProject(switchProject(REGISTRY_PATH,input.id));
      eventLog('project_switched',project.name); return json(res,200,{id:project.id,name:project.name,path:project.path});
    }
    if (req.method==='DELETE' && url.pathname==='/api/projects') {
      if (active.size) throw fail('Wait for the current response before closing a project.',409);
      const id=url.searchParams.get('id'); const wasActive=id===project.id; const fallback=closeProject(REGISTRY_PATH,id);
      if (wasActive) applyProject(fallback);
      return json(res,200,{id:project.id,name:project.name,path:project.path,projects:listProjects(REGISTRY_PATH)});
    }
    if (req.method==='GET' && url.pathname==='/api/files') return json(res,200,{files:listFiles(rootFor(url.searchParams.get('root')))});
    if (req.method==='GET' && url.pathname==='/api/search') return json(res,200,{results:searchProject(rootFor(url.searchParams.get('root')),url.searchParams.get('q'))});
    if (req.method==='GET' && url.pathname==='/api/file') return json(res,200,readFile(rootFor(url.searchParams.get('root')),url.searchParams.get('path')));
    if (req.method==='PUT' && url.pathname==='/api/file') { const input=await body(req); const result=saveFile(rootFor(input.root),input.path,input.content,input.hash,dirs.backups);eventLog('file_saved',`${input.root}/${input.path}`);return json(res,200,result); }
    if (req.method==='POST' && url.pathname==='/api/file') {
      const input=await body(req);
      if (typeof input.name!=='string' || !/^[a-zA-Z0-9 _-]{1,80}\.(md|txt|py|js|html|css|json|ts)$/.test(input.name)) throw fail('Use a simple filename such as notes.md or app.py.');
      fs.writeFileSync(path.join(ROOTS.workspace.path,input.name),'',{flag:'wx'});eventLog('file_created',input.name);return json(res,201,{root:'workspace',path:input.name});
    }
    if (req.method==='POST' && url.pathname==='/api/sessions') { const s={id:randomUUID(),title:'New conversation',messages:[],framework:true,model:'qwen3:4b-instruct'};saveSession(s);return json(res,201,s); }
    if (req.method==='GET' && url.pathname==='/api/session') { const id=url.searchParams.get('id');return json(res,200,{...loadSession(id),running:active.has(id)}); }
    if (req.method==='GET' && url.pathname==='/api/recall') {
      const query=url.searchParams.get('q') || '';
      const exclude=url.searchParams.get('exclude') || null;
      const pocketId=url.searchParams.get('pocket');
      if (pocketId) { const pocket=expandPocket(dirs,pocketId); if(!pocket) throw fail('That note is no longer stored.',404); return json(res,200,pocket); }
      return json(res,200,{...archiveStats(dirs),results:query.trim()?recall(dirs,query,{limit:10,excludeConversation:exclude}):[]});
    }
    if (req.method==='GET' && url.pathname==='/api/layers') {
      return json(res,200,memoryState(dirs,{profile:url.searchParams.get('profile') || 'medium'}));
    }
    if (req.method==='POST' && url.pathname==='/api/layers/reflex') {
      const input=await body(req);
      if (typeof input.text!=='string' || !input.text.trim() || input.text.length>400) throw fail('A rule must be 1-400 characters.');
      if (input.trigger!==undefined && (typeof input.trigger!=='string' || input.trigger.length>200)) throw fail('Invalid trigger.');
      // No trigger means the rule is unconditional, which is the point of a standing rule.
      const entry=addReflex(dirs,input.text,{trigger:input.trigger || ''});
      eventLog('reflex_added',input.text.slice(0,60));
      return json(res,201,{entry,reflexes:readReflexes(dirs)});
    }
    if (req.method==='DELETE' && url.pathname==='/api/layers/reflex') {
      const input=await body(req);
      if (typeof input.id!=='string' || !input.id) throw fail('Invalid rule.');
      if (!removeReflex(dirs,input.id)) throw fail('That rule is already gone.',404);
      return json(res,200,{reflexes:readReflexes(dirs)});
    }
    if (req.method==='POST' && url.pathname==='/api/layers/learn') {
      // Promotes archived constraints into standing rules, and refreshes the link graph.
      const learned=learnReflexes(dirs,{limit:12});
      const map=buildLinks(dirs);
      eventLog('layers_learned',`${learned.added} rules · ${map.links} links`);
      return json(res,200,{...learned,links:map.links,pockets:map.pockets,reflexes:readReflexes(dirs)});
    }
    if (req.method==='PUT' && url.pathname==='/api/layers/status') {
      const input=await body(req);
      if (!input.patch || typeof input.patch!=='object' || Array.isArray(input.patch)) throw fail('Invalid state.');
      if (Object.keys(input.patch).length>12) throw fail('Use up to 12 state entries.');
      return json(res,200,{status:setStatus(dirs,input.patch)});
    }
    if (req.method==='DELETE' && url.pathname==='/api/recall') {
      const input=await body(req);
      if (!idValid(input.conversation)) throw fail('Invalid conversation.');
      forgetConversation(dirs,input.conversation);
      return json(res,200,archiveStats(dirs));
    }
    if (req.method==='PUT' && url.pathname==='/api/memory') {
      const input=await body(req);const session=loadSession(input.sessionId);
      if (active.has(session.id)) throw fail('Wait for the current response before editing memory.',409);
      if (!Array.isArray(input.pinned) || input.pinned.length>12 || input.pinned.some(s=>typeof s!=='string' || s.length>800)) throw fail('Use up to 12 notes, each under 800 characters.');
      session.pinned=input.pinned;saveSession(session);return json(res,200,session);
    }
    if (req.method==='POST' && url.pathname==='/api/chat') return await chat(req,res,await body(req));
    if (req.method==='GET' && url.pathname==='/api/runs') return json(res,200,fs.readdirSync(dirs.runs).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dirs.runs,n),'utf8'))).sort((a,b)=>b.time.localeCompare(a.time)));
    if (req.method==='GET' && url.pathname==='/api/activity') { const activityPath=path.join(dirs.ghost,'activity.jsonl'); return json(res,200,fs.existsSync(activityPath)?fs.readFileSync(activityPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).reverse().slice(0,100):[]); }
    if (req.method==='GET' && url.pathname==='/api/git/status') return json(res,200,git.status(rootFor(url.searchParams.get('root')||'workspace')));
    if (req.method==='GET' && url.pathname==='/api/git/diff') return json(res,200,{diff:git.diff(rootFor(url.searchParams.get('root')||'workspace'),url.searchParams.get('path')||undefined)});
    if (req.method==='GET' && url.pathname==='/api/git/review') return json(res,200,git.reviewChanges(rootFor(url.searchParams.get('root')||'workspace')));
    if (req.method==='GET' && url.pathname==='/api/git/log') return json(res,200,{commits:git.log(rootFor(url.searchParams.get('root')||'workspace'),Number(url.searchParams.get('limit'))||25)});
    if (req.method==='POST' && url.pathname==='/api/git/commit') { const input=await body(req); const result=git.commit(rootFor(input.root||'workspace'),input.message,{files:input.files}); eventLog('git_commit',`${input.root||'workspace'} · ${result.hash.slice(0,7)} · ${result.files.length} file${result.files.length===1?'':'s'}`); return json(res,201,result); }
    if (req.method==='POST' && url.pathname==='/api/git/push') { const input=await body(req); const result=git.push(rootFor(input.root||'workspace'),{remote:input.remote,branch:input.branch}); eventLog('git_push',`${input.root||'workspace'} · ${result.branch}`); return json(res,200,result); }
    if (req.method==='POST' && url.pathname==='/api/git/restore') { const input=await body(req); const content=git.fileAt(rootFor(input.root||'workspace'),input.hash,input.path); return json(res,200,{path:input.path,content}); }
    if (req.method==='GET' && url.pathname==='/api/git/checkpoints') return json(res,200,{checkpoints:git.listCheckpoints(rootFor(url.searchParams.get('root')||'workspace'),dirs)});
    if (req.method==='POST' && url.pathname==='/api/git/checkpoints') { const input=await body(req); const entry=git.createCheckpoint(rootFor(input.root||'workspace'),dirs,input.name); eventLog('checkpoint_create',entry.name); return json(res,201,entry); }
    // Preview is a separate GET so the UI can always show what a restore will discard
    // before the user commits to it; restoring is never the first thing that happens.
    if (req.method==='GET' && url.pathname==='/api/git/checkpoints/preview') return json(res,200,git.previewRestore(rootFor(url.searchParams.get('root')||'workspace'),dirs,url.searchParams.get('id')));
    if (req.method==='POST' && url.pathname==='/api/git/checkpoints/restore') { const input=await body(req); const result=git.restoreCheckpoint(rootFor(input.root||'workspace'),dirs,input.id); eventLog('checkpoint_restore',result.checkpoint.name); return json(res,200,result); }
    if (req.method==='POST' && url.pathname==='/api/git/checkpoints/delete') { const input=await body(req); const result=git.deleteCheckpoint(rootFor(input.root||'workspace'),dirs,input.id); eventLog('checkpoint_delete',result.name); return json(res,200,result); }
    if (req.method==='GET' && url.pathname==='/api/self-improve/providers') return json(res,200,{providers:listProviders(dirs)});
    if (req.method==='PUT' && url.pathname==='/api/self-improve/key') { const input=await body(req); if(!PROVIDERS_SET.has(input.provider)) throw fail('Choose a supported AI provider.'); return json(res,200,setProviderKey(dirs,input.provider,input.apiKey)); }
    if (req.method==='DELETE' && url.pathname==='/api/self-improve/key') { const input=await body(req); if(!PROVIDERS_SET.has(input.provider)) throw fail('Choose a supported AI provider.'); return json(res,200,clearProviderKey(dirs,input.provider)); }
    if (req.method==='POST' && url.pathname==='/api/self-improve/test') { const input=await body(req); if(!PROVIDERS_SET.has(input.provider)) throw fail('Choose a supported AI provider.'); return json(res,200,await testProvider(input.provider,{dirs,model:input.model})); }
    if (req.method==='GET' && url.pathname==='/api/self-improve/focus') return json(res,200,getFocus(dirs));
    if (req.method==='PUT' && url.pathname==='/api/self-improve/focus') { const input=await body(req); return json(res,200,setFocus(dirs,input.focus,input.queue)); }
    if (req.method==='GET' && url.pathname==='/api/self-improve/history') return json(res,200,{cycles:listHistory(dirs)});
    if (req.method==='POST' && url.pathname==='/api/self-improve/run') {
      if (selfImproveBusy) throw fail('A self-improvement cycle is already running.',409);
      const input=await body(req);
      if (!PROVIDERS_SET.has(input.provider)) throw fail('Choose a supported AI provider.');
      selfImproveBusy=true;
      try {
        const report=await runCycle({codeRoot:ROOT,dirs,providerId:input.provider,apiKey:input.apiKey,model:input.model,autoPush:input.autoPush!==false,focusOverride:input.focus});
        eventLog('self_improve_cycle',`${input.provider} · ${report.committed?'committed':'no change'}${report.pushed?' · pushed':''}`);
        return json(res,report.error && !report.committed?200:201,report);
      } finally { selfImproveBusy=false; }
    }
    if (req.method==='GET' && url.pathname==='/api/relay') return json(res,200,relayState(dirs));
    if (req.method==='POST' && url.pathname==='/api/relay') { const input=await body(req); return json(res,201,startRelay(dirs,{codeRoot:ROOT,chat:input.chat,focus:input.focus})); }
    if (req.method==='DELETE' && url.pathname==='/api/relay') return json(res,200,clearRelay(dirs));
    if (req.method==='PUT' && url.pathname==='/api/relay/guidance') { const input=await body(req); return json(res,200,submitGuidance(dirs,{codeRoot:ROOT,guidance:input.guidance})); }
    if (req.method==='POST' && url.pathname==='/api/relay/implement') {
      // The local model works through the segments one at a time, so progress is
      // streamed: a run can take minutes and silence would look like a hang.
      if (relayBusy) throw fail('Ghost is already working through the segments.',409);
      const input=await body(req);
      if (!input.model) throw fail('Choose a local model first.');
      relayBusy=true;
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'});
      try {
        // The progress callback must report the snapshot it is handed. Referring to the
        // `state` being awaited below is a dead-zone error that fires on the first tick
        // and takes the whole run down with it.
        const state=await implementSegments(dirs,{endpoint:OLLAMA,model:input.model,onProgress:s=>res.write(JSON.stringify({type:'progress',state:s})+'\n')});
        res.write(JSON.stringify({type:'done',state})+'\n');
      } catch(error) { res.write(JSON.stringify({type:'error',message:error.message})+'\n'); }
      finally { relayBusy=false; res.end(); }
      return;
    }
    if (req.method==='POST' && url.pathname==='/api/relay/apply') {
      const input=await body(req);
      const result=applyRelay(dirs,{codeRoot:ROOT,autoPush:input.autoPush===true});
      eventLog('relay_apply',`${result.committed?'committed':'not committed'} · ${result.applied.length} files`);
      return json(res,result.committed?201:200,result);
    }
    const assets={'/':'index.html','/app.js':'app.js','/diff.js':'diff.js','/highlight.js':'highlight.js','/styles.css':'styles.css','/ghost.css':'ghost.css'};
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
