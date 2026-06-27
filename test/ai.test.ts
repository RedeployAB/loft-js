import { describe, it, expect, afterEach, vi } from "vitest";
import { loft } from "../src/index";
import { mockFetch, jsonResponse, sseResponse, erroringSseResponse, sseFrame } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ask = [{ role: "user" as const, content: "hi" }];

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const token of stream) out.push(token);
  return out;
}

describe("loft.ai.chat", () => {
  it("requests a non-streaming reply and returns the text", async () => {
    mockFetch((_url, init) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({ stream: false });
      return jsonResponse({ choices: [{ message: { content: "hello" } }] });
    });
    expect(await loft.ai.chat(ask)).toBe("hello");
  });

  it("surfaces a non-2xx response as a LoftError", async () => {
    mockFetch(() => new Response("overloaded", { status: 503 }));
    await expect(loft.ai.chat(ask)).rejects.toMatchObject({ kind: "http", status: 503 });
  });
});

describe("loft.ai.stream", () => {
  it("requests a streaming response", async () => {
    mockFetch((_url, init) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({ stream: true });
      return sseResponse([sseFrame({ choices: [{ delta: { content: "x" } }] }), "data: [DONE]\n\n"]);
    });
    expect(await collect(loft.ai.stream(ask))).toEqual(["x"]);
  });

  it("yields tokens in order until [DONE]", async () => {
    mockFetch(() =>
      sseResponse([
        sseFrame({ choices: [{ delta: { content: "He" } }] }),
        sseFrame({ choices: [{ delta: { content: "llo" } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    expect(await collect(loft.ai.stream(ask))).toEqual(["He", "llo"]);
  });

  it("ignores malformed SSE frames", async () => {
    mockFetch(() =>
      sseResponse([
        "data: not json\n\n",
        sseFrame({ choices: [{ delta: { content: "ok" } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    expect(await collect(loft.ai.stream(ask))).toEqual(["ok"]);
  });

  it("throws kind stream when the stream ends without [DONE]", async () => {
    mockFetch(() => sseResponse([sseFrame({ choices: [{ delta: { content: "Hi" } }] })]));
    await expect(collect(loft.ai.stream(ask))).rejects.toMatchObject({ kind: "stream" });
  });

  it("maps a mid-stream abort to kind aborted", async () => {
    mockFetch(() => erroringSseResponse(new DOMException("stop", "AbortError")));
    await expect(collect(loft.ai.stream(ask))).rejects.toMatchObject({ kind: "aborted" });
  });

  it("maps a mid-stream timeout to kind timeout", async () => {
    mockFetch(() => erroringSseResponse(new DOMException("slow", "TimeoutError")));
    await expect(collect(loft.ai.stream(ask))).rejects.toMatchObject({ kind: "timeout" });
  });

  it("surfaces a non-2xx response as a LoftError", async () => {
    mockFetch(() => new Response("overloaded", { status: 503 }));
    await expect(collect(loft.ai.stream(ask))).rejects.toMatchObject({ kind: "http", status: 503 });
  });
});
