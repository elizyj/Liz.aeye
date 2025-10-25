startBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Inject ONLY if not already present.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED', // important: prevents any style/global bleed
      func: () => {
        // Create the assistant if not present
        if (!window.accessibilityAssistant) {
          // Load code if not bundled via func; here we assume content.js is web_accessible or packaged
          // If you keep content.js as a file, do a second executeScript with { files: ['content.js'] }.
          // Simpler: expose a noop placeholder and let the next message kick it off.
          window.accessibilityAssistant = { ready: false };
        }
      },
    });

    // Now actually load content.js once (idempotent guard is inside content.js)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      files: ['content.js']
    });

    // Give it a moment to init, then start
    await new Promise(r => setTimeout(r, 150));
    await chrome.tabs.sendMessage(tab.id, { action: 'startAssistant' });

    isActive = true;
    status.textContent = 'Assistant is active';
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } catch (error) {
    status.textContent = 'Error starting assistant: ' + error.message;
    console.error('Start assistant error:', error);
  }
});
