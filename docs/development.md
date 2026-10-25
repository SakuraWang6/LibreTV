# 开发与维护

本文介绍本分支的代码位置、运行进程与验证方式。部署步骤见 [Mac 本地运行](macos.md) 和 [服务器与同步](server.md)，配置值与环境文件见 [配置参考](configuration.md)。

## 目录导航

```text
src/app/                    页面、布局与 API 路由
  page.tsx                  发现与搜索
  watch/                    在线播放、选集与换源
  library/                  磁盘片库、服务器目录与库内播放器
  api/                      鉴权、搜索、片库、下载、同步等接口
src/components/             共享界面、播放器、源管理与下载管理
src/lib/                    领域逻辑、客户端请求与持久化
  providers/libvio/         LIBVIO 网页解析与浏览器桥客户端
  local-library/           库目录、导入、媒体、海报与磁盘播放进度
  background-downloads/    持久队列、下载、媒体整理与入库
  library-sync/            服务器目录、按需缓存、映射与进度冲突
  quark/                   官方运行时封装、分享选择与下载适配
scripts/macos/              Mac 服务管理与本机监听
scripts/libvio-browser/     可选专用 Chrome 服务及独立依赖
scripts/quark/              固定官方运行时的准备脚本与私密目录隔离
scripts/*-worker.cjs        后台下载与同步进程入口
public/                    图标等静态资源
docs/                      部署、配置与维护文档
```

测试通常与实现同目录，以 `*.test.ts` 命名。`scripts/libvio-browser/readiness.test.cjs` 使用 Node 自带测试运行器，单独执行。

## 本地开发

Mac 启动脚本要求 Node.js 18.18 或更高版本；当前 Dockerfile 和发布工作流使用 Node.js 22。后台媒体整理需要 FFmpeg。先安装根目录锁定的依赖：

```sh
npm ci
```

Next.js 开发服务使用 `.env.local` 等标准环境文件，可以参考 `.env.example`，替换其中的示例访问密码。`scripts/macos/*` 使用的是独立的 `.env.macos.local`，不会因为运行 `npm run dev` 自动加载。

```sh
npm run dev
```

开发入口为 `http://localhost:8080`。生产网页使用 `npm run build` 后再运行 `npm start`，同样监听 8080；Mac 启动器固定使用 `127.0.0.1:8899`，并负责独立后台进程。开发服务与 Mac 已运行的生产服务可以使用不同端口，仍需避免让多个进程同时处理同一个后台队列。

只有使用 LIBVIO 专用浏览器时，才需要安装它的独立依赖：

```sh
npm ci --prefix scripts/libvio-browser --ignore-scripts --no-audit --no-fund
```

该目录的 `playwright-core` 连接已安装的 Chrome。浏览器资料、网页验证和访问限制见 [浏览器桥说明](../scripts/libvio-browser/README.md)。夸克准备和授权见 [夸克文档](quark.md)。

## 进程如何配合

| 进程 | 入口 | 职责 |
| --- | --- | --- |
| Web | Next.js 页面与 `src/app/api/` | 交互、鉴权、任务管理、片库与进度 API |
| 后台下载 | `scripts/background-worker.cjs` | 读取持久队列、下载、整理媒体并提交入库 |
| 服务器同步 | `scripts/library-sync-worker.cjs` | 刷新远端目录、缓存选中的媒体并同步配对进度 |
| LIBVIO 浏览器桥 | `scripts/libvio-browser/service.cjs` | 串行读取专用 Chrome 网页，通过同用户 Unix socket 提供有限操作 |

Mac 的 `scripts/macos/manage.cjs` 管理这些子进程：网页及启用的下载服务随启动器运行，配置服务器后增加同步服务，配置浏览器 socket 后增加浏览器桥。`start.command`、`stop.command` 和登录自启均使用同一套管理逻辑，停止时核对记录的进程身份。

Docker 的 `compose.library.yaml` 将 Web 与后台下载分成两个服务，共用同一个镜像及 `/data/library` 挂载。它不会启动 Mac 专用浏览器桥，也不会自动把 Mac 的授权资料上传服务器。

两个 `*-worker.cjs` 通过 `scripts/typescript-loader.cjs` 复用 `src/lib/` 的实现，因此运行环境也需要源码与 TypeScript 依赖；仅启动一个 Next.js 网页进程不等于下载服务已经运行。自建进程监管时应为 Web 与工作进程注入一致的库配置，不要与 Mac 启动器重复管理同一队列。

## 数据与接口边界

