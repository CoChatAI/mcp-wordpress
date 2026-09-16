/**
 * Media smoke test: drives the built server over stdio exactly as a client
 * does — one JSON-RPC message per line — and uploads real files to a real
 * WordPress site.
 *
 *   npm run build
 *   WP_API_URL=http://localhost:8099 WP_API_USERNAME=admin \
 *     WP_API_PASSWORD="xxxx xxxx xxxx" node scripts/smoke-media.mjs
 *
 * It WRITES to the target site (media items and one draft post), so point it
 * at a scratch install, never a live one. The site needs pretty permalinks —
 * `/wp-json/` is not routed without them.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

for (const key of ["WP_API_URL", "WP_API_USERNAME", "WP_API_PASSWORD"]) {
  if (!process.env[key]) {
    console.error(`${key} is required`);
    process.exit(2);
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
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
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 60_000).unref();
  });
}

const callText = async (name, args) => {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) return `RPC ERROR: ${JSON.stringify(res.error)}`;
  return res.result.content.map((c) => c.text).join("\n");
};

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// 1x1 red PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "drive", version: "0" },
});
check("initialize", init.result?.serverInfo?.name === "mcp-wordpress", JSON.stringify(init.result?.serverInfo));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await rpc("tools/list", {});
const names = tools.result.tools.map((t) => t.name);
check("tools/list exposes create_media", names.includes("create_media"), `${names.length} tools`);

// ── base64 upload with full metadata ──────────────────────────────────────
const created = await callText("create_media", {
  data_base64: PNG_B64,
  filename: "red-dot.png",
  title: "Red dot",
  alt_text: "A single red pixel",
  caption: "Caption text",
  description: "Description text",
});
let media;
try {
  const parsed = JSON.parse(created);
  if (parsed && typeof parsed === "object") media = parsed;
  else check("base64 upload", false, created.slice(0, 300));
} catch {
  check("base64 upload", false, created.slice(0, 400));
}
if (media) {
  check("base64 upload returns a media item", Number.isInteger(media.id), `id=${media.id} url=${media.source_url}`);
  check("alt_text applied", media.alt_text === "A single red pixel", JSON.stringify(media.alt_text));
  check("title applied", media.title?.rendered === "Red dot", JSON.stringify(media.title?.rendered));
  check("caption applied", /Caption text/.test(media.caption?.rendered ?? ""), JSON.stringify(media.caption?.rendered));
  check("description applied", /Description text/.test(media.description?.rendered ?? ""), JSON.stringify(media.description?.rendered));
  check("mime detected", media.mime_type === "image/png", media.mime_type);

  const fetched = await fetch(media.source_url);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  check(
    "uploaded file is byte-identical and served",
    fetched.ok && bytes.equals(Buffer.from(PNG_B64, "base64")),
    `${fetched.status}, ${bytes.length} bytes`,
  );
}

// ── attach to a post + use as featured image ──────────────────────────────
const post = JSON.parse(await callText("create_post", { title: "Media test post", status: "draft" }));
const attached = JSON.parse(
  await callText("create_media", { data_base64: PNG_B64, filename: "attached.png", post: post.id }),
);
check("post attachment", attached.post === post.id, `media.post=${attached.post} post.id=${post.id}`);
const updated = JSON.parse(await callText("update_post", { id: post.id, featured_media: attached.id }));
check("usable as featured_media", updated.featured_media === attached.id, `featured_media=${updated.featured_media}`);

// ── remote URL upload ─────────────────────────────────────────────────────
const REMOTE = "https://s.w.org/style/images/about/WordPress-logotype-standard.png";
const remote = await callText("create_media", { source_url: REMOTE, alt_text: "WordPress logo" });
let remoteMedia;
try {
  remoteMedia = JSON.parse(remote);
} catch {
  check("source_url upload", false, remote.slice(0, 400));
}
if (remoteMedia) {
  const direct = Buffer.from(await (await fetch(REMOTE)).arrayBuffer());
  const stored = Buffer.from(await (await fetch(remoteMedia.source_url)).arrayBuffer());
  check(
    "source_url upload matches the origin bytes",
    stored.equals(direct),
    `${remoteMedia.source_url} (${stored.length}/${direct.length} bytes)`,
  );
  check("filename inferred from URL", /WordPress-logotype-standard/.test(remoteMedia.source_url), remoteMedia.source_url);
  check("remote mime detected", remoteMedia.mime_type === "image/png", remoteMedia.mime_type);
}

// ── guards ────────────────────────────────────────────────────────────────
const both = await callText("create_media", { source_url: REMOTE, data_base64: PNG_B64 });
check("rejects both sources", /exactly one of source_url or data_base64/.test(both), both.slice(0, 120));

const neither = await callText("create_media", { title: "nothing" });
check("rejects neither source", /exactly one of source_url or data_base64/.test(neither), neither.slice(0, 120));

const imds = await callText("create_media", { source_url: "http://169.254.169.254/latest/meta-data/" });
check("refuses instance metadata", /private address/.test(imds), imds.slice(0, 160));

const loopback = await callText("create_media", { source_url: "http://localhost:8099/favicon.ico" });
check("refuses loopback", /private address/.test(loopback), loopback.slice(0, 160));

const ftp = await callText("create_media", { source_url: "ftp://example.com/x.png" });
check("refuses non-http scheme", /must be http or https/.test(ftp), ftp.slice(0, 160));

const badB64 = await callText("create_media", { data_base64: "not base64!!", filename: "x.png" });
check("rejects invalid base64", /not valid base64/.test(badB64), badB64.slice(0, 160));

const noType = await callText("create_media", { data_base64: PNG_B64 });
check("asks for a type when none can be inferred", /could not determine the file type/.test(noType), noType.slice(0, 160));

const noExt = JSON.parse(await callText("create_media", { data_base64: PNG_B64, filename: "no-extension", mime_type: "image/png" }));
// WordPress de-duplicates a name it already holds, so a re-run lands on
// "no-extension-2.png" — the point is the ".png" the caller never supplied.
check("adds the extension a bare filename lacks", /no-extension(-\d+)?\.png$/.test(noExt.source_url), noExt.source_url);

const exe = await callText("create_media", { data_base64: PNG_B64, filename: "payload.exe", mime_type: "image/png" });
check("WordPress still gates the file type", /not permitted|Sorry/i.test(exe), exe.slice(0, 200));

child.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
