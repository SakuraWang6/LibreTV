'use strict';

const LOCAL_WEB_HOST = '127.0.0.1';
const LOCAL_WEB_PORT = '8899';

// This marker is a deployment assertion, not a credential. Only pass it to the
// web child whose actual listen address is fixed by this same module.
function localWebServer(nextExecutable, environment, platform = process.platform) {
  const env = { ...environment };
  delete env.LIBRETV_LOCAL_AUTH_BIND;
  if (platform === 'darwin' && environment.LOCAL_AUTH_BYPASS === 'true') {
    if (environment.PUBLIC_ORIGIN?.trim()) throw new Error('Mac 本机免登录不能同时设置 PUBLIC_ORIGIN。');
    env.LIBRETV_LOCAL_AUTH_BIND = `${LOCAL_WEB_HOST}:${LOCAL_WEB_PORT}`;
  }
  return {
    args: [nextExecutable, 'start', '-H', LOCAL_WEB_HOST, '-p', LOCAL_WEB_PORT],
    env,
  };
}

module.exports = { localWebServer };
