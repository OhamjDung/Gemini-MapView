(async () => {
  const STORAGE_PREFIX = "gmv:";
  const AUTO_SYNC_DEBOUNCE_MS = 800;
  const NODE_WIDTH = 360;
  const NODE_GAP_X = 160;
  const NODE_GAP_Y = 44;
  const SVG_OFFSET = 10000;

  let overlayVisible = false;
  let canvasX = 80;
  let canvasY = 100;
  let scale = 1;
  let isPanning = false;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let selectedNodeId = null;
  let lastSyncAt = null;
  let lastNotice = "";
  let syncTimer = null;
  let currentUrl = location.href;
  let mutationObserver = null;

  const sourceNodeMap = new Map();
  let mapNodes = [];

  const host = document.createElement("div");
  host.className = "gmv-host";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.setAttribute("rel", "stylesheet");
  stylesheet.setAttribute("href", chrome.runtime.getURL("content.css"));
  shadow.appendChild(stylesheet);

  const root = document.createElement("div");
  root.className = "gmv-root";
  root.dataset.open = "false";
  root.innerHTML = `
    <button class="gmv-launcher" type="button">Map View</button>
    <section class="gmv-shell">
      <div class="gmv-topbar">
        <div class="gmv-title-group">
          <p class="gmv-title">Gemini MapView</p>
          <p class="gmv-subtitle">Live overlay driven by the current Gemini thread</p>
        </div>
        <div class="gmv-toolbar">
          <div class="gmv-status">Waiting for the first sync...</div>
          <button class="gmv-btn" type="button" data-action="sync">Sync</button>
          <button class="gmv-btn" type="button" data-action="center">Center</button>
          <button class="gmv-btn gmv-btn-primary" type="button" data-action="close">Close</button>
        </div>
      </div>
      <div class="gmv-viewport" data-panning="false">
        <div class="gmv-canvas">
          <svg class="gmv-lines"></svg>
          <div class="gmv-empty">
            <h2>No conversation detected yet</h2>
            <p>Open a Gemini thread, wait for the page to finish rendering, then press Sync. The extension reads the live page and turns the running chat into a visual map.</p>
          </div>
        </div>
      </div>
    </section>
  `;
  shadow.appendChild(root);

  const launcherBtn = root.querySelector(".gmv-launcher");
  const shellEl = root.querySelector(".gmv-shell");
  const viewportEl = root.querySelector(".gmv-viewport");
  const canvasEl = root.querySelector(".gmv-canvas");
  const linesEl = root.querySelector(".gmv-lines");
  const statusEl = root.querySelector(".gmv-status");
  const emptyEl = root.querySelector(".gmv-empty");

  function threadKey() {
    return `${location.origin}${location.pathname}`;
  }

  function storageKey(suffix) {
    return `${STORAGE_PREFIX}${threadKey()}:${suffix}`;
  }

  function setStatus(message) {
    lastNotice = message;
    statusEl.textContent = message;
  }

  async function loadPersistedView() {
    const stored = await chrome.storage.local.get([
      storageKey("overlayVisible"),
      storageKey("transform")
    ]);

    overlayVisible = Boolean(stored[storageKey("overlayVisible")]);

    const transform = stored[storageKey("transform")];
    if (transform) {
      canvasX = typeof transform.x === "number" ? transform.x : canvasX;
      canvasY = typeof transform.y === "number" ? transform.y : canvasY;
      scale = typeof transform.scale === "number" ? transform.scale : scale;
    }

    applyOverlayVisibility();
    applyTransform();
  }

  async function persistView() {
    await chrome.storage.local.set({
      [storageKey("overlayVisible")]: overlayVisible,
      [storageKey("transform")]: {
        x: canvasX,
        y: canvasY,
        scale
      }
    });
  }

  function applyOverlayVisibility() {
    root.dataset.open = overlayVisible ? "true" : "false";
  }

  function applyTransform() {
    canvasEl.style.transform = `translate(${canvasX}px, ${canvasY}px) scale(${scale})`;
    drawLines();
  }

  function centerMap() {
    canvasX = 80;
    canvasY = 100;
    scale = 1;
    applyTransform();
    persistView();
  }

  function truncate(text, maxLength) {
    const cleaned = (text || "").replace(/\s+/g, " ").trim();
    if (cleaned.length <= maxLength) {
      return cleaned;
    }
    return `${cleaned.slice(0, maxLength - 1)}...`;
  }

  function isVisibleElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (host.contains(element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 80 && rect.height > 24;
  }

  function closestAuthorRole(element) {
    const roleHost = element.closest("[data-message-author-role]");
    if (!roleHost) {
      return null;
    }

    const raw = String(roleHost.getAttribute("data-message-author-role") || "").toLowerCase();
    if (raw.includes("user") || raw.includes("human")) {
      return "user";
    }
    if (raw.includes("assistant") || raw.includes("model")) {
      return "assistant";
    }
    return null;
  }

  function extractText(element) {
    if (!(element instanceof HTMLElement)) {
      return "";
    }

    const clone = element.cloneNode(true);
    clone.querySelectorAll("button, svg, style, script, nav, form, textarea, input").forEach((node) => node.remove());
    return truncate(clone.innerText || clone.textContent || "", 3200);
  }

  function collectExplicitRoleElements(rootNode) {
    const elements = Array.from(rootNode.querySelectorAll("[data-message-author-role]"))
      .filter(isVisibleElement)
      .filter((element) => !element.querySelector("[data-message-author-role]"));

    const seen = new Set();
    return elements.filter((element) => {
      const text = extractText(element);
      if (!text || seen.has(text)) {
        return false;
      }
      seen.add(text);
      return true;
    });
  }

  function collectArticleFallback(rootNode) {
    const selectors = [
      "main article",
      "main [role='article']",
      "main .conversation-turn",
      "main .model-response-text",
      "main message-content"
    ];

    const elements = Array.from(rootNode.querySelectorAll(selectors.join(",")))
      .filter(isVisibleElement)
      .filter((element) => !element.querySelector("article"));

    const results = [];
    const seen = new Set();

    for (const element of elements) {
      const text = extractText(element);
      if (!text || text.length < 20 || seen.has(text)) {
        continue;
      }

      seen.add(text);
      results.push(element);
    }

    return results;
  }

  function collectGenericBlocks(rootNode) {
    const blocks = Array.from(rootNode.querySelectorAll("main div, main section"))
      .filter(isVisibleElement)
      .filter((element) => {
        if (element.children.length > 24) {
          return false;
        }
        const text = extractText(element);
        return text.length >= 60 && text.length <= 2000;
      });

    const results = [];
    const seen = new Set();

    for (const element of blocks) {
      if (element.querySelector("div div div div div")) {
        continue;
      }

      const text = extractText(element);
      if (!text || seen.has(text)) {
        continue;
      }

      seen.add(text);
      results.push(element);
      if (results.length >= 24) {
        break;
      }
    }

    return results;
  }

  function normalizeMessages(rawElements) {
    const normalized = [];
    let inferredRole = "user";

    for (const element of rawElements) {
      const text = extractText(element);
      if (!text) {
        continue;
      }

      const explicitRole = closestAuthorRole(element);
      const role = explicitRole || inferredRole;
      inferredRole = role === "user" ? "assistant" : "user";

      normalized.push({
        role,
        text,
        element
      });
    }

    return normalized;
  }

  function extractConversation() {
    const mainRoot = document.querySelector("main") || document.body;

    let rawElements = collectExplicitRoleElements(mainRoot);
    if (!rawElements.length) {
      rawElements = collectArticleFallback(mainRoot);
    }
    if (!rawElements.length) {
      rawElements = collectGenericBlocks(mainRoot);
    }

    const messages = normalizeMessages(rawElements);
    const turns = [];
    let pendingUser = null;
    let orphanAssistantCount = 0;

    for (const message of messages) {
      if (message.role === "user") {
        pendingUser = message;
        continue;
      }

      if (!pendingUser) {
        orphanAssistantCount += 1;
        turns.push({
          id: `turn-${turns.length + 1}`,
          title: `Gemini response ${orphanAssistantCount}`,
          prompt: "No user prompt could be paired for this response.",
          response: message.text,
          sourceElement: message.element
        });
        continue;
      }

      turns.push({
        id: `turn-${turns.length + 1}`,
        title: `Turn ${turns.length + 1}`,
        prompt: pendingUser.text,
        response: message.text,
        sourceElement: message.element
      });
      pendingUser = null;
    }

    if (pendingUser) {
      turns.push({
        id: `turn-${turns.length + 1}`,
        title: `Turn ${turns.length + 1}`,
        prompt: pendingUser.text,
        response: "Gemini has not produced a visible response yet.",
        sourceElement: pendingUser.element
      });
    }

    return turns;
  }

  function buildMapNodes(turns) {
    return turns.map((turn, index) => {
      const x = index * (NODE_WIDTH + NODE_GAP_X);
      const y = index * NODE_GAP_Y;

      return {
        ...turn,
        x,
        y,
        parentId: index === 0 ? null : turns[index - 1].id
      };
    });
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderNodes() {
    sourceNodeMap.clear();

    canvasEl.querySelectorAll(".gmv-node").forEach((node) => node.remove());

    if (!mapNodes.length) {
      emptyEl.style.display = "block";
      drawLines();
      return;
    }

    emptyEl.style.display = "none";

    for (const [index, node] of mapNodes.entries()) {
      sourceNodeMap.set(node.id, node.sourceElement);

      const element = document.createElement("article");
      element.className = "gmv-node";
      element.dataset.nodeId = node.id;
      element.dataset.selected = selectedNodeId === node.id ? "true" : "false";
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
      element.innerHTML = `
        <header class="gmv-node-header">
          <span class="gmv-node-tag">${escapeHtml(node.title)}</span>
          <span class="gmv-node-index">${index + 1}/${mapNodes.length}</span>
        </header>
        <section class="gmv-node-section">
          <p class="gmv-node-label">You</p>
          <p class="gmv-node-copy">${escapeHtml(node.prompt)}</p>
        </section>
        <section class="gmv-node-section">
          <p class="gmv-node-label">Gemini</p>
          <p class="gmv-node-copy">${escapeHtml(node.response)}</p>
        </section>
        <div class="gmv-node-actions">
          <button class="gmv-node-action" type="button" data-node-action="jump">Jump to chat</button>
          <button class="gmv-node-action" type="button" data-node-action="reuse">Use in composer</button>
        </div>
      `;
      canvasEl.appendChild(element);
    }

    drawLines();
  }

  function drawLines() {
    linesEl.innerHTML = "";

    for (const node of mapNodes) {
      if (!node.parentId) {
        continue;
      }

      const parent = mapNodes.find((candidate) => candidate.id === node.parentId);
      if (!parent) {
        continue;
      }

      const startX = parent.x + NODE_WIDTH + SVG_OFFSET;
      const startY = parent.y + 160 + SVG_OFFSET;
      const endX = node.x + SVG_OFFSET;
      const endY = node.y + 80 + SVG_OFFSET;
      const midX = startX + (endX - startX) / 2;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`);
      path.setAttribute("stroke", "rgba(125, 211, 252, 0.56)");
      path.setAttribute("stroke-width", "3");
      path.setAttribute("fill", "none");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      linesEl.appendChild(path);
    }
  }

  function updateStatusFromTurns(turns) {
    const parts = [
      `${turns.length} turn${turns.length === 1 ? "" : "s"} detected`,
      `Thread: ${threadKey()}`
    ];

    if (lastSyncAt) {
      parts.push(`Synced ${new Date(lastSyncAt).toLocaleTimeString()}`);
    }

    setStatus(parts.join(" | "));
  }

  async function syncConversation(reason = "manual") {
    const turns = extractConversation();
    mapNodes = buildMapNodes(turns);
    lastSyncAt = Date.now();

    if (selectedNodeId && !mapNodes.some((node) => node.id === selectedNodeId)) {
      selectedNodeId = null;
    }

    renderNodes();
    updateStatusFromTurns(turns);

    await chrome.storage.local.set({
      [storageKey("lastSyncAt")]: lastSyncAt
    });

    if (!turns.length) {
      lastNotice = `No chat turns were detected during the ${reason} sync.`;
    }
  }

  function scheduleSync(reason) {
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
      syncConversation(reason);
    }, AUTO_SYNC_DEBOUNCE_MS);
  }

  function findComposer() {
    const selectors = [
      "rich-textarea div[contenteditable='true']",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']",
      "textarea"
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter(isVisibleElement);
      const composer = candidates.find((element) => !host.contains(element));
      if (composer) {
        return composer;
      }
    }

    return null;
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function putTextIntoComposer(text) {
    const composer = findComposer();
    if (!composer) {
      setStatus("Composer not found on this Gemini page.");
      return false;
    }

    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      composer.value = text;
      dispatchInputEvents(composer);
      return true;
    }

    composer.textContent = text;
    dispatchInputEvents(composer);
    return true;
  }

  function jumpToNode(nodeId) {
    selectedNodeId = nodeId;
    renderNodes();

    const sourceElement = sourceNodeMap.get(nodeId);
    if (sourceElement instanceof HTMLElement) {
      sourceElement.scrollIntoView({ behavior: "smooth", block: "center" });
      setStatus(`Jumped to ${nodeId} in the live Gemini chat.`);
    }
  }

  function reuseNode(nodeId) {
    const node = mapNodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return;
    }

    const prompt = `Continue from this point in our current Gemini thread.\n\nPrompt:\n${node.prompt}\n\nGemini reply to continue from:\n${node.response}\n\nNext direction: `;
    if (putTextIntoComposer(prompt)) {
      setStatus(`Inserted ${node.id} into the Gemini composer. Review it, then send when ready.`);
    }
  }

  function handleNodeAction(event) {
    const actionButton = event.target.closest("[data-node-action]");
    if (!actionButton) {
      return;
    }

    const nodeEl = actionButton.closest(".gmv-node");
    if (!nodeEl) {
      return;
    }

    const { nodeId } = nodeEl.dataset;
    if (actionButton.dataset.nodeAction === "jump") {
      jumpToNode(nodeId);
      return;
    }

    if (actionButton.dataset.nodeAction === "reuse") {
      reuseNode(nodeId);
    }
  }

  function attachViewportHandlers() {
    viewportEl.addEventListener("mousedown", (event) => {
      if (event.target.closest(".gmv-node") || event.target.closest(".gmv-btn")) {
        return;
      }

      isPanning = true;
      lastMouseX = event.clientX;
      lastMouseY = event.clientY;
      viewportEl.dataset.panning = "true";
      event.preventDefault();
    });

    viewportEl.addEventListener("mousemove", (event) => {
      if (!isPanning) {
        return;
      }

      const deltaX = event.clientX - lastMouseX;
      const deltaY = event.clientY - lastMouseY;
      lastMouseX = event.clientX;
      lastMouseY = event.clientY;

      canvasX += deltaX;
      canvasY += deltaY;
      applyTransform();
    });

    const stopPanning = async () => {
      if (!isPanning) {
        return;
      }

      isPanning = false;
      viewportEl.dataset.panning = "false";
      await persistView();
    };

    viewportEl.addEventListener("mouseup", stopPanning);
    viewportEl.addEventListener("mouseleave", stopPanning);

    viewportEl.addEventListener("wheel", async (event) => {
      event.preventDefault();

      const nextScale = Math.min(2.4, Math.max(0.4, scale * (1 - event.deltaY * 0.0015)));
      const rect = viewportEl.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      const canvasMouseX = (mouseX - canvasX) / scale;
      const canvasMouseY = (mouseY - canvasY) / scale;

      canvasX = mouseX - canvasMouseX * nextScale;
      canvasY = mouseY - canvasMouseY * nextScale;
      scale = nextScale;
      applyTransform();
      await persistView();
    }, { passive: false });
  }

  function attachUiHandlers() {
    launcherBtn.addEventListener("click", async () => {
      overlayVisible = !overlayVisible;
      applyOverlayVisibility();
      await persistView();
      if (overlayVisible && !mapNodes.length) {
        syncConversation("launcher");
      }
    });

    shellEl.addEventListener("click", async (event) => {
      const action = event.target.getAttribute("data-action");
      if (action === "sync") {
        await syncConversation("toolbar");
        return;
      }

      if (action === "center") {
        centerMap();
        return;
      }

      if (action === "close") {
        overlayVisible = false;
        applyOverlayVisibility();
        await persistView();
      }
    });

    canvasEl.addEventListener("click", handleNodeAction);
  }

  function watchConversation() {
    if (mutationObserver) {
      mutationObserver.disconnect();
    }

    mutationObserver = new MutationObserver(() => {
      scheduleSync("auto");
    });

    const target = document.querySelector("main") || document.body;
    mutationObserver.observe(target, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function watchLocationChanges() {
    window.setInterval(async () => {
      if (location.href === currentUrl) {
        return;
      }

      currentUrl = location.href;
      mapNodes = [];
      selectedNodeId = null;
      currentUrl = location.href;
      await loadPersistedView();
      renderNodes();
      watchConversation();
      scheduleSync("navigation");
    }, 1000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const respond = async () => {
      if (message.type === "GMV_GET_STATUS") {
        sendResponse({
          overlayVisible,
          turnCount: mapNodes.length,
          threadKey: threadKey(),
          lastSyncAt,
          notice: lastNotice
        });
        return;
      }

      if (message.type === "GMV_TOGGLE_OVERLAY") {
        overlayVisible = !overlayVisible;
        applyOverlayVisibility();
        await persistView();
        if (overlayVisible && !mapNodes.length) {
          await syncConversation("popup-toggle");
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "GMV_SYNC_NOW") {
        await syncConversation("popup");
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "GMV_CENTER_MAP") {
        centerMap();
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown Gemini MapView action." });
    };

    respond();
    return true;
  });

  attachUiHandlers();
  attachViewportHandlers();
  await loadPersistedView();
  renderNodes();
  watchConversation();
  watchLocationChanges();
  scheduleSync("initial");
})();
