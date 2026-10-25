# 在 Mac 上本地运行

本地服务固定监听 **http://127.0.0.1:8899**，仅供本机访问。浏览器打开该地址即可搜索、在线播放或使用 LibreTV 自带的下载功能。片源与网络会影响具体影片的可用性。

完成首次准备后，也可以双击仓库中的 `LibreTV.app`：它会先检查并启动本地服务，再用独立的 Chrome 窗口打开本地影视库。专用浏览器资料保存在 `.local/browser-profile/`，和日常 Chrome 资料分开；未安装 Chrome 时使用默认浏览器。请保留 App 与仓库的相对位置。

## 首次准备

需要 Node.js 18.18 或更高版本，以及 FFmpeg。FFmpeg 用于后台整理 MP4；如果使用 Homebrew，可先执行 `brew install ffmpeg`。在仓库目录执行：

```sh
npm ci
npm run build
cp -n .env.macos.example .env.macos.local
chmod 600 .env.macos.local
```

编辑 `.env.macos.local`，将 `PASSWORD` 改成自己的密码；如脚本找不到 Node，设置 `NODE_BINARY` 为它的完整可执行文件路径。片源放在 `DEFAULT_SOURCES` JSON 数组中。密码、JSON 和带空格的路径用单引号包住。该配置由 Bash 加载，应只编辑自己信任的内容；它被 Git 忽略，不要手动加入版本控制。

例如：

```sh
PASSWORD='你的本地访问密码'
NODE_BINARY='/opt/homebrew/bin/node'
FFMPEG_PATH='/opt/homebrew/bin/ffmpeg'
DEFAULT_SOURCES='[{"name":"自己的片源","url":"https://example.com/api.php/provide/vod"}]'
```

上述地址是格式示例，请换成自己有权使用的可用接口。配置会在每次启动时重新读取，修改后停止再启动即可。

如希望这台 Mac 打开即用，在 `.env.macos.local` 中添加 `LOCAL_AUTH_BYPASS='true'`。重启后，通过本机启动器访问 `http://127.0.0.1:8899` 无需输入密码；仍保留 `PASSWORD` 配置。这个开关只由 Mac 启动器为固定监听 `127.0.0.1` 的网页服务启用，直接运行 `npm start` 或公网 Docker 不会因此免登录。请求的实际 Host 与 Origin 也必须是本机地址，不使用转发头判断本机身份。此本机服务不要通过公网反代或端口转发共享，不能同时设置 `PUBLIC_ORIGIN`；服务器继续使用独立部署和访问密码。

## 启动与停止

在 Finder 中双击 `scripts/macos/start.command`，或在终端执行：

```sh
./scripts/macos/start.command
```

启动脚本会等待 `/api/status` 健康检查通过，同时管理独立的后台下载进程；配置服务器同步后，也会启动同步进程。关闭浏览器、LibreTV 窗口或终端不会停止这些服务。重复启动会复用正在运行的实例。然后打开 http://127.0.0.1:8899；启用本机免登录后直接进入，否则用配置的密码登录。

双击 `scripts/macos/stop.command` 或执行：

```sh
./scripts/macos/stop.command
```

脚本只停止本仓库记录且身份匹配的管理进程及它创建的服务。若 8899 端口被其他程序占用，会报错，不会按端口杀进程。运行记录在 `.local/server.json`，日志追加到 `.local/LibreTV.log`；整个 `.local/` 目录不进入 Git。

## 可选：登录后自动启动

双击 `scripts/macos/install-launch-agent.command` 或执行：

```sh
./scripts/macos/install-launch-agent.command
```

它会先停止本工具启动的服务，再安装当前用户的 `~/Library/LaunchAgents/io.libretv.local.plist`，立即启动，并在以后登录 Mac 时自动运行。无需 sudo。LaunchAgent 会在异常退出后重启服务；手动运行停止脚本会卸载当前登录会话中的任务，下次登录仍会自动启动。

永久取消自启并停止服务：

```sh
./scripts/macos/uninstall-launch-agent.command
```

卸载会保留仓库、密码配置及日志。上述操作均可重复执行。若移动仓库位置，应先在旧位置卸载自启，在新位置重新安装。

## 更新与排查

