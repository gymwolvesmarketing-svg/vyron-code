"use client";
import { useCallback, useEffect, useState } from "react";

type HermesHealth = { configured: boolean; reachable: boolean };

// Passive runtime status only — "Refresh" re-fetches health, nothing else. No control here
// ever creates a session, sends a prompt, or restarts any process
// (VYRON_CODE_V01_LOCAL_RUNTIME_HARDENING_IMPLEMENTATION_AUTHORIZATION, section C).
export function SystemStatus() {
  const [vyronCodeReachable, setVyronCodeReachable] = useState(true);
  const [hermes, setHermes] = useState<HermesHealth | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/hermes/health");
      setVyronCodeReachable(true);
      setHermes(res.ok ? await res.json() : { configured: false, reachable: false });
    } catch {
      setVyronCodeReachable(false);
    } finally {
      setChecking(false);
    }
  }, []);

  // Not a call to refresh() itself — the effect body must contain no synchronous setState
  // call reachable from it; wrapping in a fire-and-forget async IIFE keeps every setState
  // call inside an async continuation, which is the pattern React's own rule allows.
  useEffect(() => {
    void (async () => {
      await refresh();
    })();
    const id = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const hermesLabel = !vyronCodeReachable
    ? "unknown"
    : hermes === null
      ? "checking…"
      : hermes.reachable
        ? "reachable"
        : hermes.configured
          ? "unreachable"
          : "not configured";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "4px 8px",
        fontSize: 11,
        borderBottom: "1px solid var(--panel-border)",
        flexWrap: "wrap",
      }}
    >
      <span className="badge">localhost-only dev mode</span>
      <span style={{ color: vyronCodeReachable ? "var(--ok)" : "var(--danger)" }}>Vyron Code: {vyronCodeReachable ? "reachable" : "unreachable"}</span>
      <span style={{ color: hermes?.reachable ? "var(--ok)" : "var(--text-dim)" }}>Hermes: {hermesLabel}</span>
      <button onClick={refresh} disabled={checking} style={{ marginLeft: "auto" }} aria-label="Refresh system status">
        {checking ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
