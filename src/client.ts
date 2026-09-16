/**
 * WordPress REST API client.
 * Reads credentials from environment variables:
 *   WP_API_URL      - Base URL of the WordPress site (e.g. https://mysite.com)
 *   WP_API_USERNAME - WordPress username
 *   WP_API_PASSWORD - WordPress application password
 */

import type { ResolvedFile } from "./upload.js";

const USER_AGENT = "mcp-wordpress/1.1";

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

type QueryParams = Record<string, string | number | boolean | undefined>;

interface SendOptions {
  params?: QueryParams;
  body?: string | Uint8Array;
  /** Merged over the defaults, so an upload can replace `Content-Type`. */
  headers?: Record<string, string>;
}

async function send<T>(method: string, path: string, options: SendOptions = {}): Promise<T> {
  const { baseUrl, authHeader } = getConfig();

  let url = `${baseUrl}/wp-json/wp/v2${path}`;
  if (options.params) {
    const qs = Object.entries(options.params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: authHeader,
    "User-Agent": USER_AGENT,
    ...options.headers,
  };

  const response = await fetch(url, {
    method,
    headers,
    // A Uint8Array is a valid body at runtime; the DOM lib types `BufferSource`
    // as ArrayBuffer-backed only, which `Uint8Array<ArrayBufferLike>` is not.
    body: options.body as BodyInit | undefined,
  });

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

  return json as T;
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
  sticky?: boolean;
  date?: string;
  password?: string;
  format?: string;
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
  date?: string;
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

export interface MediaMetadata {
  title?: string;
  alt_text?: string;
  caption?: string;
  description?: string;
  /** Post or page ID to attach the file to. */
  post?: number;
  author?: number;
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
  update: (id: number, data: { title?: string; alt_text?: string; caption?: string; description?: string }) =>
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

export const categories = {
  list: (params?: { page?: number; per_page?: number; search?: string; parent?: number }) =>
    request<Category[]>("GET", "/categories", undefined, params as Record<string, string | number | boolean | undefined>),
  get: (id: number) => request<Category>("GET", `/categories/${id}`),
  create: (data: { name: string; slug?: string; description?: string; parent?: number }) =>
    request<Category>("POST", "/categories", data),
  update: (id: number, data: { name?: string; slug?: string; description?: string; parent?: number }) =>
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
  create: (data: { name: string; slug?: string; description?: string }) =>
    request<Tag>("POST", "/tags", data),
  update: (id: number, data: { name?: string; slug?: string; description?: string }) =>
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

export const comments = {
  list: (params?: { page?: number; per_page?: number; post?: number; status?: string }) =>
    request<Comment[]>("GET", "/comments", undefined, params as Record<string, string | number | boolean | undefined>),
  get: (id: number) => request<Comment>("GET", `/comments/${id}`),
  create: (data: { post: number; content: string; author_name?: string; author_email?: string; parent?: number }) =>
    request<Comment>("POST", "/comments", data),
  update: (id: number, data: { content?: string; status?: string }) =>
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
}

export const settings = {
  get: () => request<SiteSettings>("GET", "/settings"),
  update: (data: Partial<SiteSettings>) => request<SiteSettings>("POST", "/settings", data),
};