更新代码前先停止，更新后运行 `npm ci`、`npm run build`，再启动。密码和私人片源不写入启动项的 plist。

## 可选：LIBVIO 专用 Chrome

LIBVIO 网页适配可以使用已安装的 Google Chrome 读取公开搜索、详情和播放页。先安装独立依赖：

```sh
npm ci --prefix scripts/libvio-browser --ignore-scripts --no-audit --no-fund
```

在 `.env.macos.local` 添加 `LIBVIO_BROWSER_SOCKET='/仓库绝对路径/.local/libvio-browser.sock'`，并在 `DEFAULT_SOURCES` 数组增加 `{"name":"LIBVIO","url":"https://libvio.host","kind":"libvio"}`。重启后会打开专用 Chrome；使用本机免登录模式时，「设置 → 点播源」中也可重新打开它。更新独立依赖时重复上面的安装命令。

专用资料保存在 `.local/libvio-browser-profile/`，与日常 Chrome 和 LibreTV 窗口的资料分开。网站的普通验证在这个窗口完成；适配器不解人机题、不伪装浏览器指纹，也不导出 Cookie。浏览器连接只使用本机私有 Unix socket，公网部署和 Linux 不提供浏览器控制。

搜索和读取新播放地址时需保持专用 Chrome 打开。已提交的后台下载由独立进程处理，关闭 Chrome 不会停止任务。已解析的直媒体会携带固定的公开网页 Referer；未接入的网盘分享和暂不支持的加密播放器保留原站入口。并非原站每条线路都能解析。细节见 [浏览器桥说明](../scripts/libvio-browser/README.md)。

## 可选：夸克分享

仅 Mac 本机支持通过官方 CLI 连接夸克账号，从 LIBVIO 分享入口读取目录、选择视频并加入后台队列；账号凭据不会同步到服务器或 iPhone。当前官方接口对真实视频下载返回单文件 50 MiB 限制，尚未完成真实大视频下载、暂停续传与自动入库验收。准备、授权和能力限制见 [夸克分享与后台下载](quark.md)。

## 本地影视库

Mac 启动脚本默认启用磁盘影视库，入口为 **http://127.0.0.1:8899/library**。在线播放页点击「下载本集」，任务提交成功后就由后台服务处理，可以关闭窗口。下次打开「下载管理」会读取已有任务，支持「暂停」「继续」、取消、失败重试及完成后直接播放；移除下载记录会保留已经入库的视频。

完成下载、整理和入库后，视频才会出现在本地库。会一同保存片名、电影或电视剧分类、来源提供的海报和简介；海报下载失败时使用本机生成的封面。后台下载需要 **Mac 开机、保持唤醒、联网且 LibreTV 服务运行**；合盖休眠、关机或运行停止脚本会中断处理，恢复服务后继续处理保留的队列。可以在系统设置中安排适合自己的电源与睡眠策略。

下载在点击时所在的服务上执行：从本机地址提交的任务使用 Mac 的网络和磁盘；从服务器片库提交的任务使用服务器的网络和磁盘。**服务器开机联网且后台服务正常时，Mac 关机也不影响服务器下载。** 后台任务不会在两台机器之间自动转移。

文件默认保存在 `.local/library/`：电影按片名与年份分目录，电视剧按片名、季、集整理；随机编号用于保留不同下载版本，避免覆盖原文件。视频、海报、播放进度和库记录都在磁盘，清理浏览器缓存不会删除它们。也可以在 `.env.macos.local` 中设置 `LOCAL_LIBRARY_DIR` 为固定绝对路径，改位置前停止服务并完整迁移库目录。

已在其他位置保存的视频，点击「导入视频」选择 MP4、M4V、WebM 或 MOV 文件即可复制入库，原文件会保留。`片名.S01E02.mp4`、`片名 第2集.mp4` 会自动识别为电视剧，导入前可以确认片名和分类、修改季和集；其他文件默认按电影导入。浏览器上传已有文件时仍需保持导入窗口打开；这与后台下载任务不同。除最终视频外，下载和整理也需要临时磁盘空间。

