import { describe, it, expect, afterEach, vi } from "vitest";
import { loft, LoftError } from "../src/index";
import { mockFetch, rejectingFetch, jsonResponse } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loft.user.me", () => {
  it("returns the signed-in user", async () => {
    mockFetch(() => jsonResponse({ id: "u1", email: "a@b.com", name: "A" }));
    expect(await loft.user.me()).toEqual({ id: "u1", email: "a@b.com", name: "A" });
  });

  it("maps 401 to a LoftError of kind auth", async () => {
    mockFetch(() => jsonResponse({}, 401));
    const err = await loft.user.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoftError);
    expect(err).toMatchObject({ name: "LoftError", kind: "auth", status: 401 });
  });

  it("maps a fetch rejection to kind network", async () => {
    rejectingFetch(new TypeError("offline"));
    await expect(loft.user.me()).rejects.toMatchObject({ kind: "network" });
  });

  it("maps an AbortError to kind aborted and forwards the signal", async () => {
    const fetchMock = rejectingFetch(new DOMException("stop", "AbortError"));
    const ctrl = new AbortController();
    await expect(loft.user.me({ signal: ctrl.signal })).rejects.toMatchObject({ kind: "aborted" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(ctrl.signal);
  });

  it("maps a TimeoutError (AbortSignal.timeout) to kind timeout", async () => {
    rejectingFetch(new DOMException("slow", "TimeoutError"));
    await expect(loft.user.me()).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("loft.db", () => {
  it("creates a document", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(url).toBe("/api/db/posts");
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "1", title: "hi" });
    });
    expect(await loft.db.collection("posts").create({ title: "hi" })).toEqual({ id: "1", title: "hi" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("adds ownerOnly to the create URL", async () => {
    mockFetch((url) => {
      expect(url).toBe("/api/db/posts?ownerOnly=1");
      return jsonResponse({ id: "1" });
    });
    await loft.db.collection("posts", { ownerOnly: true }).create({});
  });

  it("returns null on a 404 get", async () => {
    mockFetch(() => jsonResponse({}, 404));
    expect(await loft.db.collection("posts").get("missing")).toBeNull();
  });

  it("passes limit through to list", async () => {
    mockFetch((url) => {
      expect(url).toBe("/api/db/posts?limit=5");
      return jsonResponse([]);
    });
    expect(await loft.db.collection("posts").list({ limit: 5 })).toEqual([]);
  });

  it("maps a 500 to kind http", async () => {
    mockFetch(() => jsonResponse({}, 500));
    await expect(loft.db.collection("posts").list()).rejects.toMatchObject({ kind: "http", status: 500 });
  });
});

describe("loft.upload", () => {
  it("uploads a blob and returns the stored url", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/upload");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Loft-Filename")).toBe("notes.txt");
      return jsonResponse({ url: "/uploads/abc", name: "notes.txt", size: 3 });
    });
    expect(await loft.upload(new Blob(["abc"]), { name: "notes.txt" })).toEqual({
      url: "/uploads/abc",
      name: "notes.txt",
      size: 3,
    });
  });

  it("deletes by url", async () => {
    mockFetch((url, init) => {
      expect(init?.method).toBe("DELETE");
      expect(url).toBe(`/api/upload?path=${encodeURIComponent("/uploads/abc")}`);
      return jsonResponse({});
    });
    await loft.upload.delete("/uploads/abc");
  });
});
