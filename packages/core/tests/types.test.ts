import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRESHNESS,
  EXECUTION_STATUS,
  PROMPT_VERSION,
  freshnessTtlMs,
  estimateTokens
} from "@grokmax/core";

describe("types", () => {
  it("defines the canonical prompt version", () => {
    expect(PROMPT_VERSION).toBe("grokmax-v0.2.0-rc.2");
  });

  it("defaults freshness to hourly", () => {
    expect(DEFAULT_FRESHNESS).toBe("hourly");
  });

  it("maps freshness classes to TTLs", () => {
    expect(freshnessTtlMs("immutable")).toBeNull();
    expect(freshnessTtlMs("slow")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(freshnessTtlMs("daily")).toBe(24 * 60 * 60 * 1000);
    expect(freshnessTtlMs("hourly")).toBe(60 * 60 * 1000);
    expect(freshnessTtlMs("live")).toBe(5 * 60 * 1000);
    expect(freshnessTtlMs("never-cache")).toBe(0);
  });

  it("estimates tokens as chars/4", () => {
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(0)).toBe(0);
  });

  it("exposes stable execution statuses", () => {
    expect(Object.values(EXECUTION_STATUS)).toEqual(["success", "failure", "partial", "blocked", "skipped"]);
  });
});