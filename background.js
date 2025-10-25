chrome.runtime.onInstalled.addListener(() => {
  console.log('Accessibility Assistant extension installed');
});

// Listen for the command shortcut
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start-assistant') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;

      // Inject content.js (idempotent)
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        files: ['content.js']
      });

      // Ping to ensure content script is ready
      let ready = false;
      for (let i = 0; i < 15; i++) {
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
          if (res && res.pong) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 150));
      }

      if (!ready) return;

      // Start the assistant
      await chrome.tabs.sendMessage(tab.id, { action: 'startAssistant' });

      // Optional: show the extension popup (simulated click)
      chrome.action.openPopup();
    } catch (err) {
      console.error('Error starting assistant via shortcut:', err);
    }
  }
});
