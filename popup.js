(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startAssistant');
    const stopBtn  = document.getElementById('stopAssistant');
    const statusEl = document.getElementById('status');
    const currentActionEl = document.getElementById('currentAction');

    const volumeUp   = document.getElementById('volumeUp');
    const volumeDown = document.getElementById('volumeDown');
    const speedUp    = document.getElementById('speedUp');
    const speedDown  = document.getElementById('speedDown');

    const keyInput = document.getElementById('openaiKey');
    const saveKey  = document.getElementById('saveKey');

    function setStatus(text) { if (statusEl) statusEl.textContent = text; }
    function setButtons(active) {
      if (startBtn) startBtn.disabled = active;
      if (stopBtn)  stopBtn.disabled  = !active;
    }

    async function getActiveTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error('No active tab');
      return tab;
    }

    function isRestricted(url) {
      if (!url) return true;
      return url.startsWith('chrome://') ||
             url.startsWith('edge://') ||
             url.startsWith('about:') ||
             url.includes('chrome.google.com/webstore') ||
             url.endsWith('.pdf');
    }

    async function pingOnce(tabId) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
        return !!res?.pong;
      } catch {
        return false;
      }
    }

    // NEW: last-chance injector (no `allFrames`)
    async function ensureReachable(tabId) {
      // 1) quick ping
      if (await pingOnce(tabId)) return true;

      // 2) programmatic inject (only main frame)
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'ISOLATED',
          files: ['content.js']
        });
      } catch (e) {
        console.warn('[AA] executeScript failed:', e);
      }

      // 3) ping again a few times
      for (let i = 0; i < 8; i++) {
        if (await pingOnce(tabId)) return true;
        await new Promise(r => setTimeout(r, 150));
      }
      return false;
    }

    // Start
    startBtn?.addEventListener('click', async () => {
      try {
        const tab = await getActiveTab();
        if (isRestricted(tab.url || '')) {
          throw new Error('Open a normal website (http/https). PDFs, Chrome Web Store, and chrome:// pages are restricted.');
        }

        setStatus('Connecting…');
        const ok = await ensureReachable(tab.id);
        if (!ok) {
          throw new Error('Could not reach content script.\n\nTry this:\n• Refresh the page (hard refresh).\n• If it’s a file:// page, enable “Allow access to file URLs” in the extension’s Details.\n• Make sure the extension is allowed on this site (chrome://extensions → your extension → Site access: On all sites).\n• Not incognito? If incognito, enable “Allow in incognito”.');
        }

        await chrome.tabs.sendMessage(tab.id, { action: 'startAssistant' });
        setButtons(true);
        setStatus('Assistant is active');
      } catch (err) {
        console.error('Start error:', err);
        setStatus('Error: ' + (err?.message || String(err)));
      }
    });

    // Stop
    stopBtn?.addEventListener('click', async () => {
      try {
        const tab = await getActiveTab();
        try { await chrome.tabs.sendMessage(tab.id, { action: 'stopAssistant' }); } catch {}
        setButtons(false);
        setStatus('Assistant stopped');
        if (currentActionEl) currentActionEl.textContent = '';
      } catch (err) {
        console.error('Stop error:', err);
        setStatus('Error: ' + (err?.message || String(err)));
      }
    });

    // Volume/speed controls
    volumeUp?.addEventListener('click', () => { chrome.storage.local.set({ volume: 1.0 }); setStatus('Volume: max'); });
    volumeDown?.addEventListener('click', () => { chrome.storage.local.set({ volume: 0.5 }); setStatus('Volume: medium'); });
    speedUp?.addEventListener('click', () => { chrome.storage.local.set({ speechRate: 1.5 }); setStatus('Speech speed increased'); });
    speedDown?.addEventListener('click', () => { chrome.storage.local.set({ speechRate: 0.8 }); setStatus('Speech speed decreased'); });

    // Status updates from content
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'statusUpdate' && currentActionEl) {
        currentActionEl.textContent = message.text || '';
      }
    });

    // Load saved key
    chrome.storage.local.get(['OPENAI_API_KEY'], (res) => {
      if (res.OPENAI_API_KEY) keyInput.value = res.OPENAI_API_KEY;
    });

    // Save key
    saveKey?.addEventListener('click', async () => {
      const k = keyInput.value.trim();
      await chrome.storage.local.set({ OPENAI_API_KEY: k });
      setStatus(k ? 'API key saved' : 'API key cleared');
    });

    // Defaults
    chrome.storage.local.set({ volume: 0.8, speechRate: 1.0 });
    setButtons(false);
    setStatus('Ready to help');
  });
})();

