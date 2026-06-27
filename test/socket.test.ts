import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loft, LoftError } from "../src/index";
import { FakeWebSocket, installSocketGlobals } from "./helpers";

beforeEach(() => {
  installSocketGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function socket(index = 0): FakeWebSocket {
  const ws = FakeWebSocket.instances[index];
  if (!ws) throw new Error(`no FakeWebSocket at index ${index}`);
  return ws;
}

describe("loft.socket.channel", () => {
  it("connects to a wss URL scoped to the channel", () => {
    loft.socket.channel("lobby");
    expect(socket().url).toBe("wss://app.example/api/socket?channel=lobby");
  });

  it("buffers sends until open, then flushes in order", () => {
    const ch = loft.socket.channel("lobby");
    ch.send({ a: 1 });
    expect(socket().sent).toEqual([]);
    socket().open();
    ch.send({ b: 2 });
    expect(socket().sent).toEqual([JSON.stringify({ a: 1 }), JSON.stringify({ b: 2 })]);
  });

  it("delivers incoming messages until the handler is removed", () => {
    const ch = loft.socket.channel("lobby");
    socket().open();
    const got: unknown[] = [];
    const off = ch.on((m) => got.push(m));
    socket().emit(JSON.stringify({ hi: "there" }));
    off();
    socket().emit(JSON.stringify({ hi: "again" }));
    expect(got).toEqual([{ hi: "there" }]);
  });

  it("reconnects with backoff after the socket drops", () => {
    vi.useFakeTimers();
    loft.socket.channel("lobby");
    socket().open();
    socket().dropFromServer();
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("stops reconnecting after close()", () => {
    vi.useFakeTimers();
    const ch = loft.socket.channel("lobby");
    ch.close();
    vi.advanceTimersByTime(20000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("cancels a pending reconnect when closed mid-backoff (no leaked socket)", () => {
    vi.useFakeTimers();
    const ch = loft.socket.channel("lobby");
    socket().open();
    socket().dropFromServer(); // schedules a reconnect
    ch.close(); // must clear the pending timer
    vi.advanceTimersByTime(20000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("drops the oldest buffered sends once the cap is reached", () => {
    const ch = loft.socket.channel("lobby");
    for (let i = 0; i < 1100; i++) ch.send({ n: i });
    socket().open(); // flushes the buffer
    expect(socket().sent).toHaveLength(1000);
    expect(JSON.parse(socket().sent[0] ?? "{}")).toEqual({ n: 100 }); // first 100 dropped
  });

  it("reports connection status through onStatus", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const ch = loft.socket.channel("lobby", { onStatus: (s) => seen.push(s) });
    socket().open();
    socket().dropFromServer();
    ch.close();
    expect(seen).toEqual(["open", "reconnecting", "closed"]);
  });

  it("surfaces a socket error through onError as a LoftError", () => {
    const errors: unknown[] = [];
    loft.socket.channel("lobby", { onError: (e) => errors.push(e) });
    socket().errorEvent();
    expect(errors[0]).toBeInstanceOf(LoftError);
    expect(errors[0]).toMatchObject({ kind: "network" });
  });
});

describe("collection.subscribe", () => {
  it("dispatches create, update and delete", () => {
    const created: unknown[] = [];
    const updated: unknown[] = [];
    const deleted: string[] = [];
    const stop = loft.db.collection("posts").subscribe({
      onCreate: (d) => created.push(d),
      onUpdate: (d) => updated.push(d),
      onDelete: (id) => deleted.push(id),
    });
    socket().open();
    socket().emit(JSON.stringify({ op: "create", doc: { id: "1" } }));
    socket().emit(JSON.stringify({ op: "update", doc: { id: "1", done: true } }));
    socket().emit(JSON.stringify({ op: "delete", id: "1" }));
    stop();
    expect(created).toEqual([{ id: "1" }]);
    expect(updated).toEqual([{ id: "1", done: true }]);
    expect(deleted).toEqual(["1"]);
  });

  it("ignores a malformed frame instead of throwing", () => {
    const created: unknown[] = [];
    loft.db.collection("posts").subscribe({ onCreate: (d) => created.push(d) });
    socket().open();
    expect(() => socket().emit("not json")).not.toThrow();
    socket().emit(JSON.stringify({ op: "create", doc: { id: "1" } }));
    expect(created).toEqual([{ id: "1" }]);
  });
});
