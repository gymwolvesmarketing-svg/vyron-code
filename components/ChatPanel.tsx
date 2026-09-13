"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/apiClient";
import { SessionList } from "./SessionList";
import type { RawTimelineEvent } from "./TaskTimeline";

type Phase =
  | "idle"
  | "connecting"
  | "active"
  | "submitting"
  | "waiting_for_provider"
  | "streaming"
  | "interrupted"
  | "completed"
  | "error";

type MessageItem = { id: string; kind: "user" | "assistant" | "system" | "error"; text: string };

// Matches HermesEvent's unwrapped shape from lib/hermesClient.ts: {type, sessionId, payload}.
type HermesEvt = { type: string; sessionId: string; payload: Record<string, unknown> };

const READY_PHASES: Phase[] = ["active", "completed", "interrupted", "error"];
const BUSY_PHASES: Phase[] = ["submitting", "waiting_for_provider", "streaming"];

const PHASE_LABEL: Record<Phase, string> = {
  idle: "No session",
  connecting: "Connecting…",
  active: "Ready",
  submitting: "Sending…",
  waiting_for_provider: "Waiting for model…",
  streaming: "Streaming…",
  interrupted: "Interrupted",
  completed: "Done",
  error: "Error",
};

export function ChatPanel({
  projectId,
  onTimelineEvent,
  onSessionChange,
}: {
  projectId: string;
  onTimelineEvent?: (evt: RawTimelineEvent) => void;
  onSessionChange?: (sessionId: string | null) => void;
}) {
  const [localSessionId, setLocalSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [interrupting, setInterrupting] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [sessionListRefresh, setSessionListRefresh] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const activeReplyIdRef = useRef<string | null>(null);

  useEffect(() => () => eventSourceRef.current?.close(), []);

  // Visible "Ns" counter while waiting on the provider — the one thing that keeps a slow
  // (30-90s+) turn from reading as a frozen UI, without polling anything.
  useEffect(() => {
    if (phase !== "waiting_for_provider" || waitingSince === null) return;
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - waitingSince) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase, waitingSince]);

  function appendMessage(item: MessageItem) {
    setMessages((prev) => [...prev, item]);
  }

  function openEventSource(sessionId: string) {
    eventSourceRef.current?.close();
    const es = new EventSource(`/api/hermes/events?session_id=${encodeURIComponent(sessionId)}`);
    es.onmessage = (ev) => {
      try {
        handleEvent(JSON.parse(ev.data));
      } catch {
        /* comment/keepalive frame */
      }
    };
    eventSourceRef.current = es;
  }

  function handleEvent(evt: HermesEvt) {
    onTimelineEvent?.({ type: evt.type, payload: evt.payload, ts: Date.now() });
    const p = evt.payload || {};

    switch (evt.type) {
      case "message.delta": {
        const chunk = (p.text ?? p.delta ?? p.content) as string | undefined;
        setPhase("streaming");
        if (!chunk) return;
        if (activeReplyIdRef.current) {
          const id = activeReplyIdRef.current;
          setMessages((prev) => prev.map((it) => (it.id === id ? { ...it, text: it.text + chunk } : it)));
        } else {
          const id = `${Date.now()}-reply`;
          activeReplyIdRef.current = id;
          appendMessage({ id, kind: "assistant", text: chunk });
        }
        return;
      }
      case "message.complete": {
        const full = (p.text ?? p.content) as string | undefined;
        const id = activeReplyIdRef.current;
        if (id) {
          setMessages((prev) => prev.map((it) => (it.id === id ? { ...it, text: full || it.text } : it)));
        } else if (full) {
          appendMessage({ id: `${Date.now()}-reply`, kind: "assistant", text: full });
        }
        activeReplyIdRef.current = null;
        setPhase("completed");
        setWaitingSince(null);
        setSessionListRefresh((n) => n + 1);
        return;
      }
      case "turn.error": {
        activeReplyIdRef.current = null;
        setPhase("error");
        setWaitingSince(null);
        appendMessage({ id: `${Date.now()}-err`, kind: "error", text: String(p.message ?? p.error ?? "The model turn failed.") });
        setSessionListRefresh((n) => n + 1);
        return;
      }
      default:
        // thinking.delta, tool.started/completed, session.info, etc. — timeline-only, but if
        // we're still between "submitted" and the first real token, keep the visible phase
        // at waiting_for_provider so the UI doesn't look stuck on "Sending…".
        setPhase((prev) => (prev === "submitting" ? "waiting_for_provider" : prev));
    }
  }

  async function startNewChat() {
    setPhase("connecting");
    setErrorMessage(null);
    setMessages([]);
    activeReplyIdRef.current = null;
    try {
      const { session_id } = await api.createHermesSession(projectId);
      setLocalSessionId(session_id);
      onSessionChange?.(session_id);
      openEventSource(session_id);
      setPhase("active");
      setSessionListRefresh((n) => n + 1);
    } catch (e: any) {
      setPhase("error");
      setErrorMessage(e.message || "Could not start a session.");
    }
  }

  function selectConversation(id: string) {
    if (id === localSessionId) return;
    setLocalSessionId(id);
    onSessionChange?.(id);
    setMessages([{ id: "resume-note", kind: "system", text: "Resumed conversation — only new activity appears below." }]);
    activeReplyIdRef.current = null;
    setErrorMessage(null);
    openEventSource(id);
    setPhase("active");
  }

  async function send() {
    if (!localSessionId || !input.trim() || !READY_PHASES.includes(phase)) return;
    const text = input;
    setInput("");
    setErrorMessage(null);
    appendMessage({ id: `${Date.now()}-p`, kind: "user", text });
    setPhase("submitting");
    try {
      await api.submitPrompt(localSessionId, text);
      setWaitingSince(Date.now());
      setElapsedSec(0);
      setSessionListRefresh((n) => n + 1);
    } catch (e: any) {
      setPhase("error");
      setErrorMessage(e.message || "Could not send the prompt.");
    }
  }

  async function interrupt() {
    if (!localSessionId || interrupting || !BUSY_PHASES.includes(phase)) return;
    setInterrupting(true);
    try {
      await api.interruptSession(localSessionId);
      setPhase("interrupted");
      setWaitingSince(null);
      appendMessage({ id: `${Date.now()}-int`, kind: "system", text: "Interrupted." });
      setSessionListRefresh((n) => n + 1);
    } catch (e: any) {
      appendMessage({ id: `${Date.now()}-intfail`, kind: "error", text: `Interrupt failed: ${e.message || "unknown error"}` });
    } finally {
      setInterrupting(false);
    }
  }

  const MESSAGE_COLOR: Record<MessageItem["kind"], string> = {
    user: "var(--text)",
    assistant: "var(--text)",
    system: "var(--text-dim)",
    error: "var(--danger)",
  };

  const canSend = READY_PHASES.includes(phase) && !!localSessionId;
  const canInterrupt = BUSY_PHASES.includes(phase) && !interrupting;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", height: "100%" }}>
      <div style={{ borderRight: "1px solid var(--panel-border)", overflowY: "auto", padding: 4 }}>
        <SessionList
          projectId={projectId}
          activeLocalSessionId={localSessionId}
          refreshToken={sessionListRefresh}
          onNewChat={startNewChat}
          onSelect={selectConversation}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ padding: 8, borderBottom: "1px solid var(--panel-border)", display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge">Chat / Cowork</span>
          <span style={{ color: phase === "error" ? "var(--danger)" : phase === "active" || phase === "completed" ? "var(--ok)" : "var(--text-dim)" }}>
            {PHASE_LABEL[phase]}
            {phase === "waiting_for_provider" && ` — ${elapsedSec}s`}
          </span>
          {canInterrupt && (
            <button onClick={interrupt} disabled={interrupting} style={{ marginLeft: "auto" }} aria-label="Interrupt the current turn">
              {interrupting ? "Interrupting…" : "■ Stop"}
            </button>
          )}
          {errorMessage && <span style={{ color: "var(--danger)", fontSize: 11 }}>{errorMessage}</span>}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
          {phase === "idle" && messages.length === 0 && (
            <div style={{ color: "var(--text-dim)" }}>
              No active conversation. Click <strong>+ New chat</strong> to start one, or pick a previous conversation from the list.
            </div>
          )}
          {messages.map((item) => (
            <div
              key={item.id}
              style={{
                marginBottom: 6,
                whiteSpace: "pre-wrap",
                color: MESSAGE_COLOR[item.kind],
                fontFamily: item.kind === "system" || item.kind === "error" ? "ui-monospace, monospace" : "inherit",
                fontSize: item.kind === "system" || item.kind === "error" ? 11 : 13,
              }}
            >
              {item.kind === "user" ? `› ${item.text}` : item.text}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 6, padding: 8, borderTop: "1px solid var(--panel-border)" }}>
          <input
            style={{ flex: 1 }}
            value={input}
            disabled={!canSend}
            placeholder={localSessionId ? "Prompt Hermes…" : "Start a chat first"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            aria-label="Prompt input"
          />
          <button onClick={send} disabled={!canSend || !input.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
