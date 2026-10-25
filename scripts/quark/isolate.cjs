'use strict';

// This preload applies only to the official CLI child. It does not alter the
// user's HOME or any other process, and never imports their existing account.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.umask(0o077);
const privateHome = process.env.LIBRETV_QUARK_PRIVATE_HOME;
const lockDirectory = process.env.LIBRETV_QUARK_LOCK_DIR;
const token = process.env.LIBRETV_QUARK_LOCK_TOKEN;
if (!privateHome || !path.isAbsolute(privateHome) || !lockDirectory || !path.isAbsolute(lockDirectory) || !token) {
  throw new Error('Quark private runtime is unavailable');
}
const ownerPath = path.join(lockDirectory, 'owner.json');
let registered = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    if (owner.token !== token) break;
    if (owner.childPid === process.pid) { registered = true; break; }
  } catch { break; }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
if (!registered) throw new Error('Quark private runtime lock was lost');
const stat = fs.lstatSync(privateHome);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Quark private home is unavailable');
fs.chmodSync(privateHome, 0o700);
Object.defineProperty(os, 'homedir', { configurable: true, value: () => privateHome });
delete process.env.LIBRETV_QUARK_LOCK_TOKEN;

// A typed completion request supplies its short-lived authorization code on
// stdin, so it is absent from OS command arguments and the child environment.
if (process.env.LIBRETV_QUARK_AUTH_STDIN === '1') {
  if (process.argv.length !== 3 || process.argv[2] !== 'login') throw new Error('Invalid Quark authorization operation');
  const input = Buffer.alloc(64);
  let length = 0;
  while (length < input.length) {
    const count = fs.readSync(0, input, length, input.length - length, null);
    if (count === 0) break;
    length += count;
  }
  const code = input.subarray(0, length).toString('utf8');
  input.fill(0);
  if (!/^AAC-[a-f0-9]{32}$/i.test(code)) throw new Error('Invalid Quark authorization code');
  process.argv.push('--token', code);
  delete process.env.LIBRETV_QUARK_AUTH_STDIN;
}
