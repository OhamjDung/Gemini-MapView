const statusEl = document.getElementById("status");
const toggleOverlayBtn = document.getElementById("toggle-overlay");
const syncNowBtn = document.getElementById("sync-now");
const centerMapBtn = document.getElementById("center-map");

async function getGeminiTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://gemini.google.com/*"]
  });

  const activeTab = tabs.find((tab) => tab.active) || tabs[0];
  return activeTab || null;
}

async function sendToGemini(message) {
  const tab = await getGeminiTab();
  if (!tab?.id) {
    setStatus("No open Gemini tab found.\nOpen https://gemini.google.com/app first.");
    return null;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    return response || null;
  } catch (error) {
    setStatus("The extension found Gemini, but the page script is not ready yet.\nRefresh the Gemini tab once, then try again.");
    return null;
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function refreshStatus() {
  const response = await sendToGemini({ type: "GMV_GET_STATUS" });
  if (!response) {
    return;
  }

  const lines = [
    response.overlayVisible ? "Overlay: open" : "Overlay: hidden",
    `Detected turns: ${response.turnCount}`,
    `Thread key: ${response.threadKey}`
  ];

  if (response.lastSyncAt) {
    lines.push(`Last sync: ${new Date(response.lastSyncAt).toLocaleTimeString()}`);
  }

  if (response.notice) {
    lines.push(response.notice);
  }

  setStatus(lines.join("\n"));
}

async function runAction(type) {
  const response = await sendToGemini({ type });
  if (response?.ok === false && response.error) {
    setStatus(response.error);
    return;
  }

  await refreshStatus();
}

toggleOverlayBtn.addEventListener("click", () => {
  runAction("GMV_TOGGLE_OVERLAY");
});

syncNowBtn.addEventListener("click", () => {
  runAction("GMV_SYNC_NOW");
});

centerMapBtn.addEventListener("click", () => {
  runAction("GMV_CENTER_MAP");
});

refreshStatus();
