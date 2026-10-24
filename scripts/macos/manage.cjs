#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const manager = __filename;
const local = path.join(root, '.local');
const stateFile = path.join(local, 'server.json');
const logFile = path.join(local, 'LibreTV.log');
const label = 'io.libretv.local';
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const url = 'http://127.0.0.1:8899';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launchctl(...args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
}

function checkedLaunchctl(...args) {
  const result = launchctl(...args);
  if (result.status !== 0) throw new Error(`launchctl ${args[0]} 失败：${result.stderr?.trim() || result.error?.message || result.status}`);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

function ownsProcess(state) {
  if (!state || !Number.isSafeInteger(state.pid) || state.pid < 2 || typeof state.token !== 'string') return false;
  const result = spawnSync('/bin/ps', ['-ww', '-p', String(state.pid), '-o', 'command='], { encoding: 'utf8' });
  const command = result.stdout?.trim() || '';
  return result.status === 0 && command.includes(manager) && command.endsWith(`run --instance ${state.token}`);
}

function forgetState(token) {
  if (readState()?.token === token) fs.rmSync(stateFile, { force: true });
}

function portBusy() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 8899 });
    const done = (busy) => { socket.destroy(); resolve(busy); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(true));
  });
}

async function healthy() {
  try {
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(2000) });
    const status = await response.json();
    const webReady = response.ok && status.passwordRequired === true && typeof status.version === 'string' && Array.isArray(status.defaultSources);
    if (!webReady) return false;
    if (process.env.LOCAL_LIBRARY_DIR && process.env.BACKGROUND_DOWNLOADS_ENABLED !== '0') {
      const heartbeat = fs.statSync(path.join(process.env.LOCAL_LIBRARY_DIR, '.libretv/background/worker-heartbeat'));
      if (Date.now() - heartbeat.mtimeMs > 30_000) return false;
    }
    return true;
  } catch { return false; }
}

async function waitForHealthy() {
  for (let attempt = 0; attempt < 45; attempt++) {
    if (ownsProcess(readState()) && await healthy()) return;
    await sleep(500);
  }
  throw new Error(`服务尚未就绪，请检查日志：${logFile}`);
}

function prerequisites() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 18 || (major === 18 && minor < 18)) throw new Error('需要 Node.js 18.18 或更新版本。');
  if (!process.env.PASSWORD || process.env.PASSWORD === 'replace-with-a-private-password') {
    throw new Error('请先在 .env.macos.local 中设置自己的 PASSWORD。');
  }
  if (!fs.existsSync(path.join(root, 'node_modules/next/dist/bin/next')) || !fs.existsSync(path.join(root, '.next/BUILD_ID'))) {
    throw new Error('缺少依赖或生产构建，请先在仓库中运行 npm ci 和 npm run build。');
  }
  if (process.env.LOCAL_LIBRARY_DIR && process.env.BACKGROUND_DOWNLOADS_ENABLED !== '0') {
    if (!fs.existsSync(path.join(root, 'scripts/background-worker.cjs')) || !fs.existsSync(path.join(root, 'node_modules/typescript'))) {
      throw new Error('缺少后台服务依赖，请先运行 npm ci。');
    }
    const ffmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' });
    if (ffmpeg.status !== 0) throw new Error('找不到 FFmpeg，请安装后在 .env.macos.local 中设置 FFMPEG_PATH。');
  }
}

const escapeXml = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

function assertOwnPlist() {
  const runner = path.join(__dirname, 'run.command');
  if (fs.existsSync(plist) && !fs.readFileSync(plist, 'utf8').includes(`<string>${escapeXml(runner)}</string>`)) {
    throw new Error(`${plist} 属于另一个安装位置，请先处理该安装。`);
  }
  const loaded = launchctl('print', service);
  if (loaded.status === 0 && !loaded.stdout?.includes(runner)) {
    throw new Error(`${service} 属于另一个安装位置，未操作该任务。`);
  }
}

async function stop() {
  assertOwnPlist();
  if (launchctl('print', service).status === 0) checkedLaunchctl('bootout', service);
  const state = readState();
  if (ownsProcess(state)) {
    process.kill(state.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 40 && ownsProcess(state); attempt++) await sleep(250);
    if (ownsProcess(state)) throw new Error(`进程 ${state.pid} 未完成退出，请检查日志；未强制终止其他进程。`);
  }
  if (!ownsProcess(readState())) fs.rmSync(stateFile, { force: true });
  console.log('LibreTV 已停止。若安装了登录自启，下次登录仍会启动。');
}

