import { describe, it, expect } from "vitest";
import { normalize, type Row } from "../components/TaskTimeline";

function evt(type: string, payload: Record<string, unknown> = {}, ts = 0) {
  return { type, payload, ts };
}

describe("TaskTimeline normalize()", () => {
  it("maps session.info, message.start, message.complete to safe rows in order", () => {
    const rows = normalize([evt("session.info", {}, 1), evt("message.start", {}, 2), evt("message.complete", {}, 3)]);
    expect(rows.map((r) => r.label)).toEqual(["Session ready", "Turn started", "Turn completed"]);
    expect(rows.map((r) => r.state)).toEqual(["info", "running", "completed"]);
  });

  it("collapses repeated thinking.delta events into a single running row instead of one per chunk", () => {
    const rows = normalize([
      evt("thinking.delta", { text: "a" }, 1),
      evt("thinking.delta", { text: "b" }, 2),
      evt("thinking.delta", { text: "c" }, 3),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Thinking…");
  });

  it("pairs tool.started -> tool.completed into one row with a computed duration, relabeled Ran", () => {
    const rows = normalize([evt("tool.started", { tool: "read_file" }, 1000), evt("tool.completed", { tool: "read_file" }, 2500)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Ran read_file");
    expect(rows[0]?.state).toBe("completed");
    expect(rows[0]?.durationMs).toBe(1500);
  });

  it("marks turn.error as a failed row and never renders raw error objects as the label", () => {
    const rows = normalize([evt("turn.error", { message: "provider overloaded" }, 1)]);
    expect(rows[0]?.state).toBe("failed");
    expect(rows[0]?.label).toBe("Turn failed");
  });

  it("ignores message.delta and unrecognized event types (chat content, not timeline rows)", () => {
    const rows = normalize([evt("message.delta", { text: "hello" }, 1), evt("some.unknown.type", { secret: "x" }, 2)]);
    expect(rows).toHaveLength(0);
  });

  it("never includes raw payload fields (e.g. a tool's full input/output) in any row", () => {
    const rows = normalize([
      evt("tool.started", { tool: "write_file", preview: "safe preview", raw_input: { path: "/etc/shadow", content: "SECRET" } }, 1),
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("/etc/shadow");
  });
});
