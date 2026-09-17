/**
 * WordPress REST API client.
 * Reads credentials from environment variables:
 *   WP_API_URL      - Base URL of the WordPress site (e.g. https://mysite.com)
 *   WP_API_USERNAME - WordPress username
 *   WP_API_PASSWORD - WordPress application password
 */

import type { ResolvedFile } from "./upload.js";

export const USER_AGENT = "mcp-wordpress/1.2";

export class WordPressError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "WordPressError";
  }
}

function getConfig(): { baseUrl: string; authHeader: string } {
  const url = process.env.WP_API_URL;
  const username = process.env.WP_API_USERNAME;
  const password = process.env.WP_API_PASSWORD;

  if (!url) throw new Error("WP_API_URL environment variable is required");
  if (!username) throw new Error("WP_API_USERNAME environment variable is required");
  if (!password) throw new Error("WP_API_PASSWORD environment variable is required");

  const baseUrl = url.replace(/\/$/, ""); // strip trailing slash
  const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  return { baseUrl, authHeader };
}

/** Query values may nest: `{ include: [1, 2] }` and `{ meta: { k: "v" } }`
 *  go out in the bracket syntax PHP parses back into arrays. */
type QueryParams = Record<string, unknown>;

interface SendOptions {
  /** Query pairs sent exactly as written, ahead of `params` — a caller's
   *  inline query string, where a key may repeat (`include[]=1&include[]=2`). */
  rawQuery?: [string, string][];
  params?: QueryParams;
  body?: string | Uint8Array;
  /** Merged over the defaults, so an upload can replace `Content-Type`. */
  headers?: Record<string, string>;
}

interface Exchange<T> {
  status: number;
  headers: Headers;
  body: T;
}

function appendQuery(search: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(search, `${key}[]`, item);
  } else if (value !== null && typeof value === "object") {
    for (const [sub, item] of Object.entries(value)) appendQuery(search, `${key}[${sub}]`, item);
  } else {
    search.append(key, value === null ? "" : String(value));
  }
}

const MAX_REDIRECTS = 5;

/**
 * Whether a URL belongs to the configured site's REST API: same host and port,
 * the same scheme or an upgrade from http to https, and a path under /wp-json.
 * The credentials are sent to such a URL and to nothing else.
 */
function isRestUrl(target: URL, root: URL): boolean {
  const scheme = target.protocol === root.protocol || (root.protocol === "http:" && target.protocol === "https:");
  return (
    scheme &&
    target.hostname === root.hostname &&
    target.port === root.port &&
    target.pathname.startsWith(`${root.pathname}/`)
  );
}

/** One authenticated round trip to a route under `/wp-json`, throwing a
 *  {@link WordPressError} for any non-2xx answer. */
