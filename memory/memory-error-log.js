import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./memory-lookup.js";

export function describeMemoryOutput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: Array.isArray(value) ? "array" : typeof value };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (typeof item === "string") return [key, { type: "string", length: item.length, nonEmpty: Boolean(item.trim()) }];
    if (Array.isArray(item)) return [key, { type: "array", length: item.length, itemTypes: [...new Set(item.map(entry => typeof entry))] }];
    return [key, { type: item === null ? "null" : typeof item }];
  }));
}

export function appendMemoryErrorLog(path, entry, timestamp = new Date().toISOString()) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(redactSecrets({ timestamp, ...entry }))}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
