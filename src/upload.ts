/**
 * Source resolution for media uploads.
 *
 * Turns what a caller can express — a remote URL or a base64 blob — into the
 * three things `POST /wp-json/wp/v2/media` needs: the bytes, a filename WordPress
 * will accept, and a MIME type.
 */

import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

import { USER_AGENT } from "./client.js";

/** Largest file we will hand to WordPress. Sites impose their own (usually
 *  lower) limit via `upload_max_filesize`; this one only keeps a runaway
 *  download from filling the container's 512MB of memory. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Budget for fetching `source_url`, deliberately under the proxy's 60s
 *  request timeout so a slow origin surfaces as a tool error, not a cut
 *  connection. */
export const FETCH_TIMEOUT_MS = 30_000;

const MAX_REDIRECTS = 5;

/** Extension ↔ MIME for the types WordPress accepts by default. Used in both
 *  directions: to name a file the response only described by Content-Type, and
 *  to type a file the caller only named. */
const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-ms-wmv": "wmv",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
};

const EXTENSION_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXTENSION).map(([mime, ext]) => [ext, mime]),
);
// Extensions that share a MIME type with another spelling, so the reverse map
// above cannot carry them.
EXTENSION_TO_MIME.jpeg = "image/jpeg";
EXTENSION_TO_MIME.tif = "image/tiff";
EXTENSION_TO_MIME.htm = "text/html";
EXTENSION_TO_MIME.html = "text/html";

export interface ResolveSourceInput {
  source_url?: string;
  data_base64?: string;
  filename?: string;
  mime_type?: string;
}

export interface ResolvedFile {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/**
 * Addresses the server must never fetch on a caller's behalf: loopback, the
 * RFC1918 ranges, link-local (169.254.169.254 among them), unique-local IPv6
 * and the reserved blocks. `BlockList` canonicalises before it compares, so an
 * IPv4-mapped IPv6 literal in either spelling (`::ffff:127.0.0.1`,
 * `::ffff:7f00:1`) is judged by its embedded IPv4 rules, and each prefix
 * covers its whole range (`fe80::/10` is `fe80` through `febf`).
 */
const PRIVATE_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud instance metadata
  ["172.16.0.0", 12], // RFC1918
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 3], // multicast + reserved
] as const) {
  PRIVATE_ADDRESSES.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fe80::", 10], // link-local
  ["fc00::", 7], // unique local
] as const) {
  PRIVATE_ADDRESSES.addSubnet(address, prefix, "ipv6");
}

function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return PRIVATE_ADDRESSES.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The resolver the fetch agent connects through. It is the SSRF check itself,
 * not a preflight for one: the address it hands back is the address the
 * socket opens to, so a host cannot answer the check with a public address
 * and the connection with a private one (DNS rebinding). TLS still verifies
 * against the hostname — only the resolution is pinned.
 */
function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
): void {
  const { all, ...rest } = options;
  lookup(hostname, { ...rest, all: true }).then(
    (addresses) => {
      const blocked = addresses.find((a) => isPrivateAddress(a.address));
      if (blocked) {
        return callback(
          new Error(
            `source_url resolves to a private address (${blocked.address}); only public hosts can be uploaded from`,
          ),
          "",
        );
      }
      if (all) return callback(null, addresses);
      const [first] = addresses;
      callback(null, first.address, first.family);
    },
    (err: Error) => callback(err, ""),
  );
}

const publicOnlyAgent = new Agent({ connect: { lookup: guardedLookup } });

/**
 * The part of the check a lookup never sees: the scheme, and a host that is
 * already an IP literal — `net.connect` skips resolution for those, so
 * {@link guardedLookup} would never run.
 */
function assertPublicHttpUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`source_url must be http or https, got "${url.protocol}"`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateAddress(host)) {
    throw new Error(
      `source_url points at a private address (${host}); only public hosts can be uploaded from`,
    );
  }
}

/** Reads a response body, giving up as soon as it passes the cap rather than
 *  buffering the whole thing first. */
async function readCapped(response: Response, url: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${url} is ${declared} bytes, above the ${MAX_UPLOAD_BYTES}-byte upload limit`,
    );
  }

  if (!response.body) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_UPLOAD_BYTES) {
        throw new Error(
          `${url} is larger than the ${MAX_UPLOAD_BYTES}-byte upload limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {
      /* already closed or errored — nothing to release */
    });
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Downloads a URL, following redirects by hand so that every hop is checked
 * against {@link assertPublicHttpUrl} — a public URL is free to redirect to a
 * private one.
 */
