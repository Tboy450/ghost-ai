import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openProject, listProjects, activeProject, switchProject, closeProject, projectId, projectDataDirs } from '../projects.mjs';

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(),prefix)); }

test('opening a project registers it, marks it active, and creates its own .ghost data dirs',()=>{
  const config = tempDir('ghost-projects-');
  const folder = tempDir('ghost-project-a-');
  try {
    const registryPath = path.join(config,'projects.json');
    const project = openProject(registryPath, folder, 'Project A');
    assert.equal(project.name,'Project A');
    assert.equal(project.path, fs.realpathSync(folder));
    assert.equal(project.id, projectId(fs.realpathSync(folder)));
    const dirs = projectDataDirs(project);
    for (const dir of Object.values(dirs)) assert.ok(fs.existsSync(dir));
    assert.equal(activeProject(registryPath).id, project.id);
    assert.deepEqual(listProjects(registryPath).map(p=>p.id),[project.id]);
  } finally {
    fs.rmSync(config,{recursive:true,force:true});
    fs.rmSync(folder,{recursive:true,force:true});
  }
});

test('reopening the same folder reuses its project id instead of duplicating it',()=>{
  const config = tempDir('ghost-projects-');
  const folder = tempDir('ghost-project-b-');
  try {
    const registryPath = path.join(config,'projects.json');
    const first = openProject(registryPath, folder, 'First name');
    const second = openProject(registryPath, folder, 'Renamed');
    assert.equal(first.id, second.id);
    assert.equal(second.name,'Renamed');
    assert.equal(listProjects(registryPath).length,1);
  } finally {
    fs.rmSync(config,{recursive:true,force:true});
    fs.rmSync(folder,{recursive:true,force:true});
  }
});

test('switching between projects changes the active project and keeps both registered',()=>{
  const config = tempDir('ghost-projects-');
  const folderA = tempDir('ghost-project-c-');
  const folderB = tempDir('ghost-project-d-');
  try {
    const registryPath = path.join(config,'projects.json');
    const projectA = openProject(registryPath, folderA, 'A');
    const projectB = openProject(registryPath, folderB, 'B');
    assert.equal(activeProject(registryPath).id, projectB.id);
    switchProject(registryPath, projectA.id);
    assert.equal(activeProject(registryPath).id, projectA.id);
    assert.equal(listProjects(registryPath).length,2);
    assert.throws(()=>switchProject(registryPath,'missing'),e=>e.status===404);
  } finally {
    fs.rmSync(config,{recursive:true,force:true});
    fs.rmSync(folderA,{recursive:true,force:true});
    fs.rmSync(folderB,{recursive:true,force:true});
  }
});

test('closing a project falls back to another and refuses to close the last one',()=>{
  const config = tempDir('ghost-projects-');
  const folderA = tempDir('ghost-project-e-');
  const folderB = tempDir('ghost-project-f-');
  try {
    const registryPath = path.join(config,'projects.json');
    const projectA = openProject(registryPath, folderA, 'A');
    const projectB = openProject(registryPath, folderB, 'B');
    const fallback = closeProject(registryPath, projectB.id);
    assert.equal(fallback.id, projectA.id);
    assert.equal(activeProject(registryPath).id, projectA.id);
    assert.throws(()=>closeProject(registryPath, projectA.id),e=>/at least one/.test(e.message));
  } finally {
    fs.rmSync(config,{recursive:true,force:true});
    fs.rmSync(folderA,{recursive:true,force:true});
    fs.rmSync(folderB,{recursive:true,force:true});
  }
});
