import { createHash } from "node:crypto";
import { PROMPT_VERSION } from "./types.js";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalHash(canonicalInput: string): string {
  return sha256(`${PROMPT_VERSION}::${canonicalInput}`);
}

export function normalizedHash(normalizedKey: string): string {
  return sha256(`${PROMPT_VERSION}::${normalizedKey}`);
}

export function intentHash(intent: string): string {
  return sha256(`${PROMPT_VERSION}::intent::${intent}`);
}

export function promptFingerprint(taskText: string, ctxRefs: string[] = []): string {
  return sha256(
    [PROMPT_VERSION, taskText.replace(/\s+/g, " ").trim(), ...ctxRefs.map((r) => r.trim())].join("::")
  );
}