| 数据 | 保存位置与归属 |
| --- | --- |
| 源设置、搜索历史、原 `/watch` 观看历史 | 当前浏览器的持久化存储；不是服务器片库同步记录 |
| 受管理视频、海报、库内播放进度 | `LOCAL_LIBRARY_DIR`；隐藏的 `.libretv` 保存库记录等元数据，外部原片仍在登记目录 |
| 后台下载队列、临时下载、整理与上传状态 | 片库内 `.libretv/background/` 及上传暂存目录；由下载工作进程推进 |
| 服务器目录缓存、离线副本映射与进度冲突 | 片库内 `.libretv/sync/`；按远端来源隔离 |
| 浏览器登录、夸克令牌及 SDK 断点 | Mac 私有 `.local/` 下对应运行目录；不属于公开 API 数据 |
| 硬盘目录索引 | 位置与扫描记录在片库 `.libretv/external/`，外盘原片只读；外部条目资料和海报仍在本机库 |

页面管理任务，工作进程负责执行和提交；入队、下载结束与正式入库是不同状态。修改这些流程时，应保留已有任务格式、片库编号、账号绑定和提交边界。下载记录清理不能连带删除正式影片，取消本地夸克任务也不代表删除网盘副本。

手动导入的资料匹配位于 `local-library/metadata-match.ts`，复用已有搜索与详情接口，按片名、年份、类型和季数确认身份；不确定时保留原信息。`PATCH /api/library/[id]/metadata` 仅更新资料和本地海报，保持媒体路径、编号及进度；封面在锁外安全获取，切换记录时使用与进度相同的文件锁，并通过带版本的本地海报 URL 更新缓存。

Mac 目录索引由 `local-library/external-media.ts` 管理：用户显式选择目录后注册，扫描有深度与数量上限，拒绝符号链接和越界路径。卷 UUID、文件身份和打开后的只读句柄都须核对；离线目录保留条目，不创建替代路径。公网请求不能借已有的索引访问 Mac 文件，外部原片不参与删除或海报写入。旧库内视频迁为引用时，受信任的维护函数先做完整内容校验，提交引用后才允许释放本库拥有的旧副本。

片库、下载与同步通过文件锁、原子写入和受限路径共享状态；外部请求不能指定任意本机文件路径。请求鉴权、同源校验、上游访问校验和进程身份检查应沿用已有入口，避免在新页面或脚本中另建一条绕过路径。修改接口字段或持久化结构前，先检查客户端、工作进程与旧记录读取逻辑。

## 验证命令

```sh
npm run lint
npm run typecheck
npm test
node --test scripts/libvio-browser/readiness.test.cjs
npm run build
```

- `lint` 检查 `src` 中的 ESLint 规则。
- `typecheck` 执行 TypeScript 检查。
- `npm test` 运行 Vitest 测试；浏览器桥的 CJS 就绪测试需另跑一条 Node 命令。
- `build` 验证生产构建；`DOCKER_BUILD=1` 时才输出供容器使用的 standalone 构建。

可先对改动模块运行 `npx vitest run 路径/文件.test.ts`，再按影响范围补完整检查。涉及本机端口、Unix socket 或网络的测试需要相应权限；权限错误不能当成逻辑验证通过。

当前发布工作流位于 `.github/workflows/`，由版本 tag 或手动操作触发，不是每次普通分支推送都会发布。发布前核对 `package.json` 版本、镜像目标和仓库凭据；不要把上游镜像标签当成本分支已发布的证明。

## 清理、备份与更新

| 路径 | 维护方式 |
| --- | --- |
| `.next/cache/`、`*.tsbuildinfo` | 可重新生成的构建缓存；清理后后续构建可能变慢 |
| 完整 `.next/` | 生产运行需要；完整移除前停止服务，重新构建后再启动 |
| `node_modules/`、浏览器桥的 `node_modules/` | 运行依赖；停止相关服务后才能重装，不作为运行中的垃圾删除 |
| `.env*.local`、`.local/` | 私密配置与运行状态；不能整目录当缓存清理 |
| `LOCAL_LIBRARY_DIR` | 受管理视频、队列和元数据；备份与迁移时完整保留隐藏目录，引用的外部原片须另行备份 |
| 专用 Chrome profile、夸克运行目录 | 保留登录与授权状态；不能只按体积判断为垃圾 |

更新前确认没有正在下载、整理或缓存的任务；停止服务，备份当前私有配置及完整片库，再安装依赖、构建并启动。Mac 仓库移动后需要重新安装登录自启。保持 `.gitignore` 和 `.dockerignore` 的私密目录排除规则，提交前检查 `git status` 与差异，避免夹带配置、授权码、签名地址或测试媒体。