async function fetchRemote(
  rawUrl: string,
): Promise<{ bytes: Uint8Array; contentType: string | null; disposition: string | null; finalUrl: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`source_url is not a valid URL: "${rawUrl}"`);
  }

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicHttpUrl(url);

    let response: Response;
    try {
      response = (await undiciFetch(url, {
        dispatcher: publicOnlyAgent,
        redirect: "manual",
        signal,
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      })) as unknown as Response;
    } catch (e) {
      // undici reports every failure as "fetch failed" and keeps the reason —
      // the guarded lookup's refusal included — in `cause`.
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`fetching ${url.href} failed: ${reason}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`${url.href} returned ${response.status} without a Location header`);
      }
      await response.body?.cancel().catch(() => {
        /* body is irrelevant on a redirect */
      });
      url = new URL(location, url);
      continue;
    }

    if (!response.ok) {
      throw new Error(`fetching ${url.href} failed: HTTP ${response.status}`);
    }

    return {
      bytes: await readCapped(response, url.href),
      contentType: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"),
      finalUrl: url.href,
    };
  }

  throw new Error(`source_url redirected more than ${MAX_REDIRECTS} times`);
}

/** `data:image/png;charset=utf-8;base64,` → `{ mime: "image/png", payload }`
 *  (any case; parameters between the type and `;base64` are allowed). A
 *  string that is not a data URI comes back as the payload unchanged. */
function splitDataUri(input: string): { mime?: string; payload: string } {
  const match = /^data:([^,]*),/i.exec(input);
  if (!match) return { payload: input };
  const [type, ...params] = match[1].split(";");
  if (!params.some((p) => p.trim().toLowerCase() === "base64")) {
    throw new Error("data_base64 is a data: URI without the ;base64 marker");
  }
  return { mime: type.trim().toLowerCase() || undefined, payload: input.slice(match[0].length) };
}

function decodeBase64(input: string): Uint8Array {
  // Accept a data: URI as well as bare base64 — callers paste both.
  const data = splitDataUri(input).payload.replace(/\s+/g, "");
  if (!data) throw new Error("data_base64 is empty");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
    throw new Error("data_base64 is not valid base64");
  }

  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `data_base64 decodes to ${bytes.length} bytes, above the ${MAX_UPLOAD_BYTES}-byte upload limit`,
    );
  }
  return bytes;
}

/** `image/png; charset=binary` → `image/png`. */
function normalizeMime(value: string | null | undefined): string | undefined {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  return mime || undefined;
}

function extensionOf(filename: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1];
  return ext?.toLowerCase();
}

function filenameFromDisposition(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const encoded = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/.exec(disposition)?.[1];
  return plain?.trim();
}

function filenameFromUrl(rawUrl: string): string | undefined {
  try {
    const base = decodeURIComponent(new URL(rawUrl).pathname.split("/").pop() ?? "");
    return base || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Makes a filename safe to put in a `Content-Disposition` header: WordPress
 * parses that header by splitting on `;` and unquoting, and Node refuses to
 * send a header value outside latin-1, so anything exotic is replaced here
 * rather than turning into a confusing 400 from the far end.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const safe = base
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, "_") // non-ASCII and control characters
    .replace(/["'`;\\]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return safe.replace(/^\.+/, "") || "upload";
}

/**
 * Resolves the caller's arguments into bytes + filename + MIME type,
 * cross-filling the name from the type and the type from the name so that
 * WordPress's extension check has something to work with.
 */
export async function resolveSource(input: ResolveSourceInput): Promise<ResolvedFile> {
  const hasUrl = typeof input.source_url === "string" && input.source_url.trim() !== "";
  const hasData = typeof input.data_base64 === "string" && input.data_base64.trim() !== "";

  if (hasUrl === hasData) {
    throw new Error("provide exactly one of source_url or data_base64");
  }

  let bytes: Uint8Array;
  let mime = normalizeMime(input.mime_type);
  let filename = input.filename?.trim() || undefined;

  if (hasUrl) {
    const source = input.source_url!.trim();
    const remote = await fetchRemote(source);
    bytes = remote.bytes;
    // An explicit argument wins; `application/octet-stream` is what a server
    // says when it does not know, so it loses to anything the name implies.
    const served = normalizeMime(remote.contentType);
    if (!mime && served && served !== "application/octet-stream") mime = served;
    filename ??= filenameFromDisposition(remote.disposition) ?? filenameFromUrl(remote.finalUrl);
    if (!mime) mime = served;
  } else {
    const source = input.data_base64!;
    bytes = decodeBase64(source);
    mime ??= splitDataUri(source).mime;
  }

  if (bytes.length === 0) throw new Error("the file is empty — nothing to upload");

  const namedExtension = filename ? extensionOf(filename) : undefined;
  if (!mime && namedExtension) mime = EXTENSION_TO_MIME[namedExtension];
  if (!mime || mime === "application/octet-stream") {
    throw new Error(
      "could not determine the file type — pass mime_type (e.g. \"image/png\"), or a filename with a matching extension",
    );
  }

  const mimeExtension = MIME_TO_EXTENSION[mime];
  if (!filename) {
    if (!mimeExtension) {
      throw new Error(`pass a filename — ${mime} has no extension this server knows`);
    }
    filename = `upload-${Date.now()}.${mimeExtension}`;
  } else if (!namedExtension && mimeExtension) {
    // WordPress rejects an upload whose filename carries no accepted
    // extension, whatever the Content-Type says.
    filename = `${filename}.${mimeExtension}`;
  }

  return { bytes, filename: sanitizeFilename(filename), mimeType: mime };
}
