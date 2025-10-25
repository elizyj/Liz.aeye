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
      await chrome.tabs.sendMessage(tab.id, { action: 'startAssistant' });
      isActive = true;
      status.textContent = 'Assistant is active';
      startBtn.disabled = true;
      stopBtn.disabled = false;
    } catch (error) {
      status.textContent = 'Error starting assistant: ' + error.message;
    }
  });

  stopBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { action: 'stopAssistant' });
      isActive = false;
      status.textContent = 'Assistant stopped';
      startBtn.disabled = false;
      stopBtn.disabled = true;
      currentAction.textContent = '';
    } catch (error) {
      status.textContent = 'Error stopping assistant: ' + error.message;
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
