# 服务器部署与跨设备观看

服务器可作为主片库，负责在线播放与后台下载；Mac 按需缓存离线副本，iPhone / iPad 联网访问同一片库。服务器任务不依赖 Mac 开机，服务器本身仍需联网并运行网页和下载服务。

## Docker 部署

使用本仓库源码和 [compose.library.yaml](../compose.library.yaml) 构建。它启动两个共享 `/data/library` 的服务：`web` 负责网页与 API，`downloads` 负责下载、整理和入库。镜像包含 FFmpeg。

在仓库内创建 `.env.library.local`：

```dotenv
PASSWORD=replace-with-your-private-password
PUBLIC_ORIGIN=https://media.example.com
COOKIE_SECURE=true
LIBRETV_LOCAL_PORT=8897
LIBRETV_LIBRARY_DIR=/srv/libretv/library
BACKGROUND_DOWNLOAD_MAX_GB=20
```

替换示例密码、地址和目录后执行：

```sh
chmod 600 .env.library.local
sudo install -d -m 700 -o 1000 -g 1000 /srv/libretv/library
docker compose --env-file .env.library.local -f compose.library.yaml up -d --build
docker compose --env-file .env.library.local -f compose.library.yaml ps
```

宿主机库目录须允许容器中的 `node` 用户（UID 1000）读写；按实际宿主机权限配置。两个容器必须挂载同一目录。完整变量见 [配置说明](configuration.md)。

Compose 默认只绑定 `127.0.0.1:8897`。公网入口必须保留密码，并由 HTTPS 反向代理提供受信任证书。需要能从外网设备打开页面、登录和播放；服务器内部的 HTTP 200 不能证明云安全组已经放行。

## HTTPS 反向代理

使用现有 Nginx、Caddy 或其他反向代理转发到宿主机回环端口。例如在已有证书的 Nginx HTTPS `server` 中：

```nginx
location / {
    proxy_pass http://127.0.0.1:8897;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 120s;
    client_max_body_size 10m;
}
```

`PUBLIC_ORIGIN` 必须准确等于浏览器使用的 HTTPS 来源，包含非默认端口、不含路径，例如 `https://media.example.com:9443`。反代保留原始 Host，设置 `COOKIE_SECURE=true`，并让代理监听端口、宿主机防火墙和云安全组一致。更改环境配置后重新创建容器生效。

本机免登录开关不用于公网部署。LIBVIO 专用 Chrome 和夸克账号接入也只在 Mac 本机开放，不能通过复制浏览器资料或授权目录来开启服务器功能。

## 后台下载与存储

播放页点「下载本集」，确认入队后可关闭网页。下载管理支持暂停、继续、取消、失败重试，以及移除终态任务记录；完成整理并成功入库后才能播放库内视频。移除下载记录保留已入库文件。

队列与影片均在持久库目录。停止或重建容器不会主动删除它们；恢复后台服务后会重新读取保留的队列。HLS 可复用完整分片，普通 MP4 来源尚不支持字节级续传。

`BACKGROUND_DOWNLOAD_MAX_GB` 限制单个任务的大小。下载分片、整理后的 MP4 和入库暂存可能同时存在，需要为临时数据预留空间。备份和迁移须保留整个库，包括隐藏的 `.libretv` 元数据；不要只备份视频。

## Mac 与 iPhone 如何接续

先按 [Mac 说明](macos.md) 配置 `LIBRARY_SERVER_URL` 和 `LIBRARY_SERVER_PASSWORD`。密码只供 Mac 后台使用，不下发到网页。

| 使用方式 | 视频位置 | 进度归属 |
| --- | --- | --- |
| Mac 或 iPhone 打开服务器 `/library` | 服务器 | 保存在服务器，同一库内影片可换设备续播 |
| Mac 点「保存到本地」后播放配对副本 | 服务器原件与 Mac 副本 | 离线先存 Mac，联网且同步服务运行后同步 |
| iPhone“文件”或 VLC 播放已下载文件 | iPhone | 对应 App 保存，不回传 LibreTV |
| 搜索播放页 `/watch` | 远端片源 | 当前浏览器历史，不属于库内同步 |

Mac 只下载选中的影片，不复制整库，也不上传独立导入的视频。配对副本两端都有新进度时，页面要求选择「使用 Mac 进度」或「使用服务器进度」；同名的独立文件不会自动配对。两台设备同时在线播放同一服务器影片时，最后成功保存的进度生效。

切换设备前先暂停，等待进度保存和同步。断网、传输任务、网页被系统关闭都可能延迟最后几秒的进度更新。

iPhone / iPad 离线前，在服务器播放器点「保存视频到设备」，完整保存到“文件”或导入 VLC。服务器下载完成只表示视频在服务器，手机仍需单独保存。当前没有手机整站离线，也不保证退出 Safari 后继续下载大文件。

## 更新、备份与排查

更新前确认没有活跃下载或导入任务，备份私有环境文件与完整库目录，再保留原挂载路径更新：

```sh
docker compose --env-file .env.library.local -f compose.library.yaml down
git pull --ff-only
docker compose --env-file .env.library.local -f compose.library.yaml up -d --build
```

不要使用会删除持久数据的清理选项。历史源码和镜像可以按自己的回滚策略保留；清理步骤见 [开发说明](development.md)。

常用排查命令：

```sh
docker compose --env-file .env.library.local -f compose.library.yaml logs --tail=100 web downloads
docker compose --env-file .env.library.local -f compose.library.yaml restart downloads
```

| 现象 | 先检查 |
| --- | --- |
| 页面正常、任务一直排队 | `downloads` 进程、FFmpeg、共享挂载与磁盘空间 |
| 上传或进度写入失败 | `PUBLIC_ORIGIN`、反代 Host/协议、请求大小限制 |
| Mac 缓存失败 | HTTPS 证书、服务器密码、Range 响应和网络 |
| 手机无法访问 | 公网入口、监听端口、云安全组及证书 |
| 大视频传输慢 | 服务器出口带宽和网络；并发不能突破套餐带宽 |
