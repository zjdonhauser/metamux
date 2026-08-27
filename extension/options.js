// @ts-check
/**
 * Options page: port + secret, saved to chrome.storage.local (read by
 * ws.js), plus a throwaway "Test connection" WebSocket.
 */

const DEFAULT_PORT = 8377;

const form = /** @type {HTMLFormElement} */ (document.getElementById("form"));
const portInput = /** @type {HTMLInputElement} */ (document.getElementById("port"));
const secretInput = /** @type {HTMLInputElement} */ (document.getElementById("secret"));
const testButton = /** @type {HTMLButtonElement} */ (document.getElementById("test"));
const testResult = /** @type {HTMLElement} */ (document.getElementById("test-result"));

async function load() {
  const { port, secret } = await chrome.storage.local.get(["port", "secret"]);
  portInput.value = String(port ?? DEFAULT_PORT);
  secretInput.value = secret ?? "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const port = Number(portInput.value) || DEFAULT_PORT;
  const secret = secretInput.value.trim();
  await chrome.storage.local.set({ port, secret });
  testResult.textContent = "saved";
  testResult.className = "ok";
});

testButton.addEventListener("click", () => {
  const port = Number(portInput.value) || DEFAULT_PORT;
  const secret = secretInput.value.trim();
  testResult.textContent = "testing…";
  testResult.className = "";

  let settled = false;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/actuator`);
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.close();
    testResult.textContent = "no response (is the daemon running?)";
    testResult.className = "fail";
  }, 3000);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "hello", token: secret, protocol: 1, client: "extension" }));
  });

  socket.addEventListener("message", (event) => {
    if (settled) return;
    try {
      const msg = JSON.parse(/** @type {string} */ (event.data));
      if (msg.type === "sync") {
        settled = true;
        clearTimeout(timeout);
        testResult.textContent = "ok — connected";
        testResult.className = "ok";
        socket.close();
      }
    } catch {
      // ignore malformed frames during the test probe
    }
  });

  socket.addEventListener("close", (event) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    testResult.textContent = event.code === 4001 ? "bad token" : `connection closed (${event.code})`;
    testResult.className = "fail";
  });

  socket.addEventListener("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    testResult.textContent = "connection failed";
    testResult.className = "fail";
  });
});

load();
