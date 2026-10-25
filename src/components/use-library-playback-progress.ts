'use client';

import { useCallback, useRef, useState } from 'react';

/** Serialize small, dirty snapshots so late requests cannot rewind linked progress. */
export function useLibraryPlaybackProgress() {
  const states = useRef(new Map<string, { pending?: string; saved?: string; sending: boolean }>());
  const [saveError, setSaveError] = useState(false);
  const save = useCallback((id: string | undefined, position: number, duration: number) => {
    if (!id || !/^[a-f0-9]{32}$/.test(id) || !Number.isFinite(position) || position < 0
      || !Number.isFinite(duration) || duration <= 0) return;
    const state = states.current.get(id) || { sending: false };
    states.current.set(id, state);
    const body = JSON.stringify({ position: Math.min(position, duration), duration });
    if (body === state.saved && !state.pending) return;
    state.pending = body;
    const flush = () => {
      if (state.sending || !state.pending || state.pending === state.saved) return;
      const snapshot = state.pending;
      state.sending = true;
      let succeeded = false;
      void fetch(`/api/library/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: snapshot, keepalive: true })
        .then((response) => { succeeded = response.ok; if (response.ok) state.saved = snapshot; setSaveError(!response.ok); })
        .catch(() => setSaveError(true))
        .finally(() => {
          state.sending = false;
          if (state.pending === state.saved) state.pending = undefined;
          if (succeeded && state.pending) flush();
        });
    };
    flush();
  }, []);
  return { save, saveError };
}
