importScripts('lib/pins.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'pin-link', title: 'Pin link to GitPin', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'pin-page', title: 'Pin this page to GitPin', contexts: ['page'] });
});

// Send a message to the tab's content script, injecting it first if the tab
// was opened before the extension was installed or reloaded.
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['page.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/pins.js', 'content.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.action.onClicked.addListener((tab) => {
  sendToTab(tab.id, { type: 'toggle' }).catch(() => {
    // Restricted pages (chrome://, Web Store) can't host the drawer.
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'pin-link') {
    // The content script knows the link's text, so let it pick the title.
    try {
      await sendToTab(tab.id, { type: 'pinLink', url: info.linkUrl });
    } catch {
      await GitPinStore.addPin(info.linkUrl, info.selectionText);
    }
  } else if (info.menuItemId === 'pin-page') {
    await GitPinStore.addPin(tab.url, tab.title);
  }
});