async function exchange<T>(method: string, route: string, options: SendOptions = {}): Promise<Exchange<T>> {
  const { baseUrl, authHeader } = getConfig();

  const root = new URL(`${baseUrl}/wp-json`);
  let url = new URL(`${root.href}${route}`);
  const search = new URLSearchParams(options.rawQuery ?? []);
  for (const [key, value] of Object.entries(options.params ?? {})) appendQuery(search, key, value);
  url.search = search.toString();
  // `parseRoute` refuses dot segments; this catches anything that still
  // resolves outside /wp-json once the URL is normalised.
  if (!isRestUrl(url, root)) {
    throw new Error(`route "${route}" resolves outside the REST API`);
  }

  const headers: Record<string, string> = {
    Authorization: authHeader,
    "User-Agent": USER_AGENT,
    ...options.headers,
  };

  // Redirects are followed by hand. `fetch` would follow them itself and keep
  // the Authorization header on any same-origin hop — to /wp-admin or
  // /wp-login.php as readily as to another REST route.
  let response: Response;
  for (let hops = 0; ; hops++) {
    response = await fetch(url, {
      method,
      headers,
      // A Uint8Array is a valid body at runtime; the DOM lib types `BufferSource`
      // as ArrayBuffer-backed only, which `Uint8Array<ArrayBufferLike>` is not.
      body: options.body as BodyInit | undefined,
      redirect: "manual",
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) break;

    await response.body?.cancel().catch(() => {
      /* the redirect's own body is never read */
    });
    const next = new URL(location, url);
    const shown = `${next.origin}${next.pathname}`;
    if (!isRestUrl(next, root)) {
      throw new Error(
        `${method} ${route} redirected to ${shown}, outside this site's REST API — not followed, so the credentials were not sent there. If the site has moved, set WP_API_URL to its new address.`,
      );
    }
    // 301, 302 and 303 turn a write into a GET and drop its body: following
    // one would report the GET's answer as if the write had happened.
    if (response.status !== 307 && response.status !== 308 && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      throw new Error(
        `${method} ${route} answered ${response.status} with a redirect to ${shown}; following it would resend the request as a GET without its body, so nothing was written. Set WP_API_URL to the address the site redirects to.`,
      );
    }
    if (hops >= MAX_REDIRECTS) {
      throw new Error(`${method} ${route} redirected more than ${MAX_REDIRECTS} times`);
    }
    url = next;
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  if (!response.ok) {
    const msg =
      typeof json === "object" && json !== null && "message" in json
        ? String((json as Record<string, unknown>).message)
        : `HTTP ${response.status}`;
    throw new WordPressError(msg, response.status, json);
  }

  return { status: response.status, headers: response.headers, body: json as T };
}

/** A round trip to a core `wp/v2` route, returning just the decoded body. */
async function send<T>(method: string, path: string, options: SendOptions = {}): Promise<T> {
  return (await exchange<T>(method, `/wp/v2${path}`, options)).body;
}

/** JSON in, JSON out — the shape every endpoint but the media upload uses. */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  params?: QueryParams,
): Promise<T> {
  return send<T>(method, path, {
    params,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Posts ──────────────────────────────────────────────────────────────────

export interface Post {
  id: number;
  date: string;
  status: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  slug: string;
  link: string;
  author: number;
  categories: number[];
  tags: number[];
  featured_media: number;
  comment_status: string;
  sticky: boolean;
}

/** Registered meta, keyed by meta key. WordPress saves only keys registered
 *  with `show_in_rest`; `null` deletes a key. */
export type MetaInput = Record<string, unknown>;

export interface PostInput {
  title?: string;
  content?: string;
  excerpt?: string;
  status?: "publish" | "draft" | "pending" | "private" | "future";
  slug?: string;
  author?: number;
  categories?: number[];
  tags?: number[];
  featured_media?: number;
  comment_status?: "open" | "closed";
  ping_status?: "open" | "closed";
  sticky?: boolean;
  date?: string;
  date_gmt?: string;
  password?: string;
  format?: string;
  template?: string;
  meta?: MetaInput;
}

export interface ListPostsParams {
  page?: number;
  per_page?: number;
  search?: string;
  status?: string;
  author?: number;
  categories?: number;
  tags?: number;
  orderby?: string;
  order?: "asc" | "desc";
}

export const posts = {
  list: (params?: ListPostsParams) => request<Post[]>("GET", "/posts", undefined, params as Record<string, string | number | boolean | undefined>),
  get: (id: number) => request<Post>("GET", `/posts/${id}`),
  create: (data: PostInput) => request<Post>("POST", "/posts", data),
  update: (id: number, data: PostInput) => request<Post>("POST", `/posts/${id}`, data),
  delete: (id: number, force = false) => request<{ deleted: boolean }>("DELETE", `/posts/${id}`, undefined, { force }),
};

// ── Pages ──────────────────────────────────────────────────────────────────

export interface Page {
  id: number;
  date: string;
  status: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  slug: string;
  link: string;
  author: number;
  parent: number;
  menu_order: number;
}

export interface PageInput {
  title?: string;
  content?: string;
  excerpt?: string;
  status?: "publish" | "draft" | "pending" | "private" | "future";
  slug?: string;
  author?: number;
  parent?: number;
  menu_order?: number;
  featured_media?: number;
  comment_status?: "open" | "closed";
  ping_status?: "open" | "closed";
  date?: string;
  date_gmt?: string;
  password?: string;
  template?: string;
  meta?: MetaInput;
}

export const pages = {
  list: (params?: { page?: number; per_page?: number; search?: string; status?: string; parent?: number }) =>
    request<Page[]>("GET", "/pages", undefined, params as Record<string, string | number | boolean | undefined>),
  get: (id: number) => request<Page>("GET", `/pages/${id}`),
  create: (data: PageInput) => request<Page>("POST", "/pages", data),
  update: (id: number, data: PageInput) => request<Page>("POST", `/pages/${id}`, data),
  delete: (id: number, force = false) => request<{ deleted: boolean }>("DELETE", `/pages/${id}`, undefined, { force }),
};

// ── Media ──────────────────────────────────────────────────────────────────

export interface Media {
  id: number;
  date: string;
  title: { rendered: string };
  source_url: string;
  alt_text: string;
  caption: { rendered: string };
  description: { rendered: string };
  media_type: string;
  mime_type: string;
  media_details: Record<string, unknown>;
  link: string;
}

/** The scalar attributes an upload can carry as query parameters. `meta` is
 *  not among them — see {@link MediaInput}. */
export interface MediaMetadata {
  title?: string;
  alt_text?: string;
  caption?: string;
  description?: string;
  /** Post or page ID to attach the file to. */
  post?: number;
  author?: number;
  comment_status?: "open" | "closed";
  ping_status?: "open" | "closed";
  date?: string;
  date_gmt?: string;
  featured_media?: number;
  slug?: string;
  status?: "publish" | "draft" | "pending" | "private" | "future";
  template?: string;
}

export interface MediaInput extends MediaMetadata {
  meta?: MetaInput;
}

export const media = {
  list: (params?: { page?: number; per_page?: number; search?: string; media_type?: string }) =>
    request<Media[]>("GET", "/media", undefined, params as Record<string, string | number | boolean | undefined>),
  get: (id: number) => request<Media>("GET", `/media/${id}`),
  /**
   * Uploads a file to the media library.
   *
   * WordPress takes the bytes as the raw request body, named by
   * `Content-Disposition` and typed by `Content-Type`. Because the body is the
   * file itself, it cannot also carry JSON attributes — title, alt text and the
   * rest travel as query parameters, which `create_item` reads from the request
   * just the same.
   */
  create: (file: ResolvedFile, metadata: MediaMetadata = {}) =>
    send<Media>("POST", "/media", {
      params: metadata as QueryParams,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
      },
      body: file.bytes,
    }),
  update: (id: number, data: MediaInput) =>
    request<Media>("POST", `/media/${id}`, data),
  delete: (id: number, force = false) => request<{ deleted: boolean }>("DELETE", `/media/${id}`, undefined, { force }),
};

// ── Categories ─────────────────────────────────────────────────────────────

export interface Category {
  id: number;
  name: string;
  slug: string;
  description: string;
  parent: number;
  count: number;
  link: string;
}

export interface TermInput {
  name?: string;
  slug?: string;
  description?: string;
  meta?: MetaInput;
}

export interface CategoryInput extends TermInput {
  parent?: number;
}

export const categories = {
  list: (params?: { page?: number; per_page?: number; search?: string; parent?: number }) =>
    request<Category[]>("GET", "/categories", undefined, params as Record<string, string | number | boolean | undefined>),
  get: (id: number) => request<Category>("GET", `/categories/${id}`),
  create: (data: CategoryInput) =>
    request<Category>("POST", "/categories", data),
  update: (id: number, data: CategoryInput) =>
    request<Category>("POST", `/categories/${id}`, data),
  delete: (id: number, force = false) => request<{ deleted: boolean }>("DELETE", `/categories/${id}`, undefined, { force }),
};

// ── Tags ───────────────────────────────────────────────────────────────────

export interface Tag {
  id: number;
  name: string;
  slug: string;
  description: string;
  count: number;
  link: string;
}

export const tags = {
  list: (params?: { page?: number; per_page?: number; search?: string }) =>
    request<Tag[]>("GET", "/tags", undefined, params as Record<string, string | number | boolean | undefined>),
  get: (id: number) => request<Tag>("GET", `/tags/${id}`),
  create: (data: TermInput) =>
    request<Tag>("POST", "/tags", data),
  update: (id: number, data: TermInput) =>
    request<Tag>("POST", `/tags/${id}`, data),
  delete: (id: number, force = false) => request<{ deleted: boolean }>("DELETE", `/tags/${id}`, undefined, { force }),
};

// ── Users ──────────────────────────────────────────────────────────────────

export interface User {
  id: number;
  name: string;
  slug: string;
  email: string;
  url: string;
  description: string;
  link: string;
  roles: string[];
  registered_date: string;
}

export const users = {
  list: (params?: { page?: number; per_page?: number; search?: string; roles?: string }) =>
    request<User[]>("GET", "/users", undefined, params as Record<string, string | number | boolean | undefined>),
  get: (id: number | "me") => request<User>("GET", `/users/${id}`),
  create: (data: { username: string; email: string; password: string; name?: string; roles?: string[] }) =>
    request<User>("POST", "/users", data),
  update: (id: number, data: { name?: string; email?: string; description?: string; url?: string; roles?: string[] }) =>
    request<User>("POST", `/users/${id}`, data),
  delete: (id: number, reassign: number) =>
    request<{ deleted: boolean }>("DELETE", `/users/${id}`, undefined, { force: true, reassign }),
};

// ── Comments ───────────────────────────────────────────────────────────────

export interface Comment {
  id: number;
  post: number;
  parent: number;
  author_name: string;
  author_email: string;
  date: string;
  content: { rendered: string };
  status: string;
  link: string;
}

export interface CommentInput {
  post?: number;
  parent?: number;
  content?: string;
  status?: string;
  author?: number;
  author_name?: string;
  author_email?: string;
  author_url?: string;
  author_ip?: string;
  author_user_agent?: string;
  date?: string;
  date_gmt?: string;
  meta?: MetaInput;
}

export const comments = {
  list: (params?: { page?: number; per_page?: number; post?: number; status?: string }) =>
    request<Comment[]>("GET", "/comments", undefined, params as Record<string, string | number | boolean | undefined>),
  get: (id: number) => request<Comment>("GET", `/comments/${id}`),
  create: (data: CommentInput) =>
    request<Comment>("POST", "/comments", data),
  update: (id: number, data: CommentInput) =>
    request<Comment>("POST", `/comments/${id}`, data),
  delete: (id: number, force = false) => request<{ deleted: boolean }>("DELETE", `/comments/${id}`, undefined, { force }),
};

// ── Site settings ──────────────────────────────────────────────────────────

export interface SiteSettings {
  title: string;
  description: string;
  url: string;
  email: string;
  timezone: string;
  date_format: string;
  time_format: string;
  start_of_week: number;
  language: string;
  use_smilies: boolean;
  default_category: number;
  default_post_format: string;
  posts_per_page: number;
  show_on_front: string;
  page_on_front: number;
  page_for_posts: number;
  default_comment_status: "open" | "closed";
  default_ping_status: "open" | "closed";
  site_logo: number;
  site_icon: number;
}

export const settings = {
  get: () => request<SiteSettings>("GET", "/settings"),
  update: (data: Partial<SiteSettings>) => request<SiteSettings>("POST", "/settings", data),
};

// ── Any REST route ─────────────────────────────────────────────────────────

/**
 * Normalises a caller's route: tolerates a leading `/wp-json` and an inline
 * query string (returned separately), refuses full URLs and dot segments —
 * the site and its credentials are fixed, and so is the API they reach.
 */
export function parseRoute(input: string): { route: string; query: [string, string][] } {
  let value = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
    throw new Error(`path must be a REST route such as /wp/v2/posts, not a URL: "${input}"`);
  }
  if (value.includes("\\")) throw new Error(`path may not contain backslashes: "${input}"`);

  const hash = value.indexOf("#");
  if (hash >= 0) value = value.slice(0, hash);
  let search = "";
  const question = value.indexOf("?");
  if (question >= 0) {
    search = value.slice(question + 1);
    value = value.slice(0, question);
  }

  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/^\/wp-json(?=\/|$)/, "") || "/";

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`path is not validly percent-encoded: "${input}"`);
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`path may not contain "." or ".." segments: "${input}"`);
  }

  // Pairs, not an object: a key may repeat (`include[]=1&include[]=2`), and
  // collapsing it would keep only the last value.
  return { route: value, query: [...new URLSearchParams(search)] };
}

