'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Header } from '@/components/header';
import { useAuth } from '@/components/auth';
import { fetchLibrary } from '@/lib/local-library/client';
import { LOCAL_LIBRARY_UPDATED_EVENT, type LibraryEntry } from '@/lib/local-library/types';
import { LibraryPlayer } from '../../library-player';
import { LibraryIcon, orderedEpisodes } from '../../library-ui';
import styles from '../../library.module.css';

export default function LibraryPlaybackPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { checked, verified, openLogin } = useAuth();
  const [items, setItems] = useState<LibraryEntry[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!verified) return;
    try {
      const result = await fetchLibrary();
      setItems(result.items);
      setEnabled(result.enabled);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '影片读取失败');
    } finally {
      setLoading(false);
    }
  }, [verified]);

  useEffect(() => {
    if (!verified) {
      if (checked) setLoading(false);
      return;
    }
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener(LOCAL_LIBRARY_UPDATED_EVENT, onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener(LOCAL_LIBRARY_UPDATED_EVENT, onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [checked, verified, refresh]);

  const entry = items.find((item) => item.id === id);
  const episodes = useMemo(() => entry?.kind === 'tv'
    ? orderedEpisodes(items.filter((item) => item.kind === 'tv' && item.groupId === entry.groupId))
    : entry ? [entry] : [], [entry, items]);

  const selectEntry = useCallback((nextId: string) => {
    router.push(`/library/play/${encodeURIComponent(nextId)}`);
  }, [router]);

  const updateProgress = useCallback((entryId: string, position: number, duration: number) => {
    setItems((current) => current.map((item) => item.id === entryId
      ? { ...item, position, duration, lastPlayedAt: new Date().toISOString() } : item));
  }, []);

  return <div className={styles.page}>
    <Header />
    <main className={`${styles.main} ${styles.playerPage}`}>
      <nav className={styles.playerNavigation} aria-label="播放导航"><Link href="/library" className={styles.textButton}><LibraryIcon name="arrow" />返回片库</Link></nav>
      {!checked || (verified && loading) ? <div className={styles.loading} role="status"><span />正在打开影片…</div>
        : !verified ? <div className={styles.statePanel}><span className={styles.stateIcon}><LibraryIcon name="folder" /></span><h1>影视库已锁定</h1><div className={styles.stateActions}><button className={styles.primaryButton} onClick={openLogin}>解锁</button></div></div>
          : enabled === false ? <div className={styles.statePanel}><h1>影视库尚未启用</h1></div>
            : !entry ? <div className={styles.statePanel}><span className={styles.stateIcon}><LibraryIcon name="film" /></span><h1>{error ? '暂时无法打开影片' : '影片不在当前片库中'}</h1>{error && <p role="alert">{error}</p>}<div className={styles.stateActions}><button className={styles.secondaryButton} onClick={() => void refresh()}>重新读取</button><Link href="/library" className={styles.secondaryButton}>返回片库</Link></div></div>
              : <>
                {error && <div className={styles.errorBanner} role="status">{error}<button onClick={() => void refresh()}>重试</button></div>}
                <LibraryPlayer key={entry.id} entry={entry} episodes={episodes} onSelect={selectEntry} onProgress={updateProgress} />
              </>}
    </main>
  </div>;
}
