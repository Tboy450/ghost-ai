import { performance } from 'node:perf_hooks';
import { modelStream } from '../studio/core.mjs';
import { PROFILES } from '../studio/memory.mjs';

const endpoint = process.env.STUDIO_OLLAMA_URL || 'http://127.0.0.1:11435';
const requestedModel = process.env.GHOST_MODEL || 'qwen3:4b-instruct';
const prompt = process.env.GHOST_VALIDATION_PROMPT || 'Reply with one short sentence confirming that local inference is working.';
const cancellationCheck = process.argv.includes('--check-cancellation');
const runsArgument = process.argv.find(argument => argument.startsWith('--runs='));
const parsedRuns = Number(runsArgument?.slice('--runs='.length) || 1);
const runs = Number.isFinite(parsedRuns) ? Math.max(1, Math.min(20, Math.floor(parsedRuns))) : 1;
const profilesArgument = process.argv.find(argument => argument.startsWith('--profiles='));
const profiles = (profilesArgument?.slice('--profiles='.length).split(',') || ['balanced'])
  .map(profile => profile.trim().toLowerCase())
  .filter((profile, index, values) => PROFILES[profile] && values.indexOf(profile) === index);
if (!profiles.length) throw new Error('Choose at least one valid profile: eco, balanced, or deep.');

const tagsResponse = await fetch(`${endpoint}/api/tags`,{signal:AbortSignal.timeout(5000)});
if (!tagsResponse.ok) throw new Error(`Model engine returned ${tagsResponse.status}.`);
const tags = await tagsResponse.json();
const model = tags.models?.find(item => item.name === requestedModel)?.name;
if (!model) throw new Error(`Required model ${requestedModel} was not found. Run scripts/Setup-LocalModel.ps1 -Model ${requestedModel}.`);

async function runProbe(profileName) {
  const profile = PROFILES[profileName];
  const started = performance.now();
  let firstTokenMs = null;
  let answer = '';
  let metrics = null;
  for await (const event of modelStream(endpoint,model,[{role:'user',content:prompt}],new AbortController().signal,profile)) {
    if (event.type === 'token') {
      if (firstTokenMs === null) firstTokenMs = performance.now() - started;
      answer += event.text;
    } else if (event.type === 'metrics') {
      metrics = event;
    }
  }
  const elapsedMs = performance.now() - started;
  if (!answer.trim()) throw new Error('The local model returned no answer.');
  if (!metrics) throw new Error('The local model stream ended without terminal metrics.');
  return {
    kind:'local_model_validation',
    profile:profileName,
    contextLimit:profile.context,
    outputLimit:profile.output,
    time:new Date().toISOString(),
    endpoint,
    model,
    prompt,
    answer,
    firstTokenMilliseconds:Number(firstTokenMs.toFixed(1)),
    elapsedMilliseconds:Number(elapsedMs.toFixed(1)),
    tokens:metrics.tokens,
    promptTokens:metrics.promptTokens,
    tokensPerSecond:metrics.generationSeconds > 0 ? Number((metrics.tokens / metrics.generationSeconds).toFixed(2)) : null,
    finishReason:metrics.finishReason,
  };
}

async function loadedModel() {
  try {
    const response = await fetch(`${endpoint}/api/ps`,{signal:AbortSignal.timeout(5000)});
    if (!response.ok) return null;
    const data = await response.json();
    const loaded = data.models?.find(item => item.name === model);
    return loaded ? {
      name:loaded.name,
      sizeBytes:loaded.size || null,
      sizeVramBytes:loaded.size_vram || null,
      contextLength:loaded.context_length || null,
    } : null;
  } catch {
    return null;
  }
}

const reports = [];
for (const profile of profiles) {
  for (let index = 0; index < runs; index++) reports.push(await runProbe(profile));
}
const average = values => values.length ? Number((values.reduce((sum,value) => sum + value, 0) / values.length).toFixed(2)) : null;
const minimum = values => values.length ? Math.min(...values) : null;
const maximum = values => values.length ? Math.max(...values) : null;
const summaries = profiles.map(profile => {
  const profileReports = reports.filter(report => report.profile === profile);
  const elapsed = profileReports.map(report => report.elapsedMilliseconds);
  const throughput = profileReports.map(report => report.tokensPerSecond).filter(value => value !== null);
  return {
    profile,
    contextLimit:PROFILES[profile].context,
    outputLimit:PROFILES[profile].output,
    runs:profileReports.length,
    latencyMilliseconds:{average:average(elapsed),minimum:minimum(elapsed),maximum:maximum(elapsed)},
    firstTokenMilliseconds:{
      average:average(profileReports.map(item => item.firstTokenMilliseconds)),
      minimum:minimum(profileReports.map(item => item.firstTokenMilliseconds)),
      maximum:maximum(profileReports.map(item => item.firstTokenMilliseconds)),
    },
    tokensPerSecond:{average:average(throughput),minimum:minimum(throughput),maximum:maximum(throughput)},
    tokens:profileReports.map(item => item.tokens),
    promptTokens:profileReports.map(item => item.promptTokens),
    finishReasons:profileReports.map(item => item.finishReason),
    responses:profileReports.map(item => item.answer),
  };
});
const report = {
  kind:'local_model_performance_baseline',
  time:new Date().toISOString(),
  endpoint,
  model,
  profiles,
  runsPerProfile:runs,
  prompt,
  loadedModel:await loadedModel(),
  summaries,
};
console.log(JSON.stringify(report,null,2));

if (cancellationCheck) {
  const controller = new AbortController();
  let receivedToken = false;
  let cancelled = false;
  try {
    for await (const event of modelStream(endpoint,model,[{role:'user',content:'Write a very long essay about local inference.'}],controller.signal,PROFILES.balanced)) {
      if (event.type === 'token' && !receivedToken) {
        receivedToken = true;
        controller.abort();
      }
    }
  } catch (error) {
    cancelled = error.name === 'AbortError';
  }
  if (!receivedToken || !cancelled) throw new Error('Cancellation check failed: the stream did not stop after its first token.');
  console.log(JSON.stringify({kind:'cancellation_check',passed:true}));
}