export type RestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export interface RestResponse {
  status: number;
  /** X-WP-Total / X-WP-TotalPages, present on paginated collections. */
  total?: number;
  total_pages?: number;
  body: unknown;
}

export const rest = {
  request: async (
    method: RestMethod,
    path: string,
    options: { query?: QueryParams; body?: unknown } = {},
  ): Promise<RestResponse> => {
    const { route, query: inline } = parseRoute(path);
    const hasBody = options.body !== undefined;
    if (hasBody && (method === "GET" || method === "OPTIONS")) {
      throw new Error(`${method} requests cannot carry a body — pass the values in query instead`);
    }
    // An explicit `query` wins over the same parameter written inline in the
    // path, bracketed forms included: `query.include` replaces `include[]=…`.
    const explicit = options.query ?? {};
    const rawQuery = inline.filter(([key]) => !Object.hasOwn(explicit, key.replace(/\[.*$/, "")));
    const result = await exchange<unknown>(method, route, {
      rawQuery,
      params: explicit,
      headers: hasBody ? { "Content-Type": "application/json" } : {},
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
    const total = result.headers.get("x-wp-total");
    const totalPages = result.headers.get("x-wp-totalpages");
    return {
      status: result.status,
      ...(total !== null ? { total: Number(total) } : {}),
      ...(totalPages !== null ? { total_pages: Number(totalPages) } : {}),
      body: result.body,
    };
  },

  /** The route's OPTIONS answer: its methods, their arguments, its schema. */
  describe: async (path: string): Promise<unknown> => {
    const { route } = parseRoute(path);
    return (await exchange<unknown>("OPTIONS", route)).body;
  },
};
