/** A single idle deadline shared by the picture and its controls. */
export function createControlAutoHide(onVisible: (visible: boolean) => void, delayMs = 2500) {
  let paused = true;
  let visible = true;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const held = new Set<string>();
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const show = () => { if (!visible) { visible = true; onVisible(true); } };
  const activity = () => {
    if (disposed) return;
    clear(); show();
    if (!paused && !held.size) timer = setTimeout(() => {
      timer = undefined;
      if (!disposed && !paused && !held.size) { visible = false; onVisible(false); }
    }, delayMs);
  };
  onVisible(true);
  return {
    activity,
    setPaused(value: boolean) {
      if (disposed || paused === value) return;
      paused = value;
      activity();
    },
    hold(reason: string, active: boolean) {
      if (disposed || held.has(reason) === active) return;
      if (active) held.add(reason); else held.delete(reason);
      activity();
    },
    dispose() { disposed = true; clear(); held.clear(); },
  };
}
