// @ts-check
/**
 * The marker tab. Read-only view of chrome.storage.local, kept intentionally
 * tiny: connection status + workspace list, live-updated via
 * chrome.storage.onChanged.
 */

/** @type {Record<string, string>} */
const COLOR_HEX = {
  grey: "#80868b",
  blue: "#8ab4f8",
  red: "#f28b82",
  yellow: "#fdd663",
  green: "#81c995",
  pink: "#ff8bcb",
  purple: "#d7aefb",
  cyan: "#78d9ec",
  orange: "#fcad70",
};

const dot = /** @type {HTMLElement} */ (document.getElementById("status-dot"));
const statusText = /** @type {HTMLElement} */ (document.getElementById("status-text"));
const activeWorkspace = /** @type {HTMLElement} */ (document.getElementById("active-workspace"));
const list = /** @type {HTMLElement} */ (document.getElementById("workspace-list"));

/**
 * @param {{connected: boolean, reason?: string}} [status]
 */
function renderStatus(status) {
  const connected = !!status?.connected;
  dot.className = "dot " + (connected ? "connected" : "disconnected");
  if (connected) {
    statusText.textContent = "connected";
  } else if (status?.reason === "bad_token") {
    statusText.textContent = "bad token — check options";
  } else if (status) {
    statusText.textContent = "reconnecting…";
  } else {
    statusText.textContent = "connecting…";
  }
}

/**
 * @param {import("./reducer.js").State} [state]
 */
function renderActiveWorkspace(state) {
  const entry = state?.activeId ? state.byId[state.activeId] : undefined;
  activeWorkspace.textContent = "";
  if (!entry) {
    const none = document.createElement("span");
    none.className = "none";
    none.textContent = "no active workspace";
    activeWorkspace.appendChild(none);
    return;
  }
  activeWorkspace.textContent = entry.title;
}

/**
 * @param {import("./reducer.js").State} [state]
 */
function renderWorkspaces(state) {
  list.innerHTML = "";
  const byId = state?.byId ?? {};
  const ids = Object.keys(byId);
  if (ids.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "no workspaces yet";
    list.appendChild(li);
    return;
  }
  for (const id of ids) {
    const entry = byId[id];
    const li = document.createElement("li");
    li.className = [entry.archived ? "archived" : "", id === state?.activeId ? "active" : ""]
      .filter(Boolean)
      .join(" ");

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = COLOR_HEX[entry.color] ?? "#80868b";

    const label = document.createElement("span");
    label.className = "title";
    label.textContent = entry.title;

    li.append(swatch, label);

    if (entry.ports && entry.ports.length > 0) {
      const ports = document.createElement("span");
      ports.className = "ports";
      for (const port of entry.ports) {
        const link = document.createElement("a");
        link.href = `http://localhost:${port}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = String(port);
        ports.appendChild(link);
      }
      li.appendChild(ports);
    }

    list.appendChild(li);
  }
}

/**
 * @param {import("./reducer.js").State} [state]
 */
function renderState(state) {
  renderActiveWorkspace(state);
  renderWorkspaces(state);
}

async function init() {
  const { metamuxState, metamuxStatus } = await chrome.storage.local.get(["metamuxState", "metamuxStatus"]);
  renderStatus(metamuxStatus);
  renderState(metamuxState);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.metamuxStatus) renderStatus(changes.metamuxStatus.newValue);
  if (changes.metamuxState) renderState(changes.metamuxState.newValue);
});

init();
