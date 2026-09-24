import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cli = join(process.cwd(), "apps/cli/src/index.ts");
const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

interface Plan {
  plan: {
    route: string;
    cacheLayer: string;
    cacheChecks: Array<{ layer: string; hit: boolean; reason: string }>;
  };
  outcome: string;
  status: string;
}

async function optimize(db: string, args: string[]): Promise<Plan> {
  const { stdout } = await execFileAsync(process.execPath, [tsx, cli, "optimize", "Calculate 2+2", ...args, "--json"], {
    cwd: process.cwd(),
    env: { ...process.env, GROKMAX_DB: db },
    timeout: 30_000
  });
  return JSON.parse(stdout) as Plan;
}

function l1Hit(plan: Plan): boolean {
  return plan.plan.cacheChecks.some((c) => c.layer === "L1" && c.hit);
}

describe("CLI --fresh", () => {
  it("recomputes instead of serving an L1 exact hit", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "grokmax-fresh-")), "t.db");
    dirs.push(join(db, ".."));

    const first = await optimize(db, []);
    expect(first.status).toBe("success");
    expect(first.outcome).toContain("4");
    expect(l1Hit(first)).toBe(false);

    const cached = await optimize(db, []);
    expect(l1Hit(cached)).toBe(true);
    expect(cached.plan.route).toBe("NONE");

    const fresh = await optimize(db, ["--fresh"]);
    expect(fresh.status).toBe("success");
    expect(fresh.outcome).toContain("4");
    expect(l1Hit(fresh)).toBe(false);
    expect(fresh.plan.cacheLayer).toBe("MISS");
    expect(fresh.plan.route).not.toBe("NONE");

    const freshAgain = await optimize(db, ["--fresh"]);
    expect(l1Hit(freshAgain)).toBe(false);
    expect(freshAgain.plan.cacheLayer).toBe("MISS");
  });
});
