import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: '播放' };

export default function LibraryPlaybackLayout({ children }: { children: ReactNode }) {
  return children;
}
