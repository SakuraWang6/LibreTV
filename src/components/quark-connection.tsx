'use client';

import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { checkQuarkLogin, completeQuarkLogin, fetchQuarkStatus, QUARK_STATUS_QUERY_KEY, startQuarkLogin } from '@/lib/quark-client';

export function QuarkConnection() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'login' | 'check' | 'complete' | null>(null);
  const [error, setError] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState('');
  const codeFormId = useId();
  const query = useQuery({ queryKey: QUARK_STATUS_QUERY_KEY, queryFn: fetchQuarkStatus, retry: false, staleTime: 10_000 });
  if (!query.data?.enabled) return null;

  const act = async (action: 'login' | 'check') => {
    if (busy) return;
    setBusy(action); setError('');
    try {
      if (action === 'login') {
        const result = await startQuarkLogin();
        setAuthUrl(result.authUrl || ''); setPending(Boolean(result.pending));
      }
      else {
        const status = await checkQuarkLogin();
        queryClient.setQueryData(QUARK_STATUS_QUERY_KEY, status);
        if (status.connected) { setAuthUrl(''); setPending(false); setCode(''); setShowCode(false); }
        else { setPending(Boolean(status.pending)); setError(status.error || '尚未完成登录'); }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '夸克连接失败'); }
    finally { setBusy(null); }
  };

  const complete = async () => {
    if (busy) return;
    setBusy('complete'); setError('');
    try {
      const status = await completeQuarkLogin(code);
      queryClient.setQueryData(QUARK_STATUS_QUERY_KEY, status);
      if (status.connected) { setAuthUrl(''); setPending(false); setShowCode(false); }
      else { setPending(Boolean(status.pending)); setError(status.error || '连接未完成，请重试'); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '夸克连接失败'); }
    finally { setCode(''); setBusy(null); }
  };

  return <div className="mb-4 rounded-lg border border-line bg-chip px-3 py-2.5">
    <div className="flex flex-wrap items-center gap-3">
      <strong className="text-xs text-content">夸克网盘</strong>
      <span className="text-xs text-muted" role="status">{query.data.connected ? query.data.accountLabel || '已连接' : pending || query.data.pending ? '等待登录' : '未连接'}</span>
      <div className="ml-auto flex items-center gap-2">
        {!query.data.connected && (authUrl
          ? <a className="btn-primary btn-sm" href={authUrl} target="_blank" rel="noopener noreferrer">前往夸克登录</a>
          : <button type="button" className="btn-ghost btn-sm" disabled={busy !== null} onClick={() => void act('login')}>{busy === 'login' ? '正在准备…' : '登录夸克'}</button>)}
        <button type="button" className="btn-ghost btn-sm" disabled={busy !== null} onClick={() => void act('check')}>{busy === 'check' ? '检查中…' : '检查登录'}</button>
      </div>
    </div>
    {!query.data.connected && <div className="mt-2">
      <button type="button" className="text-xs text-accent disabled:opacity-40" disabled={busy !== null} aria-expanded={showCode} aria-controls={codeFormId} onClick={() => { setShowCode((value) => !value); setCode(''); }}>填写授权码</button>
      {showCode && <form id={codeFormId} className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void complete(); }}>
        <label className="min-w-0 flex-1 text-xs text-muted">授权码<input className="input mt-1 block w-full" type="password" autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder="授权码" maxLength={36} value={code} disabled={busy !== null} onChange={(event) => setCode(event.target.value)} /></label>
        <button type="submit" className="btn-primary btn-sm mb-1" disabled={busy !== null || !code.trim()}>{busy === 'complete' ? '连接中…' : '完成连接'}</button>
      </form>}
    </div>}
    {(error || query.data.error) && <p role="alert" className="mt-2 text-xs text-danger">{error || query.data.error}</p>}
  </div>;
}
