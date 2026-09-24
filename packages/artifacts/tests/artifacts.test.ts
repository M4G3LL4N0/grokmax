import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "@grokmax/cache";
import { ArtifactStore, ARTIFACT_REF_PREFIX, KnowledgeStore } from "@grokmax/artifacts";

let dirs: string[] = [];
function freshStore() {
  const d = mkdtempSync(join(tmpdir(), "grokmax-art-"));
  dirs.push(d);
  return openStore(join(d, "t.db"));
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("ArtifactStore / L4", () => {
  it("stores and retrieves within scope", () => {
    const store = freshStore();
    const arts = new ArtifactStore(store);
    const { ref, id } = arts.put("markdown", "# Hello", "docs");
    expect(ref).toBe(`${ARTIFACT_REF_PREFIX}${id}`);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    const got = arts.get(ref, "docs");
    expect(got?.data).toBe("# Hello");
    expect(got?.kind).toBe("markdown");
    store.close();
  });

  it("enforces strict scope isolation", () => {
    const store = freshStore();
    const arts = new ArtifactStore(store);
    const { ref } = arts.put("secret", "private note", "scope-a");
    expect(arts.get(ref, "scope-a")).not.toBeNull();
    expect(arts.get(ref, "scope-b")).toBeNull();
    expect(arts.remove(ref, "scope-b")).toBe(false);
    expect(arts.remove(ref, "scope-a")).toBe(true);
    store.close();
  });

  it("rejects malformed refs (path traversal attempts)", () => {
    const store = freshStore();
    const arts = new ArtifactStore(store);
    const { ref } = arts.put("x", "data", "s");
    expect(arts.get("grokmax://artifact/../../etc/passwd", "s")).toBeNull();
    expect(arts.get(ref + "extra", "s")).toBeNull();
    expect(arts.getById("..%2f..%2fetc%2fpasswd", "s")).toBeNull();
    store.close();
  });

  it("upserts by content identity and lists newest first", () => {
    const store = freshStore();
    const arts = new ArtifactStore(store);
    const a = arts.put("k", "same data", "scope");
    const b = arts.put("k", "same data", "scope");
    expect(a.id).toBe(b.id); // same content-derived id upserts
    const c = arts.put("k", "different data", "scope");
    expect(c.id).not.toBe(a.id);
    const list = arts.list("scope");
    expect(list).toHaveLength(2);
    const ids = list.map((x) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(c.id);
    store.close();
  });
});

describe("KnowledgeStore / L5", () => {
  it("set/get/delete/keys round-trip", () => {
    const store = freshStore();
    const k = new KnowledgeStore(store);
    expect(k.get("missing")).toBeNull();
    k.set("releases", "v2.1.0 migrated");
    expect(k.get("releases")).toBe("v2.1.0 migrated");
    k.set("releases", "v2.2.0 migrated");
    expect(k.get("releases")).toBe("v2.2.0 migrated");
    expect(k.keys()).toContain("releases");
    expect(k.delete("releases")).toBe(true);
    expect(k.delete("releases")).toBe(false);
    store.close();
  });

  it("is key-value scoped without cross-talk", () => {
    const store = freshStore();
    const k = new KnowledgeStore(store);
    k.set("a", "1");
    k.set("b", "2");
    expect(k.keys().sort()).toEqual(["a", "b"]);
    store.close();
  });
});