(() => {
  // Only the top frame, and only once (background.js may inject us again).
  if (window.top !== window || window.__gitpinLoaded) return;
  window.__gitpinLoaded = true;

  const Store = globalThis.GitPinStore;
  const IS_GITHUB = location.hostname === 'github.com';
  const PIN_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 1h7v1.6l-1.25.65V7.1L13 9.35v1.4H8.75V15L8 16l-.75-1v-4.25H3v-1.4L5.75 7.1V3.25L4.5 2.6z"/></svg>';

  // First path segments on github.com that are never repo owners.
  const RESERVED = new Set(
    ('about account apps codespaces collections contact copilot customer-stories dashboard enterprise ' +
      'events explore features github-copilot issues login logout marketplace new notifications orgs ' +
      'organizations partners pricing pulls readme resources search security settings signup site ' +
      'solutions sponsors stars team topics trending users watching').split(' ')
  );

  // "owner/repo" if the URL is a GitHub repo root, else null.
  function repoFromUrl(href) {
    let u;
    try {
      u = new URL(href, location.href);
    } catch {
      return null;
    }
    if (u.hostname !== 'github.com' || u.search) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || RESERVED.has(parts[0].toLowerCase())) return null;
    return parts.join('/');
  }

  // GitHub org/user a pinned URL belongs to (any github.com page under them), else null.
  function ownerOf(href) {
    try {
      const u = new URL(href);
      const owner = u.hostname === 'github.com' && u.pathname.split('/').filter(Boolean)[0];
      return owner && !RESERVED.has(owner.toLowerCase()) ? owner : null;
    } catch {
      return null;
    }
  }

  let pins = [];
  let pinned = new Set();
  let collapsed = new Set();
  let isOpen = false;
  let lastContextLink = null;

  // ---------- Drawer (in a shadow root so page styles can't leak in) ----------

  const host = document.createElement('div');
  host.id = 'gitpin-root';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${DRAWER_CSS()}</style>
    <button class="handle" title="Pinned links (${navigator.platform.startsWith('Mac') ? '⌃⇧P' : 'Alt+Shift+P'})" ${IS_GITHUB ? '' : 'hidden'}>${PIN_SVG}</button>
    <aside class="drawer" aria-label="GitPin">
      <header>
        <span class="title">${PIN_SVG} Pinned <span class="count"></span></span>
        <button class="close" title="Close (Esc)">✕</button>
      </header>
      <div class="tools">
        <input class="search" type="search" placeholder="Filter…  ↵ opens first match" spellcheck="false">
        <button class="pin-page"></button>
      </div>
      <div class="list"></div>
      <p class="empty"></p>
    </aside>`;
  document.documentElement.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const drawer = $('.drawer');
  const list = $('.list');
  const search = $('.search');
  const pinPageBtn = $('.pin-page');

  function setOpen(open) {
    isOpen = open;
    drawer.classList.toggle('open', open);
    $('.handle').classList.toggle('hide', open);
    if (open) {
      search.value = '';
      render();
      setTimeout(() => search.focus(), 120);
    }
  }

  function iconFor(url) {
    return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
  }

  function subtitle(url) {
    try {
      const u = new URL(url);
      return (u.hostname + u.pathname).replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  function filtered() {
    const q = search.value.trim().toLowerCase();
    if (!q) return pins;
    return pins.filter((p) => (p.title + ' ' + p.url).toLowerCase().includes(q));
  }

  // Pins grouped by GitHub org/user, in order of first appearance; other links last.
  function grouped(list) {
    const groups = new Map();
    for (const p of list) {
      const owner = ownerOf(p.url) || '';
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push(p);
    }
    const links = groups.get('');
    groups.delete('');
    if (links) groups.set('', links);
    return groups;
  }

  function pinRow(p, owner, draggable) {
    const li = document.createElement('li');
    li.dataset.url = p.url;
    li.draggable = draggable;
    const a = document.createElement('a');
    a.href = p.url;
    a.title = p.url;
    const text = document.createElement('span');
    text.className = 'text';
    const name = document.createElement('span');
    name.className = 'name';
    // Inside an org group the "owner/" prefix is redundant.
    name.textContent = owner && p.title.startsWith(owner + '/') ? p.title.slice(owner.length + 1) : p.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = subtitle(p.url);
    text.append(name, sub);
    // Org groups show the avatar in the header, so only loose links get an icon.
    if (!owner) {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = iconFor(p.url);
      a.append(img);
    }
    a.append(text);
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = 'Unpin';
    remove.textContent = '✕';
    remove.onclick = () => Store.removePin(p.url);
    li.append(a, remove);
    return li;
  }

  function render() {
    const shown = filtered();
    const filtering = shown !== pins;
    const sections = [];
    for (const [owner, items] of grouped(shown)) {
      const section = document.createElement('section');
      section.className = 'group';
      section.dataset.owner = owner;
      const closed = !filtering && collapsed.has(owner);
      section.classList.toggle('collapsed', closed);

      const head = document.createElement('button');
      head.className = 'group-h';
      head.setAttribute('aria-expanded', !closed);
      head.innerHTML = '<svg class="caret" viewBox="0 0 12 12"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      if (owner) {
        const avatar = document.createElement('img');
        avatar.alt = '';
        avatar.referrerPolicy = 'no-referrer';
        avatar.src = `https://github.com/${owner}.png?size=40`;
        avatar.onerror = () => avatar.remove();
        head.append(avatar);
      }
      const label = document.createElement('span');
      label.className = 'group-name';
      label.textContent = owner || 'Links';
      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = items.length;
      head.append(label, count);
      head.onclick = () => toggleGroup(owner);

      const ul = document.createElement('ul');
      ul.append(...items.map((p) => pinRow(p, owner, !filtering)));
      section.append(head, ul);
      sections.push(section);
    }
    list.replaceChildren(...sections);

    $('.count').textContent = pins.length ? `(${pins.length})` : '';
    const empty = $('.empty');
    empty.hidden = shown.length > 0;
    empty.textContent = pins.length
      ? 'No pins match.'
      : IS_GITHUB
        ? 'Click the pin next to any repo, or right-click any link → “Pin link to GitPin”.'
        : 'Right-click any link → “Pin link to GitPin”, or pin this page above.';
    const here = pinned.has(Store.normalize(location.href));
    pinPageBtn.textContent = here ? 'Unpin this page' : 'Pin this page';
    pinPageBtn.classList.toggle('active', here);
  }

  function toggleGroup(owner) {
    if (collapsed.has(owner)) collapsed.delete(owner);
    else collapsed.add(owner);
    chrome.storage.local.set({ collapsed: [...collapsed] });
    render();
  }

  function pageTitle() {
    return repoFromUrl(location.href) || document.title || location.href;
  }

  $('.handle').onclick = () => setOpen(true);
  $('.close').onclick = () => setOpen(false);
  pinPageBtn.onclick = () => Store.togglePin(location.href, pageTitle());
  search.oninput = render;
  search.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const first = filtered()[0];
    if (!first) return;
    if (e.metaKey || e.ctrlKey) window.open(first.url, '_blank');
    else location.href = first.url;
  };
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
  document.addEventListener('mousedown', (e) => {
    if (!isOpen) return;
    const path = e.composedPath();
    if (path.includes(host) || path.some((n) => n.classList?.contains('gitpin-btn'))) return;
    setOpen(false);
  });

  // Drag to reorder: move the row live, save the DOM order on drop.
  let dragging = null;
  list.addEventListener('dragstart', (e) => {
    dragging = e.target.closest('li');
    dragging?.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest('li');
    if (!over || over === dragging || over.parentNode !== dragging.parentNode) return;
    const { top, height } = over.getBoundingClientRect();
    over[e.clientY < top + height / 2 ? 'before' : 'after'](dragging);
  });
  list.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    const order = [...list.querySelectorAll('li')].map((li) => li.dataset.url);
    Store.savePins(order.map((url) => pins.find((p) => p.url === url)).filter(Boolean));
  });

  // ---------- Pin buttons next to repo links on github.com ----------

  const seen = new WeakSet();

  function syncButton(btn) {
    const on = pinned.has(btn.dataset.url);
    btn.setAttribute('aria-pressed', on);
    btn.title = on ? 'Unpin from GitPin' : 'Pin to GitPin';
  }

  function decorate() {
    for (const a of document.querySelectorAll('a[href]')) {
      if (seen.has(a)) continue;
      seen.add(a);
      const repo = repoFromUrl(a.href);
      if (!repo) continue;
      // Only links that read like the repo name — skips avatars, "Star" links, etc.
      const text = a.textContent.replace(/\s+/g, '').toLowerCase();
      if (!text.endsWith(repo.split('/')[1].toLowerCase())) continue;
      if (a.nextElementSibling?.classList.contains('gitpin-btn')) continue;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gitpin-btn';
      btn.dataset.url = Store.normalize(`https://github.com/${repo}`);
      btn.innerHTML = PIN_SVG;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        Store.togglePin(btn.dataset.url, repo);
      });
      syncButton(btn);
      a.after(btn);
    }
  }

  function syncAllButtons() {
    document.querySelectorAll('.gitpin-btn').forEach(syncButton);
  }

  if (IS_GITHUB) {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        decorate();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ---------- State + messages ----------

  function setPins(next) {
    pins = next;
    pinned = new Set(pins.map((p) => p.url));
    if (isOpen) render();
    syncAllButtons();
  }

  Store.onPinsChanged(setPins);
  chrome.storage.local.get('collapsed').then(({ collapsed: c = [] }) => {
    collapsed = new Set(c);
    if (isOpen) render();
  });
  Store.getPins().then((p) => {
    setPins(p);
    if (IS_GITHUB) decorate();
  });

  document.addEventListener('contextmenu', (e) => {
    lastContextLink = e.target.closest?.('a[href]') || null;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'toggle') setOpen(!isOpen);
    if (msg.type === 'pinLink') {
      const a = lastContextLink;
      const text = a && Store.normalize(a.href) === Store.normalize(msg.url) ? a.textContent.trim() : '';
      Store.addPin(msg.url, repoFromUrl(msg.url) || text.replace(/\s+/g, ' ').slice(0, 120));
    }
    reply(true);
  });

  function DRAWER_CSS() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .handle, .drawer {
        --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de;
        --hover: #f3f4f6; --accent: #d29922; --input: #f6f8fa;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        color: var(--fg);
      }
      @media (prefers-color-scheme: dark) {
        .handle, .drawer {
          --bg: #161b22; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d;
          --hover: #21262d; --input: #0d1117;
        }
      }
      svg { width: 14px; height: 14px; fill: currentColor; flex: none; }
      button { font: inherit; color: inherit; cursor: pointer; }

      .handle {
        position: fixed; right: 0; top: 50%; z-index: 2147483646;
        transform: translateY(-50%);
        display: flex; align-items: center; justify-content: center;
        width: 22px; height: 44px; padding: 0;
        background: var(--bg); color: var(--accent);
        border: 1px solid var(--line); border-right: none; border-radius: 8px 0 0 8px;
        box-shadow: -2px 2px 8px rgba(0,0,0,.12);
        opacity: .7; transition: opacity .15s, width .15s, transform .2s;
      }
      .handle:hover { opacity: 1; width: 28px; }
      .handle.hide { transform: translate(100%, -50%); }

      .drawer {
        position: fixed; top: 0; right: 0; z-index: 2147483647;
        width: 340px; max-width: 90vw; height: 100vh;
        display: flex; flex-direction: column;
        background: var(--bg);
        border-left: 1px solid var(--line);
        box-shadow: -8px 0 24px rgba(0,0,0,.18);
        transform: translateX(105%); visibility: hidden;
        transition: transform .2s ease, visibility 0s linear .2s;
      }
      .drawer.open { transform: none; visibility: visible; transition: transform .2s ease; }

      header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 14px 10px;
      }
      .title { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; }
      .title svg { color: var(--accent); }
      .count { color: var(--muted); font-weight: 400; }
      .close { background: none; border: none; color: var(--muted); padding: 4px 6px; border-radius: 6px; }
      .close:hover { background: var(--hover); color: var(--fg); }

      .tools { display: flex; gap: 6px; padding: 0 14px 10px; border-bottom: 1px solid var(--line); }
      .search {
        flex: 1; min-width: 0; font: inherit; color: var(--fg);
        background: var(--input); border: 1px solid var(--line); border-radius: 6px;
        padding: 5px 8px; outline: none;
      }
      .search:focus { border-color: var(--accent); }
      .pin-page {
        white-space: nowrap; background: var(--input);
        border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px;
      }
      .pin-page:hover { background: var(--hover); }
      .pin-page.active { color: var(--accent); }

      .list { margin: 0; padding: 6px; overflow-y: auto; flex: 1; }
      .group + .group { margin-top: 4px; }
      .group-h {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 6px 8px; border: none; border-radius: 6px; background: none;
        color: var(--muted); font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: .05em; text-align: left;
      }
      .group-h:hover { background: var(--hover); color: var(--fg); }
      .group-h img { width: 16px; height: 16px; border-radius: 4px; }
      .caret { width: 12px; height: 12px; fill: none; transition: transform .15s; }
      .collapsed .caret { transform: rotate(-90deg); }
      .group-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: none; font-size: 12px; letter-spacing: 0; }
      .group-count { font-weight: 500; }
      .group ul { list-style: none; margin: 0; padding: 0; }
      .collapsed ul { display: none; }
      .group[data-owner]:not([data-owner=""]) li a { padding-left: 28px; }
      li { display: flex; align-items: center; border-radius: 6px; }
      li:hover { background: var(--hover); }
      li.dragging { opacity: .4; }
      li a {
        flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;
        padding: 7px 8px; color: inherit; text-decoration: none;
      }
      li img { width: 20px; height: 20px; border-radius: 4px; flex: none; }
      .text { min-width: 0; display: flex; flex-direction: column; }
      .name, .sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .name { font-weight: 500; }
      .sub { color: var(--muted); font-size: 11px; }
      .remove {
        background: none; border: none; color: var(--muted);
        padding: 4px 8px; margin-right: 4px; border-radius: 4px; visibility: hidden;
      }
      li:hover .remove { visibility: visible; }
      .remove:hover { color: #cf222e; }
      .empty { color: var(--muted); padding: 16px 20px; margin: 0; text-align: center; }
    `;
  }
})();
