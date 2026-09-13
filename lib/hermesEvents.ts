/**
 * Fans out the shared HermesClient's push-frame events (message.delta/message.complete/
 * turn.error/tool.started/tool.completed/etc., per Vyron Pro's own verified event
 * vocabulary) to per-hermes-session subscribers, so the /api/hermes/events SSE route can
 * stream only the events relevant to the session a given browser tab is watching.
 */
import { getHermesClient, type HermesEvent } from "./hermesClient";
import { getSessionByHermesId, setSessionStatus } from "./sessions";

type Subscriber = (evt: HermesEvent) => void;

const subscribersBySession = new Map<string, Set<Subscriber>>();
let wired = false;

// Terminal-ish event types that update the persisted conversation status (lib/sessions.ts's
// coarse SessionStatus) — everything else (message.delta, thinking.delta, tool.*) is
// transient UI state, deliberately never written to SQLite.
const STATUS_BY_EVENT_TYPE: Record<string, "completed" | "error"> = {
  "message.complete": "completed",
  "turn.error": "error",
};

function ensureWired() {
  if (wired) return;
  wired = true;
  getHermesClient().onEvent((evt) => {
    if (!evt.sessionId) return;

    const newStatus = STATUS_BY_EVENT_TYPE[evt.type];
    if (newStatus) {
      const local = getSessionByHermesId(evt.sessionId);
      if (local) setSessionStatus(local.id, newStatus);
    }

    const subs = subscribersBySession.get(evt.sessionId);
    if (!subs) return;
    for (const sub of subs) sub(evt);
  });
}

export function subscribeToHermesSession(hermesSessionId: string, listener: Subscriber): () => void {
  ensureWired();
  if (!subscribersBySession.has(hermesSessionId)) subscribersBySession.set(hermesSessionId, new Set());
  const set = subscribersBySession.get(hermesSessionId)!;
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) subscribersBySession.delete(hermesSessionId);
  };
}
