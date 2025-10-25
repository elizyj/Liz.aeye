// popup.js
(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startAssistant');
    const stopBtn  = document.getElementById('stopAssistant');
    const statusEl = document.getElementById('status');          // <-- renamed
    const currentActionEl = document.getElementById('currentAction');

    const volumeUp   = document.getElementById('volumeUp');
    const volumeDown = document.getElementById('volumeDown');
    const speedUp    = document.getElementById('speedUp');
    const speedDown  = document.getElementById('speedDown');

    let isActive = false;

    async function withActiveTab(fn) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, status: 'complete' });
      if (!tab || !tab.id) throw new Error('No active tab');
      return fn(tab);
    }

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text;
    }
    function setButtons(active) {
      if (startBtn) startBtn.disabled = active;
      if (stopBtn)  stopBtn.disabled  = !active;
    }

    if (startBtn) {
      startBtn.addEventListener('click', async () => {
        try {
          await withActiveTab(async (tab) => {
            // Ensure a namespace exists (isolated world)
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'ISOLATED',
              func: () => {
                if (!window.accessibilityAssistant) {
                  window.accessibilityAssistant = { ready: false };
                }
              },
            });

            // Load content.js exactly once (its own guard prevents dupes)
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'ISOLATED',
              files: ['content.js'],
            });

            // Nudge it to start
            await new Promise(r => setTimeout(r, 150));
            await chrome.tabs.sendMessage(tab.id, { action: 'startAssistant' });
          });

          isActive = true;
          setStatus('Assistant is active');
          setButtons(true);
        } catch (err) {
          console.error('Start assistant error:', err);
          setStatus('Error starting assistant: ' + (err && err.message ? err.message : String(err)));
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        try {
          await withActiveTab(async (tab) => {
            try {
              await chrome.tabs.sendMessage(tab.id, { action: 'stopAssistant' });
            } catch {
              // ignore if content script isn't present
            }
          });
          isActive = false;
          setStatus('Assistant stopped');
          setButtons(false);
          if (currentActionEl) currentActionEl.textContent = '';
        } catch (err) {
          console.error('Stop assistant error:', err);
          setStatus('Error stopping assistant: ' + (err && err.message ? err.message : String(err)));
        }
      });
    }

    // Volume & speed controls
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
