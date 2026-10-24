#!/usr/bin/env node
const path = require('node:path');
const { root } = require('./typescript-loader.cjs');
require(path.join(root, 'src/lib/library-sync/worker.ts')).runSyncWorker().catch(() => {
  console.error('LibreTV 云端影视库同步服务暂时无法启动，请检查本机配置');
  process.exitCode = 1;
});
