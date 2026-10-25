# 服务器影视库与跨设备观看

推荐把服务器作为主片库：搜索、在线播放和下载在服务器完成，Mac 只按需保留离线副本。iPhone / iPad 联网时直接访问同一个服务器片库，因此在网页中观看时共用同一份进度。Mac 关机不会影响已经提交到服务器的后台下载；服务器需要保持开机、联网，Web 与下载服务需正常运行。

部署后应从外网确认入口、登录与视频播放可用。服务器内部返回 HTTP 200 不能证明云安全组已允许手机访问。

## Docker 部署

仓库内的 `compose.library.yaml` 使用同一个本地构建镜像启动两个服务：

- `web`：页面、鉴权、片库、播放进度和任务 API。
- `downloads`：独立后台下载进程，处理持久化队列、整理 MP4、自动入库。

浏览器只负责提交和管理任务；关闭窗口不会让下载停止。镜像已经包含 FFmpeg，容器中不需要另行安装。两个服务必须共享同一份 `/data/library` 存储，不能各自挂载不同目录。

先在仓库中创建仅自己可读的 `.env.library.local`。下面是格式示例，替换密码、域名和目录后使用；不要把实际配置提交到 Git：

```dotenv
PASSWORD=replace-with-your-private-password
PUBLIC_ORIGIN=https://media.example.com
COOKIE_SECURE=true

LIBRETV_LOCAL_PORT=8897
LIBRETV_LIBRARY_DIR=/srv/libretv/library
BACKGROUND_DOWNLOAD_MAX_GB=20
```

```sh
chmod 600 .env.library.local
docker compose --env-file .env.library.local -f compose.library.yaml up -d --build
docker compose --env-file .env.library.local -f compose.library.yaml ps
```

宿主机的 `LIBRETV_LIBRARY_DIR` 应使用固定绝对路径，并允许镜像中的 `node` 用户（UID 1000）写入。未设置时，默认使用仓库下的 `.local/library`。`LOCAL_LIBRARY_DIR=/data/library` 已由 Compose 为两个服务统一设置。

`BACKGROUND_DOWNLOAD_MAX_GB` 是单个任务的空间上限，默认值和具体资源仍以服务配置为准。除了最终视频，下载分片、整理 MP4 和入库过程也会使用临时空间。后台队列、视频、海报、进度与片库记录均在持久目录中；重新创建容器不会主动删除它们。备份与迁移应完整保留该目录，包括隐藏的 `.libretv`。

## HTTPS 反向代理

Compose 默认只将 Web 暴露在宿主机 `127.0.0.1:8897`。在宿主机使用现有的 HTTPS 反向代理转发到这里，公开入口使用受信任的证书。手机 Safari 和 Mac 同步客户端都需要能验证该证书。

例如已有 Nginx 与域名证书时，可在对应的 HTTPS `server` 中配置：

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

保持原始 `Host`，包括公开地址中的非默认端口。`PUBLIC_ORIGIN` 必须准确等于浏览器使用的外部来源，例如 `https://media.example.com`，或使用 9443 端口时的 `https://media.example.com:9443`；它不能包含路径。此配置用于校验 HTTPS 反代后的写入请求，不会因为任意客户端提供了转发头就放行。

HTTPS 部署设置 `COOKIE_SECURE=true`。修改配置后重新创建容器以生效。公网入口还需要宿主机防火墙、云安全组和反向代理监听端口一致；应从外网设备确认能够打开页面、登录和播放，而不能只根据服务器内部的 HTTP 200 判断已经可用。

## 日常使用与后台任务

打开公开入口的 `/library` 可查看海报墙、电影和电视剧分类；首页用于搜索在线播放。播放页点击「下载本集」，下载管理确认入队后即可关闭窗口。任务完成整理并成功入库后显示「已入库」，可直接播放。支持「暂停」「继续」、取消、失败重试和移除终态任务记录；移除记录不会删除已经入库的视频。

Web 和后台下载是两个独立服务。如果页面能打开但任务一直排队，检查 `downloads` 服务。查看日志或重启：

```sh
docker compose --env-file .env.library.local -f compose.library.yaml logs --tail=100 web downloads
docker compose --env-file .env.library.local -f compose.library.yaml restart downloads
```