async function start() {
  prerequisites();
  assertOwnPlist();
  if (ownsProcess(readState())) {
    await waitForHealthy();
    console.log(`LibreTV 已在运行：${url}`);
    return;
  }
  if (await portBusy()) throw new Error('127.0.0.1:8899 已被其他进程占用，未启动或终止任何占用进程。');
  if (fs.existsSync(plist)) {
    if (launchctl('print', service).status !== 0) checkedLaunchctl('bootstrap', domain, plist);
    else checkedLaunchctl('kickstart', service);
  } else {
    const fd = fs.openSync(logFile, 'a', 0o600);
    try {
      const child = spawn(process.execPath, [manager, 'run', '--instance', crypto.randomUUID()], {
        cwd: root, detached: true, stdio: ['ignore', fd, fd], env: process.env,
      });
      child.on('error', (error) => console.error(error.message));
      child.unref();
    } finally { fs.closeSync(fd); }
  }
  await waitForHealthy();
  console.log(`LibreTV 已启动：${url}\n日志：${logFile}`);
}

async function run() {
  prerequisites();
  const token = process.argv[process.argv.indexOf('--instance') + 1];
  if (!token || !/^[\w-]+$/.test(token)) throw new Error('缺少有效进程标记。');
  if (ownsProcess(readState())) throw new Error('LibreTV 已运行，未重复启动。');
  if (await portBusy()) throw new Error('127.0.0.1:8899 已被占用，未启动或终止占用进程。');
  // Exclusive creation prevents two simultaneous launch requests from claiming the same server.
  if (readState() && !ownsProcess(readState())) fs.rmSync(stateFile, { force: true });
  fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, token, root, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  const children = [];
  let killTimer;
  let stopping = false;
  const cleanup = () => { clearTimeout(killTimer); forgetState(token); };
  process.once('exit', cleanup);
  try {
    const terminate = () => {
      if (stopping) return;
      stopping = true;
      for (const child of children) child.kill('SIGTERM');
      killTimer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 8000);
      killTimer.unref();
    };
    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);
    const commands = [[path.join(root, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', '8899']];
    if (process.env.LOCAL_LIBRARY_DIR && process.env.BACKGROUND_DOWNLOADS_ENABLED !== '0') commands.push([path.join(root, 'scripts/background-worker.cjs')]);
    if (process.env.LIBRARY_SERVER_URL) commands.push([path.join(root, 'scripts/library-sync-worker.cjs')]);
    // The login service owns every child. A failed worker restarts the group,
    // keeping a healthy web page from hiding a stopped background queue.
    await Promise.all(commands.map((args) => new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, NODE_ENV: 'production' } });
      children.push(child);
      child.once('error', (error) => {
        console.error(`[LibreTV] 后台进程无法启动：${error.message}`);
        process.exitCode = 1;
        terminate();
        resolve();
      });
      child.once('exit', (code) => {
        if (!stopping) { process.exitCode = code || 1; terminate(); }
        resolve();
      });
    })));
  } finally { cleanup(); }
}

async function install() {
  prerequisites();
  assertOwnPlist();
  await stop();
  const string = (value) => `<string>${escapeXml(value)}</string>`;
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${string('/bin/bash')}${string(path.join(__dirname, 'run.command'))}</array>
<key>WorkingDirectory</key>${string(root)}
<key>EnvironmentVariables</key><dict><key>NODE_BINARY</key>${string(process.execPath)}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key>${string('Background')}
<key>StandardOutPath</key>${string(logFile)}
<key>StandardErrorPath</key>${string(logFile)}
</dict></plist>\n`;
  fs.mkdirSync(path.dirname(plist), { recursive: true, mode: 0o700 });
  fs.writeFileSync(plist, source, { mode: 0o600 });
  checkedLaunchctl('enable', service);
  checkedLaunchctl('bootstrap', domain, plist);
  await waitForHealthy();
  console.log(`已安装登录自启并启动：${url}\nLaunchAgent：${plist}`);
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('这些脚本仅用于 macOS 用户会话。');
  fs.mkdirSync(local, { recursive: true, mode: 0o700 });
  switch (process.argv[2]) {
    case 'start': return start();
    case 'stop': return stop();
    case 'run': return run();
    case 'install': return install();
    case 'uninstall':
      await stop();
      fs.rmSync(plist, { force: true });
      console.log('已卸载登录自启；仓库、私密配置和日志均保留。');
      return;
    default: throw new Error('用法：manage.cjs start|stop|run|install|uninstall');
  }
}

main().catch((error) => { console.error(`[LibreTV] ${error.message}`); process.exitCode = 1; });
