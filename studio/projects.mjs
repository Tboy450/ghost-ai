// Ghost's project registry. Each project is an arbitrary folder on disk;
// its conversations, memory, and backups are stored inside that folder at
// `<project>/.ghost/`, so the project stays self-contained and portable.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const projectId = realPath => createHash('sha256').update(realPath).digest('hex').slice(0,16);

export function loadRegistry(registryPath) {
  try { return JSON.parse(fs.readFileSync(registryPath,'utf8')); }
  catch { return {projects:[],activeId:null}; }
}

export function saveRegistry(registryPath, registry) {
  fs.mkdirSync(path.dirname(registryPath),{recursive:true});
  fs.writeFileSync(registryPath, JSON.stringify(registry,null,2));
}

export function projectDataDirs(project) {
  const ghost = path.join(project.path,'.ghost');
  return {ghost, sessions:path.join(ghost,'sessions'), runs:path.join(ghost,'runs'), backups:path.join(ghost,'backups')};
}

export function ensureProjectDirs(project) {
  const dirs = projectDataDirs(project);
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir,{recursive:true});
  ensureGitignored(project.path);
  return dirs;
}

// If this project folder is a git repository, keep Ghost's own working data
// (`.ghost/`, session backups, self-improvement history) out of the user's
// version-controlled changes and Git status view.
function ensureGitignored(projectPath) {
  if (!fs.existsSync(path.join(projectPath,'.git'))) return;
  const gitignorePath = path.join(projectPath,'.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath,'utf8') : '';
  if (existing.split('\n').some(line => line.trim() === '.ghost/')) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignorePath, `${existing}${prefix}.ghost/\n`);
}

function fail(message,status=400) { return Object.assign(new Error(message),{status}); }

export function openProject(registryPath, folderPath, name) {
  if (typeof folderPath !== 'string' || !folderPath.trim()) throw fail('Choose a folder to open.');
  fs.mkdirSync(folderPath,{recursive:true});
  let real;
  try { real = fs.realpathSync(folderPath); } catch { throw fail('That folder was not found.',404); }
  if (!fs.statSync(real).isDirectory()) throw fail('Choose a folder, not a file.');
  const id = projectId(real);
  const registry = loadRegistry(registryPath);
  const existing = registry.projects.find(p=>p.id===id);
  const now = new Date().toISOString();
  const label = typeof name === 'string' && name.trim() ? name.trim().slice(0,80) : null;
  const project = existing
    ? {...existing, path:real, name:label || existing.name, lastOpenedAt:now}
    : {id, path:real, name:label || path.basename(real) || real, createdAt:now, lastOpenedAt:now};
  registry.projects = [project, ...registry.projects.filter(p=>p.id!==id)];
  registry.activeId = id;
  ensureProjectDirs(project);
  saveRegistry(registryPath, registry);
  return project;
}

export function listProjects(registryPath) {
  return loadRegistry(registryPath).projects.slice().sort((a,b)=>b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

export function activeProject(registryPath) {
  const registry = loadRegistry(registryPath);
  return registry.projects.find(p=>p.id===registry.activeId) || null;
}

export function switchProject(registryPath, id) {
  const registry = loadRegistry(registryPath);
  const project = registry.projects.find(p=>p.id===id);
  if (!project) throw fail('Unknown project.',404);
  if (!fs.existsSync(project.path)) throw fail('That project folder is no longer available.',404);
  project.lastOpenedAt = new Date().toISOString();
  registry.activeId = id;
  ensureProjectDirs(project);
  saveRegistry(registryPath, registry);
  return project;
}

export function closeProject(registryPath, id) {
  const registry = loadRegistry(registryPath);
  const remaining = registry.projects.filter(p=>p.id!==id);
  if (remaining.length === registry.projects.length) throw fail('Unknown project.',404);
  if (!remaining.length) throw fail('Keep at least one project open.');
  registry.projects = remaining;
  if (registry.activeId === id) registry.activeId = remaining[0].id;
  saveRegistry(registryPath, registry);
  return registry.projects.find(p=>p.id===registry.activeId);
}
