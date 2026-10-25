import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { APP_NAME } from '@/lib/brand';

export const metadata: Metadata = {
  title: {
    default: `${APP_NAME} · 影视库`,
    template: `%s - ${APP_NAME}`,
  },
  description:
    '影视库、在线播放与离线收藏。',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico?v=guangying', sizes: '48x48' },
      { url: '/icons/mark.svg', sizes: 'any', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png?v=guangying', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png?v=guangying', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png?v=guangying', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#f5f5f7',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首屏前同步主题，避免亮暗闪烁 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('libretv-theme')||'light';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})()",
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
