import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { benchmarkFixturesPresent } from "../src/benchmark.js";

const execFileAsync = promisify(execFile);
const cli = join(process.cwd(), "apps/cli/src/index.ts");
const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "grokmax-fixtures-"));
  dirs.push(d);
  return d;
}

interface DoctorReport {
  checks: Array<{ name: string; status: string; detail: string }>;
}

async function doctor(cwd: string): Promise<DoctorReport> {
  const db = join(tempDir(), "doctor.db");
  const { stdout } = await execFileAsync(process.execPath, [tsx, cli, "--cwd", cwd, "doctor", "--json"], {
    cwd: process.cwd(),
    env: { ...process.env, GROKMAX_DB: db },
    timeout: 30_000
  });
  return JSON.parse(stdout) as DoctorReport;
}

function fixtureCheck(report: DoctorReport): { name: string; status: string; detail: string } {
  const check = report.checks.find((c) => c.name === "benchmark-fixtures");
  if (!check) throw new Error("benchmark-fixtures check missing");
  return check;
}

describe("benchmark fixture detection", () => {
  it("finds fixtures even when the directory is not named grokmax", () => {
    expect(benchmarkFixturesPresent(process.cwd())).toBe(true);

    const named = tempDir();
    const suite = join(named, "not-grokmax-name", "benchmarks", "suites", "math");
    mkdirSync(suite, { recursive: true });
    writeFileSync(join(suite, "one.json"), "[]\n");
    expect(benchmarkFixturesPresent(join(named, "not-grokmax-name"))).toBe(true);
  });

  it("still reports fixtures missing when no suite json exists", () => {
    const empty = tempDir();
    expect(benchmarkFixturesPresent(empty)).toBe(false);

    const bare = tempDir();
    mkdirSync(join(bare, "benchmarks", "suites", "math"), { recursive: true });
    expect(benchmarkFixturesPresent(bare)).toBe(false);
  });

  it("doctor uses the filesystem check, not the directory basename", async () => {
    const here = await doctor(process.cwd());
    expect(fixtureCheck(here).status).toBe("healthy");

    const empty = tempDir();
    const missing = await doctor(empty);
    const check = fixtureCheck(missing);
    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(/not found/);

    const clone = tempDir();
    const suite = join(clone, "benchmarks", "suites", "math");
    mkdirSync(suite, { recursive: true });
    writeFileSync(join(suite, "one.json"), "[]\n");
    const present = await doctor(clone);
    expect(fixtureCheck(present).status).toBe("healthy");
  });
});
