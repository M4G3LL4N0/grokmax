import { describe, expect, it } from "vitest";
import { compile, compileAdaptive, validatePreservation } from "@grokmax/compiler";
import { extractHardConstraints } from "@grokmax/compiler";
import type { GrokMaxTask } from "@grokmax/core";

const task = (over: Partial<GrokMaxTask>): GrokMaxTask => ({ intent: "intent here", goal: "goal here", ...over });

describe("compile", () => {
  it("preserves hard constraints verbatim", () => {
    const c = compile({ task: task({ constraints: ["pnpm only", "no new dependencies"] }), selectedContext: [] });
    expect(c.prompt).toContain("pnpm only");
    expect(c.prompt).toContain("no new dependencies");
    expect(c.validation.ok).toBe(true);
    expect(c.preserved).toEqual(expect.arrayContaining(["pnpm only", "no new dependencies"]));
  });

  it("scans goal/intent/context for implicit hard constraints", () => {
    const c = compile({ task: task({ goal: "Deploy to staging but never to prod. Use pnpm only." }), selectedContext: [] });
    expect(c.prompt).toContain("never");
    expect(c.prompt).toContain("pnpm only");
    expect(c.validation.ok).toBe(true);
  });

  it("includes stop conditions extracted from constraints", () => {
    const c = compile({ task: task({ constraints: ["stop after the first successful test", "do not deploy to prod"] }), selectedContext: [] });
    expect(c.prompt).toMatch(/STOP CONDITIONS/);
    expect(c.prompt).toContain("do not deploy to prod");
  });

  it("emits output schema matching requested output type", () => {
    const answer = compile({ task: task({ output: "answer" }), selectedContext: [] });
    const artifact = compile({ task: task({ output: "artifact" }), selectedContext: [] });
    expect(answer.prompt).toContain("Return a concise answer.");
    expect(artifact.prompt).toContain('"status": "success|failure|partial"');
  });

  it("compresses context wording but keeps meaningful tokens", () => {
    const c = compile({ task: task({}), selectedContext: ["The system shall use the cache. The system shall use the cache. The system shall use the cache."] });
    expect(c.prompt.length).toBeLessThan(500);
    expect(c.prompt).toContain("system");
    expect(c.prompt).toContain("cache");
    expect(c.prompt.toLowerCase()).toContain("context");
  });

  it("keeps only the history tail", () => {
    const c = compile({
      task: task({}),
      selectedContext: [],
      history: ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"]
    });
    expect(c.prompt).toContain("PRIOR TAIL");
  });

  it("reports token estimates and stage decomposition", () => {
    const c = compile({ task: task({}), selectedContext: ["abc ".repeat(100)] });
    expect(c.tokensEstimate).toBeGreaterThan(0);
    expect(c.stages.some((s) => s.name === "context-compress")).toBe(true);
  });
});

describe("validatePreservation", () => {
  it("passes when every significant constraint token survives", () => {
    const r = validatePreservation(["do not deploy to prod"], "do not deploy to prod under any circumstance");
    expect(r.ok).toBe(true);
    expect(r.preservedConstraints).toEqual(["do not deploy to prod"]);
  });

  it("flags lost constraints", () => {
    const r = validatePreservation(["do not deploy to ec2 us-west"], "do not deploy anywhere");
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it("rejects a constraint whose negation was stripped", () => {
    const r = validatePreservation(["do not deploy"], "deploy the service now");
    expect(r.ok).toBe(false);
    expect(r.lostConstraints).toEqual(["do not deploy"]);
    expect(r.preservedConstraints).toEqual([]);
  });

  it("never lets a negation slip: 'deploy' alone must not satisfy 'do not deploy'", () => {
    const r = validatePreservation(["do not deploy the website"], "the website is deployable");
    expect(r.ok).toBe(false);
    expect(r.lostConstraints.join()).toContain("do not deploy the website");
  });

  it("keeps negation/modal words first-class for all prohibition classes", () => {
    expect(validatePreservation(["must not touch vendor"], "touch vendor").ok).toBe(false);
    expect(validatePreservation(["only use pnpm"], "use npm").ok).toBe(false);
    expect(validatePreservation(["at most 3 retries"], "retry freely").ok).toBe(false);
  });

  it("does not treat $50 as preserved inside $500", () => {
    const lost = validatePreservation(["budget $50"], "budget $500 for the quarter");
    expect(lost.ok).toBe(false);
    expect(lost.lostConstraints).toEqual(["budget $50"]);

    const ellipsis = validatePreservation(["budget $50"], "budget $500…");
    expect(ellipsis.ok).toBe(false);

    const kept = validatePreservation(["budget $50"], "budget $50 for the quarter");
    expect(kept.ok).toBe(true);
    expect(kept.preservedConstraints).toEqual(["budget $50"]);

    const embedded = validatePreservation(["budget $50"], "keep the budget $50 cap");
    expect(embedded.ok).toBe(true);

    const later = validatePreservation(["budget $50"], "budget $500 or budget $50");
    expect(later.ok).toBe(true);

    expect(validatePreservation(["budget $50"], "budget $50.00 for the quarter").ok).toBe(false);
    expect(validatePreservation(["at most 3"], "at most 30").ok).toBe(false);
    expect(validatePreservation(["at most 3"], "at most 3 retries").ok).toBe(true);
  });
});

describe("extractHardConstraints", () => {
  it("detects operator/budget/approval constraints", () => {
    const found = extractHardConstraints("Do not deploy to prod.\nKeep the vendor directory unchanged.\nUnder no circumstances install via npm.\nNothing hard here.");
    expect(found.join("\n")).toContain("Do not deploy to prod");
    expect(found).toHaveLength(3);
  });
});

describe("compileAdaptive", () => {
  it("degrades to compile", () => {
    const c = compileAdaptive({ task: task({ constraints: ["pnpm only"] }), selectedContext: [] });
    expect(c.prompt).toContain("pnpm only");
  });
});