/**
 * Run something once after paint — or on a timer, if paint never comes.
 *
 * Deferring startup work to `requestAnimationFrame` keeps it off the critical
 * path of the first render, which is why it is used in several places here. The
 * catch is that a hidden window gets no animation frames at all, and a desktop
 * app has ordinary ways of starting hidden: launched minimised, opened on
 * another Space, or restored fully behind another window. Work parked on rAF in
 * that state never runs, and nothing reschedules it — the panel simply sits on
 * its loading line until the person clicks something that happens to trigger a
 * refresh, or restarts the app.
 *
 * Timers keep running while hidden (throttled, but they arrive), so the two are
 * raced and whichever fires first wins. Visible windows are unaffected: the
 * frame lands well inside the fallback.
 *
 * Returns the cleanup, to be returned from or called inside an effect.
 */
export function afterPaint(run: () => void, fallbackMs = 60): () => void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    run();
  };
  const frame = window.requestAnimationFrame(once);
  const timer = window.setTimeout(once, fallbackMs);
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}