容器或服务器重启后，后台服务会读取保留的队列；失败任务可在下载管理中重试。升级前备份私有配置和完整片库目录，再使用原来的环境文件与挂载路径重新构建、启动。

## Mac 按需离线与进度同步

Mac 启动方式和私有配置示例见 [macos.md](macos.md)。配置 `LIBRARY_SERVER_URL` 与 `LIBRARY_SERVER_PASSWORD` 后，本地服务会管理独立同步进程；服务器密码只供本机服务使用，不下发到页面。

Mac 搜索播放页的下载任务存到这台 Mac；服务器网页中的下载任务存到服务器。当前不会把 Mac 新下载或导入的视频自动上传服务器。要以服务器为主片库，请先在服务器网页搜索、下载并入库，再在 Mac 选择离线副本。

Mac 默认仍打开本地片库，也可切换到「服务器片库」。对电影或指定剧集点击「保存到本地」，后台缓存完成后选择「本地播放」。只下载选中的视频，保留服务器原件；不会自动复制整个服务器库，也不会自动上传 Mac 独立导入的视频。

Mac 缓存需要本机开机、保持唤醒、联网且服务运行；窗口可以关闭。缓存完成后，视频、海报与播放进度在 Mac 磁盘上，断开外网仍可从 `http://127.0.0.1:8899/library` 观看。没有缓存的视频不会因为看到服务器海报就自动变成离线可用。

对应的服务器库内影片与 Mac 离线副本会同步观看进度。原搜索播放页（`/watch`）的历史仍按浏览器保存；需要跨设备续播时，请使用入库后的影视库播放器：

- 仅一端有新进度时，联网后自动同步到另一端。
- 两端分别观看、进度都变化时，页面显示冲突，选择「使用 Mac 进度」或「使用服务器进度」。
- 断网期间只保存本机进度，网络与同步服务恢复后再处理同步。

服务器主库直接面向联网设备。各浏览器登录同一服务器，并不要求在各设备保存完整视频副本。

## 三端如何接力观看

| 设备与方式 | 视频在哪里 | 观看进度如何同步 |
| --- | --- | --- |
| Mac / iPhone 直接打开服务器 `/library` 在线观看 | 服务器 | 直接保存到服务器，同一库内影片可换设备续播 |
| Mac 从服务器片库保存离线副本 | 服务器原件 + Mac 选中的副本 | 先保存本机磁盘，联网且同步服务运行后自动双向同步 |
| iPhone 在“文件”或 VLC 中播放已下载文件 | iPhone | 由对应 App 保存，当前不会回传 LibreTV |
| 原搜索播放 `/watch` 页面 | 远端片源 | 历史在当前浏览器，不属于库内跨设备同步 |

Mac 可以从“服务器片库”点击“打开服务器片库”直接在线观看，观看服务器上的视频不要求先缓存整片。自动同步依赖影片的明确配对，独立导入同名视频不会自动配对。正常接力观看时，切设备前先暂停并等待进度保存；页面约每 5 秒保存、后台同步约每 10 秒处理一次，网络和正在进行的传输会增加等待时间。手机系统强制关闭网页前，最后尚未成功保存的几秒不能保证保留。

冲突选择保护的是 Mac 离线副本与服务器的两份进度；两台设备同时在线播放同一服务器影片时，最后成功保存的进度生效。

## iPhone / iPad 离线观看

联网时，在 Safari 打开服务器片库即可播放，并使用服务器保存的观看进度。离线前在播放器下方点击「保存视频到设备」，通过 Safari 下载保存到“文件”，或导入 VLC。确认完整下载后，即可断网使用设备中的视频文件。

服务器上的后台下载完成只代表文件在服务器；手机离线前仍需单独保存到手机。Safari 下载大文件时的运行行为由 iOS / iPadOS 管理，目前不承诺关闭 Safari 后能持续缓存，也未提供完整的离线网页应用。

在“文件”或 VLC 中播放时，进度由对应 App 管理，**不会回传到 LibreTV 的服务器或 Mac 片库**。需要跨设备续播时，使用联网的 LibreTV 网页播放器。
