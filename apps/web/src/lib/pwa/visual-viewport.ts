/**
 * Keyboard-aware sizing for iOS, above all the installed app (#155).
 *
 * When the iOS keyboard opens, the layout viewport keeps its size and only the
 * visual viewport shrinks; iOS then pans the page to reveal the focused input.
 * Dialogs sized with `vh` stay taller than what is visible, so fields end up
 * under the keyboard and moving between them makes the page jump.
 *
 * This publishes the visible area as CSS variables on <html>:
 *   --vv-height  visualViewport.height (px)
 *   --vv-top     visualViewport.offsetTop (px)
 * Dialogs centre themselves in, and cap their height to, that area (fallbacks
 * keep the old behaviour where the API is missing).
 *
 * It also undoes the pan iOS sometimes leaves behind when the keyboard closes:
 * when the document is not meant to scroll at all (the app shell is pinned to
 * the screen) any leftover window scroll is an artifact, so it is reset.
 */
export function installVisualViewportVars(): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};

  const root = document.documentElement;
  let frame = 0;

  const update = () => {
    frame = 0;
    root.style.setProperty('--vv-height', `${vv.height}px`);
    root.style.setProperty('--vv-top', `${vv.offsetTop}px`);

    const keyboardClosed = vv.height >= window.innerHeight - 1;
    const documentFits = root.scrollHeight <= window.innerHeight + 1;
    if (keyboardClosed && documentFits && window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  update();
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}
