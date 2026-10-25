# 数据源与订阅

仓库不内置影视内容或可用片源清单。源配置保存采集接口、网站或直播播放列表地址，搜索与播放时再向对应提供方读取信息。地址有效不代表所有影片都能播放、下载或达到相同画质。

## 添加与预置

在「设置 → 源管理」中添加点播源或直播源，或在「数据源订阅」中填写源列表 JSON 地址。部署者也可通过 `DEFAULT_SOURCES`、`DEFAULT_LIVE_SOURCES`、`DEFAULT_SUBSCRIPTIONS` 预置；环境文件的写法见 [配置参考](configuration.md)。配置保存在当前部署或浏览器，不能依靠它同步影视库观看进度。

点播源通常使用 Apple CMS JSON 采集接口。`SourceConfig` 的 `kind` 可为 `cms` 或 `libvio`，省略时按地址识别；LIBVIO 是专用网页适配，仅在 Mac 上使用已配置的 Chrome 会话，并只接受代码中支持的 HTTPS 线路。把任意网址标记成 `libvio` 不会获得通用网页解析能力，见 [浏览器桥](../scripts/libvio-browser/README.md)。

直播源使用 M3U/M3U8 播放列表，可附 XMLTV 节目单地址。站点返回的网盘分享、外部下载入口与可直接播放的视频地址有不同处理；读取到分享链接不代表已经拿到媒体流。夸克入口及当前限制见 [夸克分享](quark.md)。

## LibreTV 源列表

下面仅展示格式，`example.com` 地址不是可用片源：

```json
{
  "name": "我的源列表",
  "version": 2,
  "sources": [
    {
      "name": "点播示例",
      "kind": "cms",
      "url": "https://example.com/api.php/provide/vod",
      "detail": "https://example.com",
      "isAdult": false
    }
  ],
  "liveSources": [
    {
      "name": "直播示例",
      "url": "https://example.com/list.m3u",
      "epg": "https://example.com/epg.xml.gz"
    }
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `name` | 可选的列表名称 |
| `version` | 当前导出值为 `2`；解析器不按该字段分派格式 |
| `sources` | 点播数组，最多保留 100 个有效且去重的地址 |
| `sources[].url` | 必填的 HTTP(S) 地址 |
| `sources[].name` | 可选，缺省使用地址主机名；标识由导入端生成 |
| `sources[].kind` | 可选的 `cms` / `libvio`，后者仍受 Mac 浏览器接入限制 |
| `sources[].detail` | 可选详情页根地址，供部分采集源补充读取详情 |
| `sources[].isAdult` | 仅 `true` 表示成人源，缺省为 `false` |
| `liveSources` | 直播数组，最多保留 50 个有效且去重的地址 |
| `liveSources[].url` | 必填的 HTTP(S) 播放列表地址 |
| `liveSources[].name` / `epg` | 可选名称与 HTTP(S) 节目单地址；无效的节目单字段会被丢弃 |

至少需要一个非空的 `sources` 或 `liveSources` 数组。只包含点播源的老格式、只包含直播源的格式仍可用；裸数组 `[{"name":"示例","url":"https://example.com/api.php/provide/vod"}]` 按点播列表处理。

地址按 URL 去重；点播地址会去尾部斜杠，两类地址均会去除尾部空的 `?`、`#`，带实际参数的查询串保留。直播 URL 的尾部斜杠不作同样裁剪。

订阅 JSON 由服务端拉取，不要求源列表托管方配置浏览器 CORS。订阅地址本身只允许公网 HTTP(S)。导入的点播源同样拒绝内网；直播源默认拒绝内网，部署者显式设置 `LIVE_ALLOW_PRIVATE=1` 后可使用自建内网 IPTV，这个开关不放开订阅地址和点播源。

## TVBOX 配置

订阅入口可直接读取含 `sites` / `lives` 的 TVBOX JSON，按当前能够执行的接口导入：

- 点播：支持 `type: 1` 的 JSON 接口。类型省略或为 `0`、`4` 时，只有地址匹配 `api.php/provide/vod` 且不走 XML 通道才可导入。声明 `searchable: 0` 的条目跳过。
- 直播：支持 `type: 0` 或省略类型的播放列表，可附 `epg`；不支持单仓 JSON 直播和 TXT 频道列表。
- `type: 3`、`csp_*`、JAR、JS、Python 及本地脚本资源需要 TVBOX 引擎，当前不会执行。XML 和不能识别为 CMS 的外链站点也会跳过。

导入结果会显示跳过原因与超限截断数量；一个配置有很多条目，最终只导入少数可用接口可能是正常结果。支持字符串外的行注释、块注释和尾随逗号，也会处理字符串内的裸控制字符；仍建议发布标准 JSON。

顶层只有 `urls` 的多仓配置、Base64 或压缩包装不受支持。填写具体源列表的 JSON 地址，不要把网页介绍页当作配置文件。

## 接口目录格式

也接受只含点播源的目录数组：

```json
[
  { "name": "接口示例", "baseUrl": "https://example.com/api.php/provide/vod" },
  { "name": "停用示例", "baseUrl": "https://example.com/old/api.php/provide/vod", "enabled": false }
]
```

只有所有条目都带 `baseUrl` 时才识别为接口目录。`enabled: false` 跳过，其余按地址去重和点播上限导入；混合 `baseUrl` 与 `url` 两种条目会报错，避免静默遗漏其中一批。

## 刷新、停用与过滤

手动添加的订阅默认只在点击同步时刷新。可选择每天、每 3/7/14/30 天；到期检查发生在打开站点等应用初始化过程中，不是关闭网页后仍在运行的计划任务。离线或后台标签页会跳过自动刷新，每轮最多处理 5 个订阅、并发 2 个。

部署者的 `DEFAULT_SUBSCRIPTIONS` 也可使用 `{ "url": "...", "name": "...", "refreshDays": 7 }`，周期限定为 1–365 天，省略时按 1 天；用户在面板调整过的周期优先。用户删除过的预置订阅不会因下次打开站点被重新添加。

订阅同步失败保留旧数据；连续 3 次计入失败后暂停自动刷新，手动同步成功清零并恢复。会话鉴权失败不会计入这项失败次数。订阅同步按远端内容整体更新，手工修改其中的源可能在下次同步被覆盖，已有源的勾选状态按地址保留。

点播源还有独立的搜索健康状态：连续 2 次失败或超时后暂时停止参与搜索，重复失败按 30 分钟、24 小时、长期停用逐级处理；可以在源管理恢复。它与订阅自动刷新的暂停不是同一个状态。

成人内容过滤默认开启，依据源的 `isAdult` 标记阻止启用和参与搜索；它不分析影片内容，也不能修正提供方漏标的信息。

删除订阅会移除它名下的点播源。直播列表可被多个订阅共享，只移除本订阅的引用；仍有引用的列表和用户收藏的频道保留，手动添加的直播源不由订阅接管。

## 导出与分享

「导出数据源」将当前点播源与直播源去重后保存为 JSON，可自行托管后供他人订阅。「发布为链接」则把当前已勾选启用的源上传到第三方公共服务，每次生成新链接，不会覆盖旧链接。发布前检查内容，避免上传带凭据的地址或私有配置；公开托管的列表不是私密备份。

解析与同步实现见 [`source-list.ts`](../src/lib/source-list.ts)、[`tvbox-parser.ts`](../src/lib/tvbox-parser.ts) 和 [`subscription-sync.ts`](../src/lib/subscription-sync.ts)。它们的同目录测试覆盖格式识别、去重、更新归属和失败处理。
