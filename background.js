// Background script for the Accessibility Assistant extension

chrome.runtime.onInstalled.addListener(() => {
  console.log('Accessibility Assistant extension installed');
});

// Handle messages between popup and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'statusUpdate') {
    // Forward status updates to popup if it's open
    chrome.runtime.sendMessage(message);
  }
});

// Handle tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Inject content script if needed
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    }).catch(error => {
      console.log('Could not inject content script:', error);
    });
  }
});
