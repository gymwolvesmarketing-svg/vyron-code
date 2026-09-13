import { NextRequest } from "next/server";
import { getSession } from "@/lib/sessions";
import { subscribeToHermesSession } from "@/lib/hermesEvents";

// Server-Sent Events stream of a single Hermes session's push-frame events
// (tool.started/tool.completed/reasoning.available/etc.), scoped to sessions this Vyron
// Code instance itself created — a session_id that doesn't map to a known local session
// is refused rather than trusting a client-supplied hermes_session_id directly.
export async function GET(req: NextRequest) {
  const localSessionId = new URL(req.url).searchParams.get("session_id");
  if (!localSessionId) return new Response("session_id required", { status: 400 });
  const session = getSession(localSessionId);
  if (!session) return new Response("unknown session_id", { status: 404 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = subscribeToHermesSession(session.hermesSessionId, (evt) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      });
      controller.enqueue(encoder.encode(`: connected\n\n`));
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
