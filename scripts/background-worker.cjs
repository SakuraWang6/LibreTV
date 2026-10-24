#!/usr/bin/env node
// The service shares the exact TypeScript implementation used by the Next API.
// This tiny loader is server-only; no browser/runtime package is downloaded.
const path = require('node:path');
const { root } = require('./typescript-loader.cjs');
require(path.join(root, 'src/lib/background-downloads/worker.ts')).runWorker().catch((error) => {
  console.error('LibreTV 后台下载服务启动失败：', error.message);
  process.exitCode = 1;
});
