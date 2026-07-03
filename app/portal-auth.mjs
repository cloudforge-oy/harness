/**
 * Portal key retrieval — PKCE-style loopback flow against the cloudcode.one
 * portal. The consent page opens in the system browser (never a BrowserWindow),
 * the one-time code lands on a localhost callback, and we trade it for the key.
 *
 * Electron-free so the flow can be exercised outside the app; the caller
 * injects `openExternal` (Electron's shell.openExternal in production).
 */
import crypto from "node:crypto";
import http from "node:http";

const b64url = (buf) => buf.toString("base64url");

let activeAuth = null; // { cancel } for the in-flight browser flow

export function cancelPortalAuth(reason) {
  activeAuth?.cancel(reason);
}

// Rejections carry a machine-readable `code`: access_denied, no_active_key,
// timeout, cancelled, state_mismatch, network_error, server_error, http_<n>.
export function fetchApiKeyFromPortal({ portalBase, openExternal, timeoutMs = 5 * 60 * 1000 }) {
  cancelPortalAuth("Restarted");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h3>You can close this tab and return to Harness.</h3>");

      if (url.searchParams.get("state") !== state) return fail("state_mismatch", "State mismatch — flow aborted");
      const errParam = url.searchParams.get("error");
      if (errParam) return fail(errParam); // e.g. access_denied when the user clicks Deny

      try {
        const resp = await fetch(`${portalBase}/api/device/exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ code: url.searchParams.get("code"), code_verifier: verifier }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) return fail(body.error ?? `http_${resp.status}`, body.error ?? `exchange failed (${resp.status})`);
        finish(() => resolve(body.key));
      } catch (err) {
        fail("network_error", `Could not reach the portal: ${err.message}`);
      }
    });

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeAuth = null;
      server.close();
      fn();
    };
    const fail = (code, message) => finish(() => reject(Object.assign(new Error(message ?? code), { code })));

    activeAuth = { cancel: (reason) => fail("cancelled", reason ?? "Cancelled") };
    // Codes are single-use and expire after 5 minutes — a retry restarts the whole flow.
    timer = setTimeout(() => fail("timeout", "Timed out waiting for approval in the browser"), timeoutMs);

    server.on("error", (err) => fail("server_error", err.message));
    server.listen(0, "127.0.0.1", () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const q = new URLSearchParams({ code_challenge: challenge, redirect_uri: redirectUri, state });
      openExternal(`${portalBase}/device/authorize?${q}`);
    });
  });
}
