# 在 Mac 上本地运行

本地服务固定监听 **http://127.0.0.1:8899**，仅供本机访问。浏览器打开该地址即可搜索、在线播放或使用 LibreTV 自带的下载功能。片源与网络会影响具体影片的可用性。

完成首次准备后，也可以双击仓库中的 `LibreTV.app`：它会先检查并启动本地服务，再用独立的 Chrome 窗口打开 LibreTV。专用浏览器资料保存在 `.local/browser-profile/`，和日常 Chrome 资料分开；未安装 Chrome 时使用默认浏览器。请保留 App 与仓库的相对位置。

## 首次准备

需要 Node.js 18.18 或更高版本，以及已经安装的依赖和生产构建。在仓库目录执行：

```sh
npm ci
npm run build
cp .env.macos.example .env.macos.local
chmod 600 .env.macos.local
```

编辑 `.env.macos.local`，将 `PASSWORD` 改成自己的密码；如脚本找不到 Node，设置 `NODE_BINARY` 为它的完整可执行文件路径。片源放在 `DEFAULT_SOURCES` JSON 数组中。密码、JSON 和带空格的路径用单引号包住。该配置由 Bash 加载，应只编辑自己信任的内容；它被 Git 忽略，不要手动加入版本控制。

例如：

```sh
PASSWORD='你的本地访问密码'
NODE_BINARY='/opt/homebrew/bin/node'
DEFAULT_SOURCES='[{"name":"自己的片源","url":"https://example.com/api.php/provide/vod"}]'
```

上述地址是格式示例，请换成自己有权使用的可用接口。配置会在每次启动时重新读取，修改后停止再启动即可。

## 启动与停止

在 Finder 中双击 `scripts/macos/start.command`，或在终端执行：

```sh
./scripts/macos/start.command
```

启动脚本会等待 `/api/status` 健康检查通过；服务在后台继续运行，关闭终端窗口不会停止。重复启动会复用正在运行的实例。然后打开 http://127.0.0.1:8899，用配置的密码登录。

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

下载时点击播放页的「下载本集」，选择保存位置并保持窗口打开到完成；右上角「下载管理」可以查看进度。Chrome 支持边下载边写入磁盘，适合完整电影；不支持此能力的浏览器会先在内存中合并文件。保存出来的 MP4/TS 是普通视频文件，可以离线使用本地播放器打开。若下载因跨域失败，可在下载管理中启用「经服务器中转下载」后重试。

启动失败时查看 `.local/LibreTV.log`，确认 `.env.macos.local` 有密码、Node 路径有效、构建存在以及 8899 端口未被占用。如果生产构建不存在，脚本会提示准备步骤，不会自行安装依赖。
