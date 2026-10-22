// Pin storage shared by the content script and the service worker.
// Pins live in chrome.storage.local as an ordered array: [{ url, title, addedAt }].
(() => {
  const KEY = 'pins';

  function normalize(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.href.replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  async function getPins() {
    const { [KEY]: pins = [] } = await chrome.storage.local.get(KEY);
    return pins;
  }

  const savePins = (pins) => chrome.storage.local.set({ [KEY]: pins });

  async function addPin(url, title) {
    url = normalize(url);
    const pins = await getPins();
    if (pins.some((p) => p.url === url)) return;
    pins.push({ url, title: (title || '').trim() || url, addedAt: Date.now() });
    await savePins(pins);
  }

  async function removePin(url) {
    url = normalize(url);
    await savePins((await getPins()).filter((p) => p.url !== url));
  }

  async function togglePin(url, title) {
    const pins = await getPins();
    if (pins.some((p) => p.url === normalize(url))) await removePin(url);
    else await addPin(url, title);
  }

  function onPinsChanged(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) cb(changes[KEY].newValue || []);
    });
  }

  globalThis.GitPinStore = { normalize, getPins, savePins, addPin, removePin, togglePin, onPinsChanged };
})();
