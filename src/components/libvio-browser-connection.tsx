'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface BrowserStatus { enabled: boolean; connected?: boolean; verified?: boolean }

export function LibvioBrowserConnection() {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const query = useQuery<BrowserStatus>({
    queryKey: ['libvio-browser-status'],
    queryFn: async () => {
      const response = await fetch('/api/libvio-browser', { cache: 'no-store' });
      if (!response.ok) return { enabled: false };
      return response.json();
    },
    retry: false,
    refetchInterval: (state) => state.state.data?.enabled ? 5000 : false,
  });
  if (!query.data?.enabled) return null;
  const open = async () => {
    setOpening(true); setError('');
    try {
      const response = await fetch('/api/libvio-browser', { method: 'POST' });
      if (!response.ok) throw new Error('Chrome 连接失败');
      await query.refetch();
    } catch { setError('Chrome 连接失败'); }
    finally { setOpening(false); }
  };
  return <div className="mb-4 flex items-center gap-3 rounded-lg border border-line bg-chip px-3 py-2.5">
    <strong className="text-xs text-content">LIBVIO</strong>
    <span className="text-xs text-muted" role="status">{error || (query.data.verified ? 'Chrome 已连接' : query.data.connected ? '等待验证' : '未连接')}</span>
    <button type="button" className="btn-ghost btn-sm ml-auto" disabled={opening} onClick={() => void open()}>{opening ? '正在连接…' : '打开 Chrome'}</button>
  </div>;
}
