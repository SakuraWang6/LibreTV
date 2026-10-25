# Mac 本地运行

Mac 启动器固定监听 `http://127.0.0.1:8899`，片库入口为 `/library`。关闭网页不会停止后台服务；后台下载和服务器缓存仍需要 Mac 开机、保持唤醒并联网。

## 首次准备

需要 Node.js、npm 和 FFmpeg。启动器要求 Node.js 18.18 或以上；FFmpeg 用于整理后台下载的视频。安装好这些工具后，在仓库目录执行：

```sh
npm ci
cp -n .env.macos.example .env.macos.local
chmod 600 .env.macos.local
npm run build
```

编辑 `.env.macos.local`，至少设置自己的 `PASSWORD`。启动器会用 Bash 加载该文件，密码、JSON 和带空格的路径使用单引号；只编辑可信内容。找不到 Node 或 FFmpeg 时，填写 `NODE_BINARY`、`FFMPEG_PATH` 的绝对路径。其他变量见 [配置说明](configuration.md)。

如需本机免登录，添加 `LOCAL_AUTH_BYPASS='true'`，仍保留 `PASSWORD`。该模式仅由 Mac 启动器为 `127.0.0.1:8899` 启用，不能同时配置 `PUBLIC_ORIGIN`，也不能将这个本机入口通过反代或端口转发公开。公网部署使用独立配置和访问密码。

## 启动、停止与自启

```sh
./scripts/macos/start.command
./scripts/macos/stop.command
```

启动后打开 `http://127.0.0.1:8899/library`，也可双击仓库中的 `LibreTV.app`。App 会启动服务，再用独立 Chrome 窗口打开片库；未安装 Chrome 时使用默认浏览器。App 必须与仓库保持当前相对位置。

启动器管理网页、下载进程，以及按配置启用的服务器同步和 LIBVIO 浏览器桥。重复启动会复用现有实例；端口被其他程序占用时会报错。关闭网页、App 窗口或终端不会停止服务。

登录 Mac 后自动启动：

```sh
./scripts/macos/install-launch-agent.command
```

取消自启并停止服务：

```sh
./scripts/macos/uninstall-launch-agent.command
```

自启项为 `~/Library/LaunchAgents/io.libretv.local.plist`。运行 `stop.command` 只停止当前登录会话中的任务；已安装的自启在下次登录时仍会生效。移动仓库前，先在旧位置卸载自启，再在新位置安装。

## 片库与后台下载

- 在播放页点「下载本集」，确认入队后可关闭窗口。下载管理支持暂停、继续、取消和失败重试；完整下载、整理并入库后才会出现在片库。移除下载记录保留已经入库的视频。
- HLS 下载复用完整分片；普通 MP4 来源尚不支持 HTTP Range 字节续传。暂停不能保证所有来源都从最后一个字节继续。
- 已有视频可用「导入视频」复制入库，原文件保留。导入界面支持 MP4、M4V、WebM、MOV，可确认片名、分类、季和集；上传完成前保持窗口打开。
- 已下载的影片、海报和进度保存在本机磁盘，可以断开外网播放。Mac 和本地服务仍须运行，文件编码也须被网页播放器支持。

默认库目录是 `.local/library/`。修改 `LOCAL_LIBRARY_DIR` 前先停止服务，再完整迁移库目录，包括隐藏的 `.libretv`；不要只移动视频。后台任务在提交时所在的服务执行，不会自动从 Mac 转移到服务器。

## 服务器片库与跨设备观看

服务器部署见 [服务器说明](server.md)。在 Mac 私有配置中设置：

```sh
LIBRARY_SERVER_URL='https://media.example.com'
LIBRARY_SERVER_PASSWORD='your-private-server-password'
```

重启本机服务后，可在「服务器片库」查看目录，对影片或具体剧集点「保存到本地」。缓存完成后，本地副本可离线观看；不会自动复制整库，也不会上传 Mac 独立导入的视频。

配对的服务器影片和 Mac 离线副本会同步观看进度。只有一端有新进度时，联网后自动同步；两端都变化时，选择「使用 Mac 进度」或「使用服务器进度」。原搜索播放页 `/watch` 的历史仍按浏览器保存，独立导入的同名文件不会自动配对。

可设置 `LIBRARY_SERVER_MEDIA_TRANSPORT='curl'`，使用 Mac 自带 curl 传输服务器视频 Range 分块；目录、登录和进度仍使用 Node。可选代理只影响同步进程，具体配置与版本条件见 [配置说明](configuration.md)。分块会随实际速度调整，速度上限仍取决于网络与服务器出口带宽。

iPhone / iPad 联网时直接打开服务器 `/library`。离线前点「保存视频到设备」，完整保存到“文件”或导入 VLC；这些外部播放器的进度不会回传 LibreTV。当前不提供手机整站离线，也不保证退出 Safari 后大文件继续下载。

## 可选接入

### LIBVIO 专用 Chrome

先安装独立依赖：

```sh
npm ci --prefix scripts/libvio-browser --ignore-scripts --no-audit --no-fund
```

在 `.env.macos.local` 设置 `LIBVIO_BROWSER_SOCKET` 为仓库内 `.local/libvio-browser.sock` 的绝对路径，并在 `DEFAULT_SOURCES` 中添加 `kind: "libvio"` 的来源。重启后，在专用 Chrome 正常完成网站验证；「设置 → 点播源」可查看连接或重新打开窗口。

搜索和读取新播放地址时保持专用窗口打开。已解析直媒体的后台下载独立运行；不是所有线路都能解析。浏览器资料与日常 Chrome 分开，不复制到服务器或手机。安装、协议和边界见 [浏览器桥说明](../scripts/libvio-browser/README.md)。

### 夸克分享

夸克接入仅在 Mac 本机免登录模式下开放。已支持授权、LIBVIO 分享目录选择与转存入队，但官方接口实测返回单文件 50 MiB 限制；真实大视频的完整下载、暂停续传和自动入库尚未通过验收。准备与限制见 [夸克说明](quark.md)。

## 更新与排查

在没有活跃下载、缓存或导入任务时停止服务，更新代码，按需更新依赖并构建，再启动：

```sh
./scripts/macos/stop.command
npm ci
npm run build
./scripts/macos/start.command
```

| 位置 | 用途 |
| --- | --- |
| `.env.macos.local` | 私有配置，Git 忽略 |
| `.local/library/` | 默认片库、进度、下载队列及同步映射 |
| `.local/browser-profile/` | LibreTV 独立窗口的浏览器资料 |
| `.local/libvio-browser-profile/` | LIBVIO 专用 Chrome 资料 |
| `.local/quark-runtime/` | 夸克运行工具、授权和断点 |
| `.local/LibreTV.log` | 服务日志 |
| `.local/server.json` | 启动器运行记录 |

启动失败先检查日志、配置密码、Node/FFmpeg 路径、生产构建及端口占用。下载管理提示后台未连接时检查同一日志；片库、账号状态和浏览器资料不属于可随意删除的缓存。开发与清理规则见 [开发说明](development.md)。
