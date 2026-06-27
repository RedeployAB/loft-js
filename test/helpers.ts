// Test doubles for the browser globals the SDK reaches for: fetch (HTTP and SSE) and WebSocket.
// The SDK touches these only at call time, so stubbing them per test is enough; importing the
// module under test never needs them.

import { vi } from "vitest";

/** A WebSocket stand-in that records sends and lets a test drive open/message/close by hand. */
export class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  // Test-only controls.
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  emit(data: string): void {
    this.onmessage?.({ data });
  }
  errorEvent(): void {
    this.onerror?.();
  }
  dropFromServer(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

export function installSocketGlobals(opts?: { protocol?: string; host?: string }): void {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: opts?.protocol ?? "https:", host: opts?.host ?? "app.example" });
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

export function mockFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const fn = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function rejectingFetch(err: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => Promise.reject(err));
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A streamed response that emits the given chunks (already SSE-framed) then closes. */
export function sseResponse(frames: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

/** A streamed response whose reader rejects on the first pull, to simulate a dropped/aborted stream. */
export function erroringSseResponse(err: unknown, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(err);
    },
  });
  return new Response(stream, { status });
}

export function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
