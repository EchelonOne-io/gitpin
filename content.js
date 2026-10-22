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

  let pins = [];
  let pinned = new Set();
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
      <ul class="list"></ul>
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
    const repo = repoFromUrl(url);
    if (repo) return `https://github.com/${repo.split('/')[0]}.png?size=40`;
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

  function render() {
    const shown = filtered();
    const filtering = shown !== pins;
    list.replaceChildren(
      ...shown.map((p) => {
        const li = document.createElement('li');
        li.dataset.url = p.url;
        li.draggable = !filtering;
        li.innerHTML = `
          <a href="" title="">
            <img alt="" referrerpolicy="no-referrer">
            <span class="text"><span class="name"></span><span class="sub"></span></span>
          </a>
          <button class="remove" title="Unpin">✕</button>`;
        const a = li.querySelector('a');
        a.href = p.url;
        a.title = p.url;
        li.querySelector('.name').textContent = p.title;
        li.querySelector('.sub').textContent = subtitle(p.url);
        const img = li.querySelector('img');
        img.src = iconFor(p.url);
        img.onerror = () => {
          img.onerror = null;
          img.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(p.url)}&size=32`);
        };
        li.querySelector('.remove').onclick = () => Store.removePin(p.url);
        return li;
      })
    );
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
    if (!over || over === dragging) return;
    const { top, height } = over.getBoundingClientRect();
    over[e.clientY < top + height / 2 ? 'before' : 'after'](dragging);
  });
  list.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    const order = [...list.children].map((li) => li.dataset.url);
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

      .list { list-style: none; margin: 0; padding: 6px; overflow-y: auto; flex: 1; }
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
