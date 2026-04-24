(() => {
  const NODE_WIDTH = 360;
  const NODE_GAP_X = 160;
  const NODE_GAP_Y = 44;
  const SVG_OFFSET = 10000;

  const scenarios = {
    default: [
      {
        role: "user",
        text: "Plan a one-week launch strategy for a lightweight browser extension that maps Gemini conversations visually."
      },
      {
        role: "assistant",
        text: "Start with a narrow promise: map the current thread clearly, then add composer reuse and thread navigation in week two. Keep the MVP tightly anchored to the visible Gemini page."
      },
      {
        role: "user",
        text: "Break that into product, UX, and technical milestones."
      },
      {
        role: "assistant",
        text: "Product: validate that users understand the map immediately.\nUX: remove setup friction and explain what the map reads from the page.\nTechnical: separate frontend preview from extension wiring so iteration stays fast."
      },
      {
        role: "user",
        text: "What should the first overlay state look like?"
      },
      {
        role: "assistant",
        text: "Give users one calm onboarding moment: a short title, a one-sentence explanation that the map mirrors the live thread, and a single sync button. Avoid making them guess whether the extension is reading their current conversation."
      }
    ],
    dense: [
      {
        role: "user",
        text: "Research how we could visualize deep branching discussion trees for long AI chats without overwhelming users."
      },
      {
        role: "assistant",
        text: "Use progressive disclosure. Show the main path first, let users open side branches intentionally, and summarize dense subtrees rather than rendering every descendant at full size by default."
      },
      {
        role: "user",
        text: "Compare linear chains, mind maps, and layered canvases."
      },
      {
        role: "assistant",
        text: "Linear chains are readable but weak for divergence.\nMind maps feel exploratory but can get noisy fast.\nLayered canvases work well when users need to pan spatially, as long as the map keeps one obvious focal path."
      },
      {
        role: "user",
        text: "What interaction model keeps users oriented?"
      },
      {
        role: "assistant",
        text: "Orientation comes from three things: persistent focus breadcrumbs, a visible current node highlight, and a reliable way to jump back into the original transcript."
      },
      {
        role: "user",
        text: "Suggest UX copy for those controls."
      },
      {
        role: "assistant",
        text: "Use plain verbs: Sync current chat, Center map, Jump to chat, Use in composer. The controls should sound like direct actions, not product jargon."
      }
    ],
    messy: [
      {
        role: "user",
        text: "Take this rough thought and make it coherent: I want a thing where the extension kind of watches the Gemini page and then turns it into a map and maybe the map lets me branch and maybe the extension popup controls it."
      },
      {
        role: "assistant",
        text: "You want a Chrome extension that uses the currently open Gemini session as its live data source, renders the conversation as a navigable map overlay, and offers a lightweight popup for controls like sync, center, and overlay visibility."
      },
      {
        role: "user",
        text: "Now tell me where the flow is confusing and be blunt."
      },
      {
        role: "assistant",
        text: "The confusing part is ownership of the experience. Right now the popup, overlay, and transcript all feel like separate products. The frontend needs one primary story: the popup starts and controls the map, the overlay is the workspace, and the transcript is the source you can jump back to."
      },
      {
        role: "user",
        text: "What should the first-run state say?"
      },
      {
        role: "assistant",
        text: "Try: 'Map this Gemini thread'. Then one sentence underneath: 'This overlay reads the conversation already visible in this tab and turns it into a navigable map.' That tells users both what happens and where the data comes from."
      }
    ]
  };

  const transcriptEl = document.getElementById("preview-transcript");
  const statusEl = document.getElementById("preview-status");
  const mapStatusEl = document.getElementById("preview-map-status");
  const composerEl = document.getElementById("preview-composer");
  const rootEl = document.getElementById("preview-root");
  const viewportEl = document.getElementById("preview-viewport");
  const canvasEl = document.getElementById("preview-canvas");
  const linesEl = document.getElementById("preview-lines");
  const emptyEl = document.getElementById("preview-empty");

  let activeScenario = "default";
  let selectedNodeId = null;
  let canvasX = 80;
  let canvasY = 100;
  let scale = 1;
  let isPanning = false;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let mapNodes = [];

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildTurns(messages) {
    const turns = [];
    let pendingUser = null;

    messages.forEach((message) => {
      if (message.role === "user") {
        pendingUser = message.text;
        return;
      }

      turns.push({
        id: `turn-${turns.length + 1}`,
        prompt: pendingUser || "Missing user prompt",
        response: message.text,
        title: `Turn ${turns.length + 1}`
      });
      pendingUser = null;
    });

    if (pendingUser) {
      turns.push({
        id: `turn-${turns.length + 1}`,
        prompt: pendingUser,
        response: "No assistant reply yet.",
        title: `Turn ${turns.length + 1}`
      });
    }

    return turns;
  }

  function buildMapNodes(turns) {
    return turns.map((turn, index) => ({
      ...turn,
      x: index * (NODE_WIDTH + NODE_GAP_X),
      y: index * NODE_GAP_Y,
      parentId: index === 0 ? null : turns[index - 1].id
    }));
  }

  function renderTranscript(messages) {
    transcriptEl.innerHTML = messages.map((message, index) => `
      <article class="preview-turn ${message.role}" data-turn-index="${index}">
        <p class="preview-turn-title">${message.role === "user" ? "You" : "Gemini"}</p>
        <p class="preview-turn-copy">${escapeHtml(message.text)}</p>
      </article>
    `).join("");
  }

  function drawLines() {
    linesEl.innerHTML = "";

    mapNodes.forEach((node) => {
      if (!node.parentId) {
        return;
      }

      const parent = mapNodes.find((candidate) => candidate.id === node.parentId);
      if (!parent) {
        return;
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
    });
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
  }

  function renderMap() {
    canvasEl.querySelectorAll(".gmv-node").forEach((node) => node.remove());

    if (!mapNodes.length) {
      emptyEl.style.display = "block";
      return;
    }

    emptyEl.style.display = "none";

    mapNodes.forEach((node, index) => {
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
    });

    applyTransform();
  }

  function updateStatus() {
    const turnCount = mapNodes.length;
    statusEl.textContent = `${scenarios[activeScenario].length} transcript messages loaded`;
    mapStatusEl.textContent = `${turnCount} mapped turn${turnCount === 1 ? "" : "s"} | Scenario: ${activeScenario}`;
  }

  function loadScenario(name) {
    activeScenario = name;
    selectedNodeId = null;

    document.querySelectorAll(".preview-scenario").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.scenario === name);
    });

    const messages = scenarios[name];
    renderTranscript(messages);
    mapNodes = buildMapNodes(buildTurns(messages));
    renderMap();
    updateStatus();
    centerMap();
  }

  function jumpToNode(nodeId) {
    selectedNodeId = nodeId;
    renderMap();

    const index = Number(nodeId.replace("turn-", "")) * 2 - 1;
    const transcriptNode = transcriptEl.querySelector(`[data-turn-index="${Math.max(index, 0)}"]`);
    if (transcriptNode) {
      transcriptNode.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function reuseNode(nodeId) {
    const node = mapNodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return;
    }

    composerEl.value = `Continue this thread from the selected map node.\n\nPrompt:\n${node.prompt}\n\nGemini reply:\n${node.response}\n\nNext direction: `;
    composerEl.focus();
    composerEl.setSelectionRange(composerEl.value.length, composerEl.value.length);
  }

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

  const stopPanning = () => {
    isPanning = false;
    viewportEl.dataset.panning = "false";
  };

  viewportEl.addEventListener("mouseup", stopPanning);
  viewportEl.addEventListener("mouseleave", stopPanning);

  viewportEl.addEventListener("wheel", (event) => {
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
  }, { passive: false });

  canvasEl.addEventListener("click", (event) => {
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
  });

  document.querySelectorAll(".preview-scenario").forEach((button) => {
    button.addEventListener("click", () => {
      loadScenario(button.dataset.scenario);
    });
  });

  document.getElementById("preview-sync").addEventListener("click", () => {
    loadScenario(activeScenario);
  });

  document.getElementById("preview-center").addEventListener("click", () => {
    centerMap();
  });

  document.getElementById("preview-toggle").addEventListener("click", () => {
    const isOpen = rootEl.dataset.open === "true";
    rootEl.dataset.open = isOpen ? "false" : "true";
  });

  rootEl.addEventListener("click", (event) => {
    const action = event.target.getAttribute("data-action");
    if (action === "sync") {
      loadScenario(activeScenario);
      return;
    }

    if (action === "center") {
      centerMap();
      return;
    }

    if (action === "close") {
      rootEl.dataset.open = "false";
    }
  });

  loadScenario(activeScenario);
})();
