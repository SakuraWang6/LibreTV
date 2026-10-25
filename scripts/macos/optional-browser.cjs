'use strict';

/** The optional browser can restart without taking down the web/download workers. */
function superviseBrowser({ spawn, executable, args, options, onSpawn, onExit, log, retryMs = 10_000, schedule = setTimeout, cancel = clearTimeout }) {
  let child;
  let retry;
  let stopped = false;
  let exited = Promise.resolve();
  const run = () => {
    if (stopped) return;
    const launched = spawn(executable, args, options);
    child = launched;
    onSpawn(launched);
    let resolveExit;
    exited = new Promise((resolve) => { resolveExit = resolve; });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (child === launched) child = undefined;
      onExit(launched);
      resolveExit();
      if (!stopped) {
        log('[LibreTV] LIBVIO 浏览器暂时离线，将独立重试。');
        retry = schedule(run, retryMs);
        retry.unref?.();
      }
    };
    launched.once('error', finish);
    launched.once('exit', finish);
  };
  run();
  return () => {
    stopped = true;
    cancel(retry);
    child?.kill('SIGTERM');
    return exited;
  };
}

module.exports = { superviseBrowser };
