/**
 * Shared driver for the smoke tests: starts the built server and speaks to it
 * over stdio exactly as a client does — one JSON-RPC message per line.
 *
 * The smoke tests WRITE to the site in WP_API_URL, so point them at a scratch
 * install, never a live one. The site needs pretty permalinks — `/wp-json/`
 * is not routed without them.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Imports a module from the build, e.g. `await importDist("upload.js")`. */
export const importDist = (file) => import(pathToFileURL(join(repoRoot, "dist", file)).href);

export async function startServer() {
  for (const key of ["WP_API_URL", "WP_API_USERNAME", "WP_API_PASSWORD"]) {
    if (!process.env[key]) {
      console.error(`${key} is required`);
      process.exit(2);
    }
  }

  const child = spawn("node", [join(repoRoot, "dist/index.js")], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  let nextId = 1;
  const rpc = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout on ${method}`)), 60_000).unref();
    });
  };

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  /** A tool call's text blocks, in order. */
  const callParts = async (name, args) => {
    const res = await rpc("tools/call", { name, arguments: args });
    if (res.error) return [`RPC ERROR: ${JSON.stringify(res.error)}`];
    return res.result.content.map((c) => c.text);
  };
  /** A tool call's text blocks joined, for matching errors. */
  const callText = async (name, args) => (await callParts(name, args)).join("\n");
  /** A tool call's first text block parsed as JSON; throws with the text on
   *  anything else, so a failing call shows what came back. */
  const callJson = async (name, args) => {
    const [first] = await callParts(name, args);
    try {
      return JSON.parse(first);
    } catch {
      throw new Error(`${name} did not return JSON: ${first.slice(0, 400)}`);
    }
  };

  return { init, rpc, callParts, callText, callJson, stop: () => child.kill() };
}

export function createChecks() {
  const results = [];
  const check = (label, pass, detail = "") => {
    results.push({ label, pass });
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };
  /** Runs a block, turning a throw into a failed check rather than an abort. */
  const attempt = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      check(label, false, e instanceof Error ? e.message : String(e));
    }
  };
  const finish = () => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    return failed.length ? 1 : 0;
  };
  return { check, attempt, finish };
}
