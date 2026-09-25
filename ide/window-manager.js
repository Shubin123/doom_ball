// Static IDE pane layout: detachable, draggable, resizable windows.
function initWindowManager() {
  const app = document.getElementById('app');
  const main = document.querySelector('.main');
  const specs = [
    ['files', document.querySelector('.files'), '.panel-head'],
    ['editor', document.querySelector('.editor'), '.editor-titlebar'],
    ['side', document.querySelector('.side'), '.panel-head'],
    ['bottom', document.querySelector('.bottom'), '.bottom-tabs'],
    ['clock', document.querySelector('.clock-pane'), '.panel-head'],
  ];
  const key = 'stm32-forge-pane-layout-v1';
  let saved = {};
  let z = 20;
  try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
  const persist = () => {
    const layout = {};
    for (const [id, pane] of panes) {
      if (!pane.classList.contains('floating')) continue;
      const r = pane.getBoundingClientRect();
      layout[id] = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    }
    try { localStorage.setItem(key, JSON.stringify(layout)); } catch {}
  };
  const panes = new Map();
  function syncGrid() {
    const floating = (id) => panes.get(id)?.classList.contains('floating');
    const left = !floating('files'), center = !floating('editor'), right = !floating('side');
    const clock = !panes.get('clock')?.hidden && !floating('clock');
    const columns = [left && '250px', center && 'minmax(280px, 1fr)', right && '380px', clock && 'minmax(260px, 0.8fr)'].filter(Boolean);
    main.style.gridTemplateColumns = columns.length ? columns.join(' ') : '1fr';
    let col = 1;
    for (const [id, pane] of panes) {
      if (id === 'bottom' || pane.hidden || pane.classList.contains('floating')) continue;
      pane.style.gridColumn = String(col++);
    }
    app.classList.toggle('bottom-floating', !!floating('bottom'));
  }
  function floatPane(id, pane, header, button, placement) {
    pane.classList.add('floating');
    const fallback = id === 'bottom'
      ? { left: 260, top: innerHeight - 330, width: Math.min(900, innerWidth - 40), height: 290 }
      : { left: id === 'files' ? 270 : id === 'editor' ? 300 : 360, top: 70, width: id === 'files' ? 300 : id === 'editor' ? 700 : 470, height: id === 'side' ? 620 : 500 };
    const r = placement || saved[id] || fallback;
    pane.style.left = `${Math.max(0, Math.min(innerWidth - 180, r.left))}px`;
    pane.style.top = `${Math.max(46, Math.min(innerHeight - 120, r.top))}px`;
    pane.style.width = `${Math.max(220, Math.min(innerWidth, r.width))}px`;
    pane.style.height = `${Math.max(140, Math.min(innerHeight - 46, r.height))}px`;
    pane.style.zIndex = String(++z);
    button.textContent = 'Dock'; button.title = `Dock ${id}`; button.setAttribute('aria-label', `Dock ${id}`);
    syncGrid(); persist();
  }
  function dockPane(id, pane, button) {
    pane.classList.remove('floating');
    for (const property of ['left', 'top', 'width', 'height', 'zIndex']) pane.style.removeProperty(property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
    button.textContent = 'Float'; button.title = `Float ${id}`; button.setAttribute('aria-label', `Float ${id}`);
    syncGrid(); persist();
  }
  for (const [id, pane, headerSelector] of specs) {
    const header = pane.querySelector(headerSelector);
    const actions = header.querySelector('.pane-actions');
    if (!pane || !header || !actions) continue;
    pane.dataset.pane = id;
    const button = document.createElement('button');
    button.className = 'pane-toggle'; button.type = 'button'; button.textContent = 'Float';
    button.title = `Float ${id}`; button.setAttribute('aria-label', `Float ${id}`);
    actions.appendChild(button);
    const grip = document.createElement('span');
    grip.className = 'pane-grip'; grip.textContent = '⠿'; grip.title = `Drag to move ${id}`;
    grip.setAttribute('aria-label', `Drag to move ${id}`); actions.appendChild(grip);
    panes.set(id, pane);
    button.addEventListener('click', () => pane.classList.contains('floating') ? dockPane(id, pane, button) : floatPane(id, pane, header, button));
    pane.addEventListener('pointerdown', () => { if (pane.classList.contains('floating')) pane.style.zIndex = String(++z); });
    header.classList.add('pane-drag-handle');
    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button,input,select,a,.editor-tab') ||
          (id === 'editor' && event.target.closest('.editor-tabs') && !event.target.closest('.pane-grip'))) return;
      const start = { x: event.clientX, y: event.clientY };
      const rect = pane.getBoundingClientRect();
      const offset = { x: start.x - rect.left, y: start.y - rect.top };
      let dragging = false, frame = 0, latest = null;
      const move = (e) => {
        if (e.pointerId !== event.pointerId) return;
        latest = e;
        if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
        if (!dragging) {
          dragging = true;
          if (!pane.classList.contains('floating')) floatPane(id, pane, header, button, {
            left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          });
          pane.style.zIndex = String(++z);
          header.classList.add('is-dragging');
        }
        if (!frame) frame = requestAnimationFrame(() => {
          frame = 0;
          if (!latest) return;
          pane.style.left = `${Math.max(0, Math.min(innerWidth - 100, latest.clientX - offset.x))}px`;
          pane.style.top = `${Math.max(46, Math.min(innerHeight - 50, latest.clientY - offset.y))}px`;
        });
        e.preventDefault();
      };
      const end = (e) => {
        if (e.pointerId !== event.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        header.classList.remove('is-dragging');
        if (frame) cancelAnimationFrame(frame);
        if (dragging) { persist(); event.preventDefault(); }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    if (saved[id] && !pane.hidden) floatPane(id, pane, header, button);
  }
  syncGrid();
  const clockPane = panes.get('clock');
  const clockButton = document.getElementById('btn-clock');
  clockButton?.addEventListener('click', () => {
    if (clockPane.hidden) {
      clockPane.hidden = false;
      floatPane('clock', clockPane, clockPane.querySelector('.panel-head'), clockPane.querySelector('.pane-toggle'));
      clockButton.setAttribute('aria-pressed', 'true');
      document.dispatchEvent(new CustomEvent('clockpanechange', { detail: { open: true } }));
    } else {
      dockPane('clock', clockPane, clockPane.querySelector('.pane-toggle'));
      clockPane.hidden = true;
      clockButton.setAttribute('aria-pressed', 'false');
      syncGrid();
      document.dispatchEvent(new CustomEvent('clockpanechange', { detail: { open: false } }));
    }
  });
  window.addEventListener('resize', () => {
    for (const pane of panes.values()) if (pane.classList.contains('floating')) {
      const r = pane.getBoundingClientRect();
      pane.style.left = `${Math.max(0, Math.min(innerWidth - 160, r.left))}px`;
      pane.style.top = `${Math.max(46, Math.min(innerHeight - 100, r.top))}px`;
    }
    persist();
  });
  document.addEventListener('pointerup', persist);
  return {
    refresh: syncGrid,
    close: (id) => {
      const pane = panes.get(id), button = pane?.querySelector('.pane-toggle');
      if (!pane) return;
      if (pane.classList.contains('floating')) dockPane(id, pane, button);
      pane.hidden = true; syncGrid(); persist();
      if (id === 'clock') document.getElementById('btn-clock')?.setAttribute('aria-pressed', 'false');
    },
  };
}
