// Proxy messages from webpage to extension
window.addEventListener('wisp-message', (event) => {
  chrome.runtime.sendMessage(event.detail);
});

function ready() {
  // Notify background script that content script is ready
  chrome.runtime.sendMessage({ type: 'contentScriptReady' });

  document.body.classList.add('wisp-loaded');
  window.dispatchEvent(new CustomEvent('wisp-loaded'));

  // Check for auto-connect querystring parameter
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('wisp-connect') === 'true') {
    chrome.runtime.sendMessage({ type: 'connect' });
    chrome.runtime.sendMessage({ type: 'openPopup' });
  }
}

// Notify webpage that Wisp is loaded after DOMContentLoaded
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', ready) : ready();
