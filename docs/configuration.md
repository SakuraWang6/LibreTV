# 配置参考

本页记录当前源码读取的部署变量。安装步骤分别见 [Mac](macos.md)、[服务器](server.md)；片源格式见 [片源与订阅](sources.md)。

## 配置文件与生效方式

| 运行方式 | 配置入口 | 生效方式 |
| --- | --- | --- |
| Mac 启动器 | `.env.macos.local`，从 `.env.macos.example` 复制 | 停止后重新启动 |
| 片库 Docker Compose | `.env.library.local`，由 `LIBRETV_ENV_FILE` 指定 | 重新创建受影响的容器 |
| `npm run dev` / `npm start` | 进程环境和 Next.js 支持的 `.env*` 文件 | 重启对应进程 |

Mac 配置由 Bash `source`，密码、JSON 和含空格的路径使用单引号；只加载自己信任的内容。独立下载和同步进程从启动器或 Compose 继承环境，不会自行加载 `.env.macos.local`。私密配置不提交 Git。

预置源和显示偏好由页面读取；浏览器中已有的手动设置可能覆盖预置默认值。修改配置不会自动清空浏览器数据或迁移磁盘片库。

## 访问与来源

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PASSWORD` | 无 | 访问密码，必须配置；Mac 免登录模式也保留此值 |
| `PROXY_SECRET` | 从密码派生 | 会话与代理签名密钥，多实例应使用一致的值 |
| `COOKIE_SECURE` | 根据 `x-forwarded-proto` 推导 | `true` / `false`，控制登录 Cookie 的 Secure 标记；公网 HTTPS 设置为 `true` |
| `PUBLIC_ORIGIN` | 由请求 URL 与 Host 推导 | 片库写请求的公开来源，如 `https://media.example.com`；Mac 本机免登录不能同时设置 |
| `LOCAL_AUTH_BYPASS` | 关闭 | `true` 仅供 Mac 启动器固定监听 `127.0.0.1:8899` 的网页服务使用，也是媒体目录索引的启用条件；公网和直接 `npm start` 不因此免登录 |
| `DEFAULT_SOURCES` | `[]` | 点播源 JSON 数组 |
| `DEFAULT_LIVE_SOURCES` | `[]` | 直播源 JSON 数组，可带 `epg` |
| `DEFAULT_SUBSCRIPTIONS` | 无 | 预置订阅 JSON 数组，格式见片源文档 |
| `DEFAULT_RECOMMEND_SOURCE` | `hot-list` | `douban` / `bangumi` / `hot-list`；仅作为未主动选择过的用户的默认值 |
| `DEFAULT_IMAGE_MODE` | `direct` | `direct` / `proxy`，封面图默认加载方式 |
| `60S_API_BASE` | `https://60s.crystelf.top` | 影视榜单 API 的基础地址 |

点播源示例：

```sh
DEFAULT_SOURCES='[{"name":"自己的片源","url":"https://example.com/api.php/provide/vod"}]'
```

这只是格式示例，不保证网站当时可用。预置点播源按数组位置生成 `env_0` 等编号，调整已有条目顺序会改变来源对应关系；追加源时保留原顺序。

## 请求与搜索

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `REQUEST_TIMEOUT` | `8000` | 媒体／图片代理上游超时，毫秒 |
| `MAX_RETRIES` | `1` | 代理上游重试次数 |
| `SEARCH_MAX_PAGES` | `5` | 单源最多搜索页数，限制为 1–50；仍受源站总页数限制 |
| `SEARCH_SOURCE_TIMEOUT_MS` | `10000` | 单源全部分页总时限，限制为 3000–60000 毫秒 |
| `USER_AGENT` | 代码内置浏览器 UA | 代理与直播探测使用的 UA |
| `FALLBACK_CORS_PROXY` | 无额外配置 | 豆瓣推荐接口直连失败时的代理前缀，后面拼接编码后的目标 URL；仅配置可信服务 |
| `LIVE_ALLOW_PRIVATE` | 关闭 | `1` 允许直播访问内网来源；不改变普通后台下载的公网地址限制 |

## 片库与后台下载

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LOCAL_LIBRARY_DIR` | 通用部署关闭；Mac 为仓库 `.local/library`；片库 Compose 为 `/data/library` | 管理片库的绝对路径，保存库内视频、海报、进度、队列及同步映射；硬盘目录索引只保存引用与资料，原片留在外盘 |
| `BACKGROUND_DOWNLOADS_ENABLED` | 启用片库时开启 | `0` 关闭后台下载；Compose 部署还应停用对应 `downloads` 服务 |
| `BACKGROUND_DOWNLOAD_MAX_GB` | `20` GiB | 单任务上限，限制为 0.1–200 GiB；仍需足够临时空间和 512 MiB 剩余空间 |
| `FFMPEG_PATH` | `ffmpeg`；Docker 为 `/usr/bin/ffmpeg` | 整理视频所用 FFmpeg 可执行文件 |
| `BACKGROUND_DOWNLOAD_DOH_URL` | 不使用额外 DoH | 可选的公网 HTTPS DNS JSON 接口，需配套 bootstrap |
| `BACKGROUND_DOWNLOAD_DOH_BOOTSTRAP` | 无 | DoH 服务器的公网 IP，逗号分隔，最多 8 个；保留 HTTPS 证书与下载地址校验 |

变更片库位置前先停止服务，完整迁移整个目录，包含 `.libretv` 元数据。不要只搬视频或删除队列目录；暂停任务的分片和断点仍用于恢复。外部原片不包含在这个库目录中，须另行备份。

## 服务器片库同步

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LIBRARY_SERVER_URL` | 不启用同步 | 服务器 HTTPS Origin，不含账号、密码、路径或查询参数；本机回环地址允许 HTTP |
| `LIBRARY_SERVER_PASSWORD` | 无 | 服务器密码，只在本机后台使用 |
| `LIBRARY_SERVER_MEDIA_TRANSPORT` | `fetch` | `fetch` / `curl`，只选择视频 Range 传输；目录与进度继续使用 Node |
| `LIBRARY_SERVER_PROXY` | 不设置显式代理 | 仅同步进程的可信 HTTP(S) 代理；需要 Node 支持 `--use-env-proxy`，代理须保持运行 |

同步同时需要本地 `LOCAL_LIBRARY_DIR`。`curl` 传输不使用显式代理和用户 curl 配置，保留证书检查，不跟随重定向。启用 `LIBRARY_SERVER_PROXY` 还需 Node 22.21+ 或 24.5+；Mac 启动器会检查支持情况。

## Mac 启动器

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NODE_BINARY` | 启动脚本 PATH 中的 Node | Node 可执行文件的完整路径 |

媒体目录索引需要本机免登录模式。目录通过页面显式选择或填写路径后登记，没有额外的目录环境变量，操作见 [Mac 说明](macos.md)。

## Compose 与内部变量

`compose.library.yaml` 的 `LIBRETV_ENV_FILE`、`LIBRETV_LIBRARY_DIR`、`LIBRETV_LOCAL_PORT` 是 Compose 替换变量，默认分别为 `.env.library.local`、`./.local/library`、`8897`。通过命令前缀或 Compose 的项目 `.env` 设置；它们与传给容器的 `env_file` 是不同层次。

旧 `docker-compose.yml` 的 `LIBRETV_IMAGE` 用于选择上游镜像，不适用于获取本分支新增功能；本分支按服务器文档从源码构建。

`APP_VERSION` 由构建读取 `package.json` 注入。`LIBRETV_LOCAL_AUTH_BIND` 是启动器的内部运行变量，不是用户配置入口。
