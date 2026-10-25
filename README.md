# LibreTV

基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 的个人维护分支，提供影视搜索、独立播放页、磁盘片库和后台下载，并支持服务器主库与 Mac 按需离线副本。

技术栈为 Next.js、TypeScript、React、Tailwind CSS；播放器使用 ArtPlayer、hls.js 和 mpegts.js。本分支的片库、后台服务与浏览器接入需要按本文档从源码部署，上游镜像和发布包不代表已包含这些改动。

## 文档

| 用途 | 文档 |
| --- | --- |
| Mac 安装、启动器、登录自启与本地片库 | [Mac 本地运行](docs/macos.md) |
| 服务器部署、HTTPS、跨设备观看与 iPhone 离线 | [服务器与同步](docs/server.md) |
| 环境文件、配置项与存储位置 | [配置参考](docs/configuration.md) |
| 点播、直播、源列表订阅与兼容格式 | [数据源](docs/sources.md) |
| 夸克授权、下载流程与当前限制 | [夸克分享](docs/quark.md) |
| 代码目录、后台进程、检查命令与清理边界 | [开发与维护](docs/development.md) |
| LIBVIO 专用 Chrome 的服务协议 | [浏览器桥](scripts/libvio-browser/README.md) |

## 当前功能

- **发现与搜索**：配置点播源后按片名搜索，点击结果直接进入播放页。发现页支持继续加载海报。
- **播放与换源**：独立页面展示影片信息、剧集和可用来源；换源时尽量保留当前集数与播放位置。支持倍速、快捷键和跳过标记。
- **本地影视库**：电影与电视剧海报墙、导入已有视频、按季选集及磁盘播放进度。已完整入库的视频可断网播放。
- **后台下载**：持久队列独立于网页运行，支持暂停、继续、取消和重试；下载、媒体整理与入库都成功后才加入片库。
- **服务器与离线副本**：服务器保存主片库，Mac 只缓存选中的影片，并同步配对影片的观看进度。iPhone 联网时可直接访问服务器片库。
- **直播与源管理**：M3U/IPTV、节目单、源测活及源列表订阅。片源由部署者或用户配置，仓库不提供可用片源清单。
- **可选 Mac 接入**：LIBVIO 使用专用 Chrome 会话读取网页；夸克使用官方 CLI 授权并读取分享目录。两者的会话均保留在 Mac 本机。

## 开始使用

### Mac

准备 Node.js 与 FFmpeg 后，在仓库中执行：

```sh
npm ci
cp -n .env.macos.example .env.macos.local
```

编辑 `.env.macos.local`，替换访问密码并配置自己的片源，然后执行：

```sh
npm run build
./scripts/macos/start.command
```

打开 **http://127.0.0.1:8899/library**，也可使用仓库中的 `LibreTV.app`。本机免登录、登录自启、LIBVIO 与服务器同步均按需配置，具体步骤见 [Mac 文档](docs/macos.md)。

### 服务器

使用 [compose.library.yaml](compose.library.yaml) 从本分支源码构建，分别运行网页和下载进程，并共享完整片库目录。部署命令、环境文件、HTTPS 反向代理与存储权限见 [服务器文档](docs/server.md)。

`npm run dev` 和 `npm start` 只运行网页，不会自动启动后台下载或同步进程。开发与自建进程监管见 [开发文档](docs/development.md)。

## 使用边界

- **夸克大文件尚未打通**：当前官方下载接口实测返回单文件 **50 MiB** 限制，尚未完成真实完整下载、暂停续传和自动入库验收。授权成功不代表普通电影已能下载，详见 [夸克当前限制](docs/quark.md)。
- **续传取决于来源**：HLS 可以复用完整分片；普通 MP4 来源尚不支持 HTTP Range 字节续传。正常停止保留的任务与突然断电后的恢复能力不同。
- **后台需要设备在线**：Mac 任务需要电脑开机、保持唤醒并联网；关闭网页可以继续，关机或睡眠不会继续。服务器任务由在线服务器处理，不会自动迁移到 Mac。
- **进度有归属**：原搜索播放页 `/watch` 的历史保存在当前浏览器。跨设备同步适用于服务器片库及已配对的 Mac 离线副本；两端进度冲突时需选择保留哪一端。
- **iPhone 离线使用完整文件**：可保存视频到“文件”或 VLC，但这些 App 的进度不会回传。当前未实现整站离线网页，也不保证退出 Safari 后继续下载。
- **片源与编码会变化**：不能保证每条线路都可解析、全部资源达到指定清晰度或没有视频内广告；文件能下载也不代表其编码一定适合网页播放。

视频、海报、片库记录、下载队列与播放进度会保存到配置的磁盘目录。备份或迁移时应完整保留媒体和隐藏元数据目录；凭据与授权资料不要提交到 Git。当前未提供磁力、BT 或任意 HTTP 链接的夸克云端离线下载。

## 开发与来源

运行检查：

```sh
npm run lint
npm run typecheck
npm test
node --test scripts/libvio-browser/readiness.test.cjs
npm run build
```

目录导航、状态归属与维护方法见 [开发与维护](docs/development.md)。

上游项目：[LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV)。本分支遵循 **AGPL-3.0-or-later**，完整许可证见 [LICENSE](LICENSE)。请仅配置和使用自己有权访问、播放或保存的内容。
