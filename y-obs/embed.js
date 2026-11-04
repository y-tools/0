[Reading 34 lines from start (total: 34 lines, 0 remaining)]

'use strict';
// Only active in ?embed=1. This alters presentation, never streaming/auth logic.
(() => {
  if (!document.documentElement.classList.contains('yplus-embedded')) return;
  if (window.parent === window) return;

  const layout = document.querySelector('.layout');
  if (!layout) return;
  let last = -1;
  let scheduled = false;
  const sendHeight = () => {
    scheduled = false;
    // The content wrapper's physical height avoids iframe viewport feedback loops.
    const height = Math.max(250, Math.ceil(layout.getBoundingClientRect().height) + 2);
    if (Math.abs(height - last) < 2) return;
    last = height;
    try {
      window.parent.postMessage({type:'yplus:yobs:height',height}, location.origin);
    } catch {}
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(sendHeight);
  };
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(schedule);
    observer.observe(layout);
  }
  window.addEventListener('resize',schedule);
  window.addEventListener('load',schedule);
  document.fonts?.ready.then(schedule).catch(()=>{});
  schedule();
})();

[executed on device: hiratayuusukenoMacBook-Air.local (348dc674-ae2f-4808-9160-3521fd911771)]