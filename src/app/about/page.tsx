'use client';

import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { APP_NAME } from '@/lib/brand';

export default function AboutPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-10 space-y-8">
        <section>
          <h1 className="text-xl font-bold text-content mb-3">关于{APP_NAME}</h1>
          <p className="text-sm text-muted leading-relaxed">
            个人影视库与在线播放工具，基于 LibreTV 修改，按 AGPL-3.0 发布。
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">快捷键</h2>
          <ul className="text-sm text-muted space-y-1.5 list-disc list-inside">
            <li><code className="text-accent">空格</code> 播放 / 暂停</li>
            <li><code className="text-accent">←</code> / <code className="text-accent">→</code> 快退 / 快进 5 秒</li>
            <li><code className="text-accent">↑</code> / <code className="text-accent">↓</code> 音量调节</li>
            <li><code className="text-accent">F</code> 切换全屏</li>
            <li><code className="text-accent">Alt + ←/→</code> 上一集 / 下一集</li>
            <li>长按视频临时 2 倍速，松开恢复原速</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">存储</h2>
          <p className="text-sm text-muted leading-relaxed">
            目录索引引用硬盘原片，海报、简介与片库进度保存在本机。
            服务器片库与配对的 Mac 缓存同步进度；搜索播放历史保存在当前浏览器。
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">源码</h2>
          <p className="text-sm text-muted leading-relaxed flex gap-4">
            <a className="hover:text-accent" href="https://github.com/SakuraWang6/LibreTV" target="_blank" rel="noopener noreferrer">{APP_NAME}</a>
            <a className="hover:text-accent" href="https://github.com/LibreSpark/LibreTV" target="_blank" rel="noopener noreferrer">LibreTV 上游</a>
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