本地库可以筛选电影或电视剧、搜索本地片名、按季选集，并记住观看进度。断开外网后，仍可从启动器打开库、查看已存海报、播放和快进，整个过程仅使用本机服务，不访问在线片源。电脑需保持开机且本地服务运行；即使登录过期，也能在没有外网时用本机密码重新验证。视频是否能在网页中播放取决于文件编码，播放器会对不兼容的文件给出提示。

普通非本机部署只有显式配置 `LOCAL_LIBRARY_DIR` 才启用磁盘库；未开启时保留原有浏览器保存文件流程。

## 服务器主库与 Mac 离线副本

服务器部署见 [server.md](server.md)。在 Mac 私有配置 `.env.macos.local` 中设置服务器地址与对应访问密码，然后重启本机服务：

```sh
LIBRARY_SERVER_URL='https://media.example.com'
LIBRARY_SERVER_PASSWORD='你的服务器访问密码'
```

如果浏览器或系统 curl 下载很快，Node 后台缓存却慢，可选择 Mac 自带 curl 处理视频分块：

```sh
LIBRARY_SERVER_MEDIA_TRANSPORT='curl'
```

配置后重启本机服务。此方式仅用于已配置服务器的 HTTPS 视频 Range 请求：禁用显式代理与 curl 用户配置、不跟随重定向，保持证书校验；登录、目录和进度继续使用 Node。Cookie 通过标准输入传给 curl，避免出现在进程参数里。默认未设置时仍使用 `fetch`；其他系统选择 curl 前需先安装该程序。

TUN 决定哪些流量进入虚拟网络，规则决定进入后使用哪个出站。命中 `DIRECT` 仍可能经过 TUN；一次具体网络中的慢速不能直接归因于所有 TUN 模式。可参考 [Mihomo TUN 路由说明](https://wiki.metacubex.one/en/config/inbound/tun/)。

还保留可选的同步代理兼容方案：`LIBRARY_SERVER_PROXY='http://127.0.0.1:7897'`。它需要 Node.js 22.21+ 或 24.5+（[Node.js 代理说明](https://nodejs.org/learn/http/enterprise-network-configuration)），只影响独立同步进程，localhost 直连；代理退出会使同步中断。使用原生 curl 方案时可删除这项以移除代理依赖。

离线缓存从小分块开始，根据实际传输速度逐步调整分块大小；网络变慢而读取超时时会缩小分块重试，已落盘的部分不会重复下载。提升幅度取决于实际网络和服务器出口带宽。

这里需要可从 Mac 访问且证书受信任的 HTTPS 地址。服务器密码只在本机后台使用，不下发到页面，也不要提交到 Git。未配置时，本地影视库保持原来的独立使用方式。

本地库默认打开「本地」，配置后还会出现「服务器片库」。可以查看服务器目录，对电影或具体剧集点击「保存到本地」；任务由本机后台下载完整副本，完成后点「本地播放」，以后断网时仍在本地分类中观看。不会自动把整个服务器库下载到 Mac，也不会自动把 Mac 独立导入的视频上传服务器。缓存任务仍需要 Mac 醒着、联网；窗口可以关闭。

服务器与离线副本通过对应记录同步观看进度。只有一端新增进度时，联网后自动同步；两端离线或分别观看导致进度都变化时，页面会要求选择「使用 Mac 进度」或「使用服务器进度」，不会默默覆盖另一端。联网恢复、同步服务运行后才会传播进度；库页面重新获得焦点时会刷新磁盘记录。

## iPhone / iPad

手机和平板联网时，直接打开服务器片库，可与电脑共用该片库和观看进度。离线前在播放器下方点击「保存视频到设备」，在 Safari 中保存到“文件”，也可导入 VLC 后离线观看。应先确认视频已完整保存到设备；服务器或 Mac 上有副本，并不等于手机已经缓存。

Files / VLC 使用各自的播放记录，**其中的观看进度不会回传到 LibreTV**。目前没有承诺手机网页能在关闭 Safari 后持续缓存大文件，也没有把整个手机网页做成离线应用。

启动失败时查看 `.local/LibreTV.log`，确认私有配置已设置访问密码、Node 与 FFmpeg 路径有效、构建存在以及 8899 端口未被占用。下载管理提示后台服务未运行时也先检查该日志。如果生产构建不存在，脚本会提示准备步骤，不会自行安装依赖。
