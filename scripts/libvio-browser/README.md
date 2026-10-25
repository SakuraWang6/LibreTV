# Mac LIBVIO 浏览器桥

该可选服务用已安装的 Google Chrome 读取 LIBVIO 搜索、详情和播放页。它拥有独立依赖、持久浏览器资料和本机 Unix socket；不属于 Docker 部署，也不会连接日常 Chrome 资料。

## 安装与启用

在仓库根目录执行：

```sh
npm ci --prefix scripts/libvio-browser --ignore-scripts --no-audit --no-fund
```

在 `.env.macos.local` 设置 `LIBVIO_BROWSER_SOCKET` 为仓库内 `.local/libvio-browser.sock` 的绝对路径，并给点播源配置 `kind: "libvio"`。常规运行由 [Mac 启动器](../../docs/macos.md) 管理；独立调试时可在仓库根目录执行：

```sh
node scripts/libvio-browser/service.cjs
```

默认资料目录 `.local/libvio-browser-profile/` 权限为 0700，socket 权限为 0600。可用 `LIBVIO_BROWSER_PROFILE` 指定另一个私有绝对路径。服务仅支持 macOS；其他系统的 provider 不使用这个 socket 配置。变量说明见 [配置文档](../../docs/configuration.md)。

## 使用

启动后，在专用 Chrome 中正常完成网站验证。「设置 → 点播源 → LIBVIO」可查看连接或重新打开窗口。关闭窗口后，该网页 provider 暂不可用；重新打开会复用专用资料。其他片源和已提交的直媒体后台下载独立运行。

浏览器桥只解决网页读取。能否播放或下载仍取决于源站是否提供受支持的视频地址，以及正常媒体安全检查。支持的直媒体进入现有播放与后台下载流程；夸克分享由 [独立接入](../../docs/quark.md) 处理，其他网盘或暂不支持的播放器保留原站入口。

## 协议与边界

每个同用户 Unix socket 连接只接受一行 JSON，操作限定为：

| 操作 | 参数 |
| --- | --- |
| `status` | 无额外参数，返回连接摘要 |
| `open` | 可选白名单 `host`，打开站点首页 |
| `search` | `term`，不超过 100 字符 |
| `detail` | 1–18 位数字字符串 `id` |
| `watch` | 数字 `id`、1–9999 的 `line`、1–99999 的 `episode` |

主机只允许 `protocol.cjs` 中列出的 LIBVIO HTTPS 域名；页面路径由服务生成。请求上限 4096 字节，读取 DOM 上限 1 MiB。调用串行处理，不接收任意 URL、脚本、请求头、Cookie 或文件系统路径；状态接口不返回 DOM 或浏览器会话资料。

专用窗口运行站点正常 JavaScript，人工验证由使用者完成。服务不解验证码、不伪装浏览器指纹、不导出 Cookie，不开放远程调试 TCP 端口，并拦截非白名单资源、页面和弹窗。浏览器资料不会复制到服务器或手机。

协议和页面就绪的检查命令见 [开发说明](../../docs/development.md)。
