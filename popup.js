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

    let isActive = false;

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text;
    }
    function setButtons(active) {
      if (startBtn) startBtn.disabled = active;
      if (stopBtn)  stopBtn.disabled  = !active;
    }

    async function getActiveTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error('No active tab');
      return tab;
    }

    function isAllowedPage(url) {
      if (!url) return false;
      const restricted =
        url.startsWith('chrome://') ||
        url.startsWith('edge://')   ||
        url.startsWith('about:')    ||
        url.includes('chrome.google.com/webstore') ||
        url.endsWith('.pdf');
      const allowedScheme =
        url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
      return allowedScheme && !restricted;
    }

    async function injectContent(tabId) {
      // Inject content.js (idempotent; content.js has its own guard)
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        files: ['content.js']
      });
    }

    async function pingContent(tabId, retries = 15, delayMs = 150) {
      for (let i = 0; i < retries; i++) {
        try {
          const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
          if (res && res.pong) return true;
        } catch {
          // ignore until ready
        }
        await new Promise(r => setTimeout(r, delayMs));
      }
      return false;
    }

    if (startBtn) {
      startBtn.addEventListener('click', async () => {
        try {
          const tab = await getActiveTab();
          if (!isAllowedPage(tab.url || '')) {
            throw new Error('Cannot run on this page. Please open a normal website (http/https).');
          }

          setStatus('Connecting…');

          await injectContent(tab.id);

          const ok = await pingContent(tab.id);
          if (!ok) throw new Error('Could not establish connection to content script');

          await chrome.tabs.sendMessage(tab.id, { action: 'startAssistant' });

          isActive = true;
          setStatus('Assistant is active');
          setButtons(true);
        } catch (err) {
          console.error('Start assistant error:', err);
          setStatus('Error starting assistant: ' + (err?.message || String(err)));
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        try {
          const tab = await getActiveTab();
          try {
            await chrome.tabs.sendMessage(tab.id, { action: 'stopAssistant' });
          } catch {
            // ignore if content script isn't present
          }
          isActive = false;
          setStatus('Assistant stopped');
          setButtons(false);
          if (currentActionEl) currentActionEl.textContent = '';
        } catch (err) {
          console.error('Stop assistant error:', err);
          setStatus('Error stopping assistant: ' + (err?.message || String(err)));
        }
      });
    }

    // Volume & speed controls (just store; content.js reads on init)
    if (volumeUp)   volumeUp.addEventListener('click', () => { chrome.storage.local.set({ volume: 1.0 }); setStatus('Volume set to maximum'); });
    if (volumeDown) volumeDown.addEventListener('click', () => { chrome.storage.local.set({ volume: 0.5 }); setStatus('Volume set to medium'); });
    if (speedUp)    speedUp.addEventListener('click', () => { chrome.storage.local.set({ speechRate: 1.5 }); setStatus('Speech speed increased'); });
    if (speedDown)  speedDown.addEventListener('click', () => { chrome.storage.local.set({ speechRate: 0.8 }); setStatus('Speech speed decreased'); });

    // Listen for status updates from content script
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'statusUpdate' && currentActionEl) {
        currentActionEl.textContent = message.text || '';
      }
    });

    // Initialize defaults
    chrome.storage.local.set({ volume: 0.8, speechRate: 1.0 });
    setButtons(false);
    setStatus('Ready to help');
  });
})();

