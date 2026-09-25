// Static IDE pane layout: detachable, draggable, resizable windows.
function initWindowManager() {
  const app = document.getElementById('app');
  const main = document.querySelector('.main');
  const specs = [
    ['files', document.querySelector('.files'), '.panel-head'],
    ['editor', document.querySelector('.editor'), '.editor-titlebar'],
    ['side', document.querySelector('.side'), '.panel-head'],
    ['bottom', document.querySelector('.bottom'), '.bottom-tabs'],
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
    const columns = [left && '250px', center && 'minmax(280px, 1fr)', right && '380px'].filter(Boolean);
    main.style.gridTemplateColumns = columns.length ? columns.join(' ') : '1fr';
    let col = 1;
    for (const [id, pane] of panes) {
      if (id === 'bottom' || pane.classList.contains('floating')) continue;
      pane.style.gridColumn = String(col++);
    }
    app.classList.toggle('bottom-floating', !!floating('bottom'));
  }
  function floatPane(id, pane, header, button) {
    pane.classList.add('floating');
    const fallback = id === 'bottom'
      ? { left: 260, top: innerHeight - 330, width: Math.min(900, innerWidth - 40), height: 290 }
      : { left: id === 'files' ? 270 : id === 'editor' ? 300 : 360, top: 70, width: id === 'files' ? 300 : id === 'editor' ? 700 : 470, height: id === 'side' ? 620 : 500 };
    const r = saved[id] || fallback;
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
    const actions = id === 'editor' ? header.querySelector('.pane-actions') : id === 'bottom' ? header.querySelector('.pane-actions') : header.querySelector('.pane-actions');
    if (!pane || !header || !actions) continue;
    pane.dataset.pane = id;
    const button = document.createElement('button');
    button.className = 'pane-toggle'; button.type = 'button'; button.textContent = 'Float';
    button.title = `Float ${id}`; button.setAttribute('aria-label', `Float ${id}`);
    actions.appendChild(button);
    panes.set(id, pane);
    button.addEventListener('click', () => pane.classList.contains('floating') ? dockPane(id, pane, button) : floatPane(id, pane, header, button));
    pane.addEventListener('pointerdown', () => { if (pane.classList.contains('floating')) pane.style.zIndex = String(++z); });
    header.classList.add('pane-drag-handle');
    header.addEventListener('pointerdown', (event) => {
      if (!pane.classList.contains('floating') || event.button !== 0 || event.target.closest('button,input,select,a,.editor-tab')) return;
      const rect = pane.getBoundingClientRect();
      const dx = event.clientX - rect.left, dy = event.clientY - rect.top;
      pane.style.zIndex = String(++z);
      header.setPointerCapture(event.pointerId);
      const move = (e) => {
        pane.style.left = `${Math.max(0, Math.min(innerWidth - 100, e.clientX - dx))}px`;
        pane.style.top = `${Math.max(46, Math.min(innerHeight - 50, e.clientY - dy))}px`;
      };
      const end = () => { header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', end); persist(); };
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', end, { once: true });
      event.preventDefault();
    });
    if (saved[id]) floatPane(id, pane, header, button);
  }
  syncGrid();
  window.addEventListener('resize', () => {
    for (const pane of panes.values()) if (pane.classList.contains('floating')) {
      const r = pane.getBoundingClientRect();
      pane.style.left = `${Math.max(0, Math.min(innerWidth - 160, r.left))}px`;
      pane.style.top = `${Math.max(46, Math.min(innerHeight - 100, r.top))}px`;
    }
    persist();
  });
  document.addEventListener('pointerup', persist);
}
