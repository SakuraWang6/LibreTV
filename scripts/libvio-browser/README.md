# Mac LIBVIO browser bridge

This optional service uses the installed Google Chrome with its own persistent
profile. It is separate from the main app and Docker dependencies.

```sh
npm ci --prefix scripts/libvio-browser --ignore-scripts --no-audit --no-fund
node scripts/libvio-browser/service.cjs
```

The default private profile is `.local/libvio-browser-profile` (0700), and the
Unix socket is `.local/libvio-browser.sock` (0600). To opt the local Next server
into the bridge, set `LIBVIO_BROWSER_SOCKET` to the absolute socket path. An
optional absolute `LIBVIO_BROWSER_PROFILE` changes the dedicated profile path.
The service refuses to start on Linux, and the provider ignores the socket
setting outside macOS.

The Chrome window runs the site's ordinary JavaScript. Complete any human
verification in that window. No CAPTCHA solving, stealth flags, cookie export,
user-profile attachment, or remote debugging TCP port is used. Closing this
window makes this provider unavailable; the explicit open operation can reopen
it using the same private profile. The app's other providers and background
downloads remain independent.

RPC is a single JSON line per same-user Unix socket connection. Only `status`,
`open`, `search` (term ≤100), `detail` (numeric ID), and `watch` (numeric
ID/line/episode) exist. Optional `host` must be a published LIBVIO HTTPS host.
The service constructs paths itself, blocks foreign resources/iframes/popups,
limits request bytes to 4096 and page DOM to 1 MiB, and never accepts arbitrary
URLs, JavaScript, headers or cookies. Status/open return a summary, not DOM or
browser session data. DOM reads are serialized by the client.

The bridge resolves webpage access only. A playable or downloadable URL still
needs the normal media safety checks. Netdisk shares stay external, and the
Mac browser session is never copied to the server or mobile devices.
