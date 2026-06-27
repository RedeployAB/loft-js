import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loft } from "../src/index";
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
});
