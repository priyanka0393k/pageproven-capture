'use strict';
// Capture: takes a screenshot of the visible tab and opens the capture screen over the page.

const pending = new Map(); // tabId -> PNG data URL waiting for the capture screen

async function startCapture(tab) {
  if (!tab || tab.id === undefined) return;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    pending.set(tab.id, dataUrl);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['inject.js'] });
  } catch (err) {
    pending.delete(tab.id);
    // Chrome doesn't allow extensions on some pages (chrome:// pages, the Web Store, the PDF viewer).
    console.warn('Capture is not available on this page:', err && err.message);
    await flagUnavailable(tab.id);
  }
}

async function flagUnavailable(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b91c1c' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: "Capture can't run on this page. Chrome blocks extensions here." });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      chrome.action.setTitle({ tabId, title: 'Capture an area (Alt+Shift+S)' }).catch(() => {});
    }, 4000);
  } catch { /* the tab may be gone */ }
}

chrome.action.onClicked.addListener(startCapture);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (msg && msg.type === 'get-capture') {
    sendResponse({ dataUrl: pending.get(tabId) || null });
    pending.delete(tabId);
    return false;
  }
  if (msg && msg.type === 'download' && typeof msg.dataUrl === 'string' && msg.dataUrl.startsWith('data:image/png;base64,')) {
    chrome.downloads.download({ url: msg.dataUrl, filename: msg.filename, saveAs: !!msg.saveAs, conflictAction: 'uniquify' })
      .then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: String(err && err.message) }));
    return true; // async response
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => pending.delete(tabId));
