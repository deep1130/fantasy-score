#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const versionJsonPath = path.join(rootDir, 'version.json');
const indexPath = path.join(rootDir, 'index.html');
const appJsPath = path.join(rootDir, 'app.js');

function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function parseSemver(vStr) {
  const clean = vStr.replace(/^v/, '');
  const parts = clean.split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function bumpSemver(current, type = 'patch') {
  let [major, minor, patch] = parseSemver(current);
  if (type === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `v${major}.${minor}.${patch}`;
}

const arg = process.argv[2] || 'patch';
let curData = { version: 'v1.2.1' };
if (fs.existsSync(versionJsonPath)) {
  try {
    curData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
  } catch (e) {}
}

const newVersion = arg.startsWith('v') || /^\d+\.\d+\.\d+/.test(arg)
  ? (arg.startsWith('v') ? arg : `v${arg}`)
  : bumpSemver(curData.version || 'v1.2.1', arg);

const commit = getGitCommit();
const updatedAt = new Date().toISOString();
const buildTime = Date.now();

const newVersionData = {
  version: newVersion,
  build: buildTime,
  commit: commit,
  updatedAt: updatedAt
};

// 1. Update version.json
fs.writeFileSync(versionJsonPath, JSON.stringify(newVersionData, null, 2) + '\n', 'utf8');

// 2. Update index.html
if (fs.existsSync(indexPath)) {
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(/styles\.css\?v=[^"']+/g, `styles.css?v=${newVersion.replace(/^v/, '')}`);
  html = html.replace(/app\.js\?v=[^"']+/g, `app.js?v=${newVersion.replace(/^v/, '')}`);
  html = html.replace(/<span id="app-version">[^<]*<\/span>/g, `<span id="app-version">${newVersion}</span>`);
  fs.writeFileSync(indexPath, html, 'utf8');
}

// 3. Update app.js
if (fs.existsSync(appJsPath)) {
  let js = fs.readFileSync(appJsPath, 'utf8');
  js = js.replace(/const APP_VERSION = ['"][^'"]+['"];/, `const APP_VERSION = '${newVersion}';`);
  fs.writeFileSync(appJsPath, js, 'utf8');
}

console.log(`[Fantasy Score] Bumped version from ${curData.version} -> ${newVersion} (${commit})`);
