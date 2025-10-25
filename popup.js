document.addEventListener('DOMContentLoaded', function() {
  const startBtn = document.getElementById('startAssistant');
  const stopBtn = document.getElementById('stopAssistant');
  const status = document.getElementById('status');
  const currentAction = document.getElementById('currentAction');
  
  // Volume and speed controls
  const volumeUp = document.getElementById('volumeUp');
  const volumeDown = document.getElementById('volumeDown');
  const speedUp = document.getElementById('speedUp');
  const speedDown = document.getElementById('speedDown');

  let isActive = false;

  startBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      // First, inject the content script if it's not already there
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
      } catch (injectError) {
        console.log('Content script already injected or error:', injectError);
      }
      
      // Wait a moment for the script to initialize
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Now try to send the message
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

  stopBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      // Try to send the message, but don't fail if content script isn't there
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'stopAssistant' });
      } catch (messageError) {
        console.log('Could not send stop message:', messageError);
      }
      
      isActive = false;
      status.textContent = 'Assistant stopped';
      startBtn.disabled = false;
      stopBtn.disabled = true;
      currentAction.textContent = '';
    } catch (error) {
      status.textContent = 'Error stopping assistant: ' + error.message;
      console.error('Stop assistant error:', error);
    }
  });

  // Volume and speed controls
  volumeUp.addEventListener('click', () => {
    chrome.storage.local.set({ volume: 1.0 });
    status.textContent = 'Volume set to maximum';
  });

  volumeDown.addEventListener('click', () => {
    chrome.storage.local.set({ volume: 0.5 });
    status.textContent = 'Volume set to medium';
  });

  speedUp.addEventListener('click', () => {
    chrome.storage.local.set({ speechRate: 1.5 });
    status.textContent = 'Speech speed increased';
  });

  speedDown.addEventListener('click', () => {
    chrome.storage.local.set({ speechRate: 0.8 });
    status.textContent = 'Speech speed decreased';
  });

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'statusUpdate') {
      currentAction.textContent = message.text;
    }
  });

  // Initialize storage values
  chrome.storage.local.set({
    volume: 0.8,
    speechRate: 1.0
  });
});
