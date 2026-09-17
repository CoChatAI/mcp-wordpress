import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import * as wp from "./client.js";
import { resolveSource } from "./upload.js";

type ToolResult = { content: { type: "text"; text: string }[] };

function text(content: string): ToolResult {
  return { content: [{ type: "text", text: content }] };
}

function ok(data: unknown): ToolResult {
  return text(JSON.stringify(data, null, 2));
}

function err(e: unknown): ToolResult {
  if (e instanceof wp.WordPressError) {
    return text(`Error ${e.status}: ${e.message}\n${JSON.stringify(e.body, null, 2)}`);
  }
  return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
}

// ── Structured arguments ───────────────────────────────────────────────────

/**
 * Reads an argument that holds a JSON object. The schemas declare these as
 * strings, because that is the one shape every model provider fills in
 * faithfully: Gemini's function calling cannot express a free-form object and
 * sends `{}` for one, dropping every key. Clients that pass a real object are
 * accepted too.
 */
function jsonObjectArg(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${name} must be a JSON object such as {"key": "value"} — it could not be parsed`);
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object such as {"key": "value"}`);
  }
  return parsed as Record<string, unknown>;
}

/** Like {@link jsonObjectArg}, but any JSON value — a request body can be an
 *  array or a scalar. */
function jsonArg(value: unknown, name: string): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON — it could not be parsed`);
  }
}

/** A write's arguments with `id` removed and `meta` decoded, ready to send. */
function writeData(args: Record<string, unknown>): { data: Record<string, unknown>; meta?: Record<string, unknown> } {
  const { id: _id, meta: rawMeta, ...data } = args;
  const meta = jsonObjectArg(rawMeta, "meta");
  return meta ? { data: { ...data, meta }, meta } : { data };
}

/**
 * Serialises a write's result, and says so when WordPress dropped meta.
 * WordPress saves only meta keys registered with `show_in_rest` and skips any
 * other key without an error, so the caller would otherwise believe a value
 * was stored. The response's `meta` holds exactly the registered keys.
 */
function writeResult(result: unknown, meta?: Record<string, unknown>): ToolResult {
  const response = ok(result);
  if (!meta || typeof result !== "object" || result === null) return response;
  // No `meta` in the response at all (trimmed by _fields or a plugin) says
  // nothing about what was stored — only an answer that includes it does.
  if (!Object.hasOwn(result, "meta")) return response;

  const stored = (result as Record<string, unknown>).meta;
  // PHP encodes an empty map as [], which is also "nothing registered".
  const registered = stored !== null && typeof stored === "object" ? stored : {};
  const ignored = Object.keys(meta).filter((key) => !Object.hasOwn(registered, key));
  if (ignored.length > 0) {
    response.content.push({
      type: "text",
      text:
        `WordPress ignored these meta keys, so nothing was saved for them: ${ignored.join(", ")}. ` +
        "Only keys registered for the REST API on this site are stored — get_endpoint_schema lists them under meta_keys.",
    });
  }
  return response;
}

// ── Shared schema pieces ───────────────────────────────────────────────────

// Repeated on every create/update tool, so it stays short: the full story is
// in the README and in what get_endpoint_schema returns.
const META = {
  type: "string",
  description:
    'Custom fields as a JSON object string, e.g. {"_yoast_wpseo_focuskw": "keyword", "_yoast_wpseo_metadesc": "text"}; null deletes a key. Keys the site does not register are ignored and named in the result.',
} as const;

const OPEN_CLOSED = { type: "string", enum: ["open", "closed"] } as const;
const POST_STATUS = {
  type: "string",
  enum: ["publish", "future", "draft", "pending", "private"],
  description: "Publication status (default for new items: draft)",
} as const;

/** Fields shared by posts, pages and media — WordPress's post-type controller. */
const POST_LIKE_FIELDS = {
  slug: { type: "string", description: "URL slug" },
  status: POST_STATUS,
  author: { type: "number", description: "Author user ID" },
  featured_media: { type: "number", description: "Featured image media ID" },
  comment_status: { ...OPEN_CLOSED, description: "Whether comments are open" },
  ping_status: { ...OPEN_CLOSED, description: "Whether pingbacks and trackbacks are accepted" },
  date: { type: "string", description: "Publication date in the site's timezone (ISO 8601)" },
  date_gmt: { type: "string", description: "Publication date in GMT (ISO 8601)" },
  template: { type: "string", description: "Theme template file to render with, e.g. 'elementor_header_footer'" },
  meta: META,
} as const;

const POST_FIELDS = {
  title: { type: "string", description: "Title" },
  content: { type: "string", description: "Content (HTML or block markup)" },
  excerpt: { type: "string", description: "Excerpt" },
  ...POST_LIKE_FIELDS,
  password: { type: "string", description: "Password that protects the content" },
  categories: { type: "array", items: { type: "number" }, description: "Category IDs" },
  tags: { type: "array", items: { type: "number" }, description: "Tag IDs" },
  sticky: { type: "boolean", description: "Stick the post to the front page" },
  format: {
    type: "string",
    enum: ["standard", "aside", "chat", "gallery", "link", "image", "quote", "status", "video", "audio"],
    description: "Post format",
  },
} as const;

const PAGE_FIELDS = {
  title: { type: "string", description: "Title" },
  content: { type: "string", description: "Content (HTML or block markup)" },
  excerpt: { type: "string", description: "Excerpt" },
  ...POST_LIKE_FIELDS,
  password: { type: "string", description: "Password that protects the content" },
  parent: { type: "number", description: "Parent page ID" },
  menu_order: { type: "number", description: "Order among sibling pages" },
} as const;

const MEDIA_FIELDS = {
  title: { type: "string", description: "Media title (defaults to the filename)" },
  alt_text: { type: "string", description: "Alternative text for accessibility" },
  caption: { type: "string", description: "Media caption" },
  description: { type: "string", description: "Media description" },
  post: { type: "number", description: "Post or page ID to attach the file to" },
  ...POST_LIKE_FIELDS,
} as const;

const TERM_FIELDS = {
  name: { type: "string", description: "Name" },
  slug: { type: "string", description: "URL slug" },
  description: { type: "string", description: "Description (HTML allowed)" },
  meta: META,
} as const;

const COMMENT_FIELDS = {
  post: { type: "number", description: "Post ID the comment belongs to" },
  parent: { type: "number", description: "Parent comment ID, for replies" },
  content: { type: "string", description: "Comment content" },
  status: { type: "string", description: "approved, hold, spam or trash" },
  author: { type: "number", description: "User ID of the author, if a registered user" },
  author_name: {
    type: "string",
    description: "Author display name. Omit all author fields to post as the connected user; otherwise give author_name and author_email together.",
  },
  author_email: { type: "string", description: "Email address of the author" },
  author_url: { type: "string", description: "URL of the author" },
  author_ip: { type: "string", description: "IP address of the author" },
  author_user_agent: { type: "string", description: "User agent of the author" },
  date: { type: "string", description: "Comment date in the site's timezone (ISO 8601)" },
  date_gmt: { type: "string", description: "Comment date in GMT (ISO 8601)" },
  meta: META,
} as const;

const ID = (what: string) => ({ id: { type: "number", description: `${what} ID` } }) as const;

const MORE_FIELDS = " Other fields: wordpress_request.";

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  // Posts
  {
    name: "list_posts",
    description: "List WordPress posts with optional filtering",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number (default: 1)" },
        per_page: { type: "number", description: "Posts per page, max 100 (default: 10)" },
        search: { type: "string", description: "Search term" },
        status: { type: "string", description: "Post status: publish, draft, pending, private, future, any (default: publish)" },
        author: { type: "number", description: "Filter by author ID" },
        categories: { type: "number", description: "Filter by category ID" },
        tags: { type: "number", description: "Filter by tag ID" },
        orderby: { type: "string", description: "Sort by: date, id, title, relevance, slug (default: date)" },
        order: { type: "string", enum: ["asc", "desc"], description: "Sort order (default: desc)" },
      },
    },
  },
  {
    name: "get_post",
    description: "Get a single WordPress post by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Post ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_post",
    description: "Create a WordPress post; custom fields such as Yoast SEO values go in meta." + MORE_FIELDS,
    inputSchema: { type: "object", properties: POST_FIELDS, required: ["title"] },
  },
  {
    name: "update_post",
    description: "Update a WordPress post; only the fields you pass change. Custom fields such as Yoast SEO values go in meta." + MORE_FIELDS,
    inputSchema: { type: "object", properties: { ...ID("Post"), ...POST_FIELDS }, required: ["id"] },
  },
  {
    name: "delete_post",
    description: "Delete a WordPress post (moves to trash by default)",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Post ID" },
        force: { type: "boolean", description: "Permanently delete instead of trashing (default: false)" },
      },
      required: ["id"],
    },
  },

  // Pages
  {
    name: "list_pages",
    description: "List WordPress pages",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        per_page: { type: "number" },
        search: { type: "string" },
        status: { type: "string" },
        parent: { type: "number", description: "Filter by parent page ID" },
      },
    },
  },
  {
    name: "get_page",
    description: "Get a single WordPress page by ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "create_page",
    description: "Create a WordPress page; custom fields go in meta." + MORE_FIELDS,
    inputSchema: { type: "object", properties: PAGE_FIELDS, required: ["title"] },
  },
  {
    name: "update_page",
    description: "Update a WordPress page; only the fields you pass change. Custom fields go in meta." + MORE_FIELDS,
    inputSchema: { type: "object", properties: { ...ID("Page"), ...PAGE_FIELDS }, required: ["id"] },
  },
  {
    name: "delete_page",
    description: "Delete a WordPress page",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        force: { type: "boolean" },
      },
      required: ["id"],
    },
  },

  // Media
  {
    name: "list_media",
    description: "List WordPress media library items",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        per_page: { type: "number" },
        search: { type: "string" },
        media_type: { type: "string", description: "Filter by type: image, video, audio, application" },
      },
    },
  },
  {
    name: "get_media",
    description: "Get a single media item by ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "create_media",
    description:
      "Upload a file to the WordPress media library. Give it either source_url (the file is downloaded from a public http/https URL) or data_base64 (the file's bytes, base64-encoded) — exactly one of the two. Returns the created media item; use its id as featured_media on create_post/update_post, or its source_url to embed the file in post content.",
    inputSchema: {
      type: "object",
      properties: {
        source_url: {
          type: "string",
          description: "Public http(s) URL to download the file from. Private, loopback and link-local addresses are refused.",
        },
        data_base64: {
          type: "string",
          description: "File contents as base64 (a data: URI is also accepted). Use for files you already hold as bytes.",
        },
        filename: {
          type: "string",
          description: "Filename to store, e.g. 'chart.png'. Required with data_base64 unless mime_type is given; inferred from the URL otherwise. WordPress rejects files whose extension it does not allow.",
        },
        mime_type: {
          type: "string",
          description: "MIME type, e.g. 'image/png'. Inferred from the response or the filename extension when omitted.",
        },
        ...MEDIA_FIELDS,
      },
    },
  },
  {
    name: "update_media",
    description: "Update a media item; only the fields you pass change. Custom fields go in meta." + MORE_FIELDS,
    inputSchema: { type: "object", properties: { ...ID("Media"), ...MEDIA_FIELDS }, required: ["id"] },
  },
  {
    name: "delete_media",
    description: "Delete a media item (force=true required for permanent deletion)",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        force: { type: "boolean", description: "Must be true to permanently delete media" },
      },
      required: ["id", "force"],
    },
  },

  // Categories
  {
    name: "list_categories",
    description: "List WordPress categories",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        per_page: { type: "number" },
        search: { type: "string" },
        parent: { type: "number" },
      },
    },
  },
  {
    name: "create_category",
    description: "Create a WordPress category; term meta goes in meta." + MORE_FIELDS,
    inputSchema: {
      type: "object",
      properties: { ...TERM_FIELDS, parent: { type: "number", description: "Parent category ID" } },
      required: ["name"],
    },
  },
  {
    name: "update_category",
    description: "Update a WordPress category; only the fields you pass change." + MORE_FIELDS,
    inputSchema: {
      type: "object",
      properties: { ...ID("Category"), ...TERM_FIELDS, parent: { type: "number", description: "Parent category ID" } },
      required: ["id"],
    },
  },
  {
    name: "delete_category",
    description: "Delete a WordPress category",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        force: { type: "boolean" },
      },
      required: ["id"],
    },
  },

  // Tags
  {
    name: "list_tags",
    description: "List WordPress tags",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        per_page: { type: "number" },
        search: { type: "string" },
      },
    },
  },
  {
    name: "create_tag",
    description: "Create a WordPress tag; term meta goes in meta." + MORE_FIELDS,
    inputSchema: { type: "object", properties: TERM_FIELDS, required: ["name"] },
  },
  {
    name: "update_tag",
    description: "Update a WordPress tag; only the fields you pass change." + MORE_FIELDS,
    inputSchema: { type: "object", properties: { ...ID("Tag"), ...TERM_FIELDS }, required: ["id"] },
  },
  {
    name: "delete_tag",
    description: "Delete a WordPress tag",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        force: { type: "boolean" },
      },
      required: ["id"],
    },
  },

  // Comments
  {
    name: "list_comments",
    description: "List WordPress comments",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        per_page: { type: "number" },
        post: { type: "number", description: "Filter by post ID" },
        status: { type: "string", description: "approved, hold, spam, trash (default: approved)" },
      },
    },
  },
  {
    name: "create_comment",
    description: "Create a comment on a post; comment meta goes in meta." + MORE_FIELDS,
    inputSchema: { type: "object", properties: COMMENT_FIELDS, required: ["post", "content"] },
  },
  {
    name: "update_comment",
    description: "Update a comment; only the fields you pass change." + MORE_FIELDS,
    inputSchema: { type: "object", properties: { ...ID("Comment"), ...COMMENT_FIELDS }, required: ["id"] },
  },
  {
    name: "delete_comment",
    description: "Delete a comment",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        force: { type: "boolean" },
      },
      required: ["id"],
    },
  },

  // Users
  {
    name: "list_users",
    description: "List WordPress users",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        per_page: { type: "number" },
        search: { type: "string" },
        roles: { type: "string", description: "Filter by role: administrator, editor, author, contributor, subscriber" },
      },
    },
  },
  {
    name: "get_current_user",
    description: "Get the currently authenticated WordPress user",
    inputSchema: { type: "object", properties: {} },
  },

  // Settings
  {
    name: "get_site_settings",
    description: "Get WordPress site settings (title, description, timezone, etc.)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_site_settings",
    description: "Update WordPress site settings. Only the settings you pass change.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Site title" },
        description: { type: "string", description: "Site tagline" },
        url: { type: "string", description: "Site URL — changing it moves the site; the old address stops working" },
        email: { type: "string", description: "Administration email address" },
        timezone: { type: "string", description: "Timezone string (e.g. America/New_York)" },
        date_format: { type: "string", description: "Date format, e.g. 'F j, Y'" },
        time_format: { type: "string", description: "Time format, e.g. 'g:i a'" },
        start_of_week: { type: "number", description: "Day the week starts on (0 = Sunday)" },
        language: { type: "string", description: "WordPress locale code, e.g. en_US" },
        use_smilies: { type: "boolean", description: "Convert emoticons to graphics on display" },
        default_category: { type: "number", description: "Default post category ID" },
        default_post_format: { type: "string", description: "Default post format" },
        posts_per_page: { type: "number", description: "Blog pages show at most this many posts" },
        show_on_front: { type: "string", enum: ["posts", "page"], description: "What the front page shows" },
        page_on_front: { type: "number", description: "Page ID shown on the front page (with show_on_front=page)" },
        page_for_posts: { type: "number", description: "Page ID that lists the latest posts" },
        default_comment_status: { ...OPEN_CLOSED, description: "Allow comments on new posts" },
        default_ping_status: { ...OPEN_CLOSED, description: "Allow pingbacks and trackbacks on new posts" },
        site_logo: { type: "number", description: "Media ID of the site logo" },
        site_icon: { type: "number", description: "Media ID of the site icon" },
      },
    },
  },

  // Any route
  {
    name: "wordpress_request",
    description:
      "Call any WordPress REST API route on this site directly — for anything the other tools do not cover: custom post types (/wp/v2/<type>), " +
      "users, plugin routes such as Yoast (/yoast/v1/...), WooCommerce (/wc/v3/...) or ACF, menus, blocks, templates. " +
      "The path is relative to /wp-json. Use get_endpoint_schema first to see a route's methods and arguments. " +
      "Returns {status, total, total_pages, body}; total and total_pages appear on paginated lists.",
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
          description: "HTTP method. WordPress treats POST, PUT and PATCH alike for updates.",
        },
        path: {
          type: "string",
          description: "Route under /wp-json, e.g. '/wp/v2/posts/123', '/wp/v2/users/me', '/yoast/v1/get_head?url=...'. A query string here is merged with query.",
        },
        query: {
          type: "string",
          description:
            'Query parameters as a JSON object string, e.g. {"per_page": 20, "status": "draft", "_fields": "id,title,link"}. ' +
            "_fields trims large responses to the fields you need.",
        },
        body: {
          type: "string",
          description: 'Request body as a JSON string, e.g. {"title": "New title", "meta": {"key": "value"}}. Not allowed with GET or OPTIONS.',
        },
      },
      required: ["method", "path"],
    },
  },
  {
    name: "get_endpoint_schema",
    description:
      "Describe a WordPress REST route on this site: the methods it supports, the arguments each accepts, and the custom-field (meta) keys it can store. " +
      "Use it before wordpress_request, or to find which meta keys (e.g. Yoast's _yoast_wpseo_*) a site accepts. " +
      "A listed meta key can still refuse a write when the site gives no permission for it — the write then fails with rest_cannot_update.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Route under /wp-json, e.g. '/wp/v2/posts', '/wp/v2/pages', '/' for every namespace and route" },
      },
      required: ["path"],
    },
  },
];

// ── get_endpoint_schema ────────────────────────────────────────────────────

function describeArgument(spec: Record<string, unknown>): string {
  const type = Array.isArray(spec.type) ? spec.type.join("|") : String(spec.type ?? "any");
  const parts = [type];
  if (Array.isArray(spec.enum)) parts.push(`one of ${spec.enum.join(", ")}`);
  if (spec.required === true) parts.push("required");
  if (spec.default !== undefined && spec.default !== null && spec.default !== "") {
    parts.push(`default ${JSON.stringify(spec.default)}`);
  }
  const description = typeof spec.description === "string" ? ` — ${spec.description.slice(0, 140)}` : "";
  return parts.join(", ") + description;
}

/**
 * Whether an OPTIONS answer belongs to an index — the API root or a namespace
 * such as /wp/v2. An index's OPTIONS answer describes only itself; the routes
 * it lists come back from a GET.
 */
function isIndexRoute(route: string, options: unknown): boolean {
  if (route === "/") return true;
  const endpoints = (options as Record<string, unknown> | null)?.endpoints;
  return (
    Array.isArray(endpoints) &&
    endpoints.some((endpoint) => Object.hasOwn((endpoint as Record<string, unknown>).args ?? {}, "namespace"))
  );
}

/** The OPTIONS answer boiled down to what a caller needs: the raw one carries
 *  full JSON schemas and link maps, tens of kilobytes for /wp/v2/posts. */
function summarizeEndpoint(path: string, options: unknown) {
  const answer = (options ?? {}) as Record<string, unknown>;

  // The API index ("/") lists routes, not arguments.
  if (answer.routes && typeof answer.routes === "object") {
    return {
      path,
      ...(answer.namespaces ? { namespaces: answer.namespaces } : { namespace: answer.namespace }),
      routes: Object.fromEntries(
        Object.entries(answer.routes as Record<string, Record<string, unknown>>).map(([route, info]) => [
          route,
          Array.isArray(info.methods) ? info.methods.join(", ") : "",
        ]),
      ),
    };
  }

  const methods: Record<string, Record<string, string>> = {};
  for (const endpoint of (Array.isArray(answer.endpoints) ? answer.endpoints : []) as Record<string, unknown>[]) {
    const args = Object.fromEntries(
      Object.entries((endpoint.args ?? {}) as Record<string, Record<string, unknown>>).map(([name, spec]) => [
        name,
        describeArgument(spec),
      ]),
    );
    for (const method of (Array.isArray(endpoint.methods) ? endpoint.methods : []) as string[]) {
      methods[method] = { ...methods[method], ...args };
    }
  }

  const properties = ((answer.schema as Record<string, unknown> | undefined)?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const metaProperties = (properties.meta?.properties ?? {}) as Record<string, Record<string, unknown>>;

  return {
    path,
    namespace: answer.namespace,
    methods,
    meta_keys: Object.fromEntries(
      Object.entries(metaProperties).map(([key, spec]) => [
        key,
        Array.isArray(spec.type) ? spec.type.join("|") : String(spec.type ?? "any"),
      ]),
    ),
    response_fields: Object.keys(properties),
  };
}

// ── Server ─────────────────────────────────────────────────────────────────

export function createServer(): Server {
  const server = new Server(
    { name: "mcp-wordpress", version: "1.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const { name, arguments: args = {} } = request.params;
    const a = args as Record<string, unknown>;

    try {
      switch (name) {
        // ── Posts ──
        case "list_posts":
          return ok(await wp.posts.list(a as wp.ListPostsParams));
        case "get_post":
          return ok(await wp.posts.get(Number(a.id)));
        case "create_post": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.posts.create(data as wp.PostInput), meta);
        }
        case "update_post": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.posts.update(Number(a.id), data as wp.PostInput), meta);
        }
        case "delete_post":
          return ok(await wp.posts.delete(Number(a.id), Boolean(a.force)));

        // ── Pages ──
        case "list_pages":
          return ok(await wp.pages.list(a as Parameters<typeof wp.pages.list>[0]));
        case "get_page":
          return ok(await wp.pages.get(Number(a.id)));
        case "create_page": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.pages.create(data as wp.PageInput), meta);
        }
        case "update_page": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.pages.update(Number(a.id), data as wp.PageInput), meta);
        }
        case "delete_page":
          return ok(await wp.pages.delete(Number(a.id), Boolean(a.force)));

        // ── Media ──
        case "list_media":
          return ok(await wp.media.list(a as Parameters<typeof wp.media.list>[0]));
        case "get_media":
          return ok(await wp.media.get(Number(a.id)));
        case "create_media": {
          // Decode meta before the upload, so a malformed value fails the call
          // instead of leaving an orphaned file behind.
          const meta = jsonObjectArg(a.meta, "meta");
          const file = await resolveSource({
            source_url: a.source_url as string | undefined,
            data_base64: a.data_base64 as string | undefined,
            filename: a.filename as string | undefined,
            mime_type: a.mime_type as string | undefined,
          });
          // Named one by one rather than spread: everything here becomes a
          // query parameter, and an unadvertised key would reach WordPress as
          // an invalid one.
          const num = (value: unknown) => (value === undefined ? undefined : Number(value));
          const str = (value: unknown) => value as string | undefined;
          const metadata: wp.MediaMetadata = {
            title: str(a.title),
            alt_text: str(a.alt_text),
            caption: str(a.caption),
            description: str(a.description),
            post: num(a.post),
            author: num(a.author),
            comment_status: str(a.comment_status) as wp.MediaMetadata["comment_status"],
            ping_status: str(a.ping_status) as wp.MediaMetadata["ping_status"],
            date: str(a.date),
            date_gmt: str(a.date_gmt),
            featured_media: num(a.featured_media),
            slug: str(a.slug),
            status: str(a.status) as wp.MediaMetadata["status"],
            template: str(a.template),
          };
          const created = await wp.media.create(file, metadata);
          // The upload's body is the file, so meta — an object — cannot ride
          // along as a query parameter; it goes in a second, JSON request.
          if (!meta) return ok(created);
          try {
            return writeResult(await wp.media.update(created.id, { meta }), meta);
          } catch (e) {
            // The file is in the library by now. Reporting only the error would
            // hide its id, and the caller's natural retry uploads it twice.
            const response = ok(created);
            response.content.push({
              type: "text",
              text: `The file was uploaded (media id ${created.id}), but setting its meta failed — retry with update_media on that id, not another upload. ${err(e).content[0].text}`,
            });
            return response;
          }
        }
        case "update_media": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.media.update(Number(a.id), data as wp.MediaInput), meta);
        }
        case "delete_media":
          return ok(await wp.media.delete(Number(a.id), Boolean(a.force)));

        // ── Categories ──
        case "list_categories":
          return ok(await wp.categories.list(a as Parameters<typeof wp.categories.list>[0]));
        case "create_category": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.categories.create(data as wp.CategoryInput), meta);
        }
        case "update_category": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.categories.update(Number(a.id), data as wp.CategoryInput), meta);
        }
        case "delete_category":
          return ok(await wp.categories.delete(Number(a.id), Boolean(a.force)));

        // ── Tags ──
        case "list_tags":
          return ok(await wp.tags.list(a as Parameters<typeof wp.tags.list>[0]));
        case "create_tag": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.tags.create(data as wp.TermInput), meta);
        }
        case "update_tag": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.tags.update(Number(a.id), data as wp.TermInput), meta);
        }
        case "delete_tag":
          return ok(await wp.tags.delete(Number(a.id), Boolean(a.force)));

        // ── Comments ──
        case "list_comments":
          return ok(await wp.comments.list(a as Parameters<typeof wp.comments.list>[0]));
        case "create_comment": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.comments.create(data as wp.CommentInput), meta);
        }
        case "update_comment": {
          const { data, meta } = writeData(a);
          return writeResult(await wp.comments.update(Number(a.id), data as wp.CommentInput), meta);
        }
        case "delete_comment":
          return ok(await wp.comments.delete(Number(a.id), Boolean(a.force)));

        // ── Users ──
        case "list_users":
          return ok(await wp.users.list(a as Parameters<typeof wp.users.list>[0]));
        case "get_current_user":
          return ok(await wp.users.get("me"));

        // ── Settings ──
        case "get_site_settings":
          return ok(await wp.settings.get());
        case "update_site_settings":
          return ok(await wp.settings.update(a as Partial<wp.SiteSettings>));

        // ── Any route ──
        case "wordpress_request": {
          const method = String(a.method ?? "").toUpperCase();
          if (!["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) {
            throw new Error("method must be one of GET, POST, PUT, PATCH, DELETE, OPTIONS");
          }
          if (typeof a.path !== "string" || a.path.trim() === "") {
            throw new Error("path is required, e.g. /wp/v2/posts");
          }
          return ok(
            await wp.rest.request(method as wp.RestMethod, a.path, {
              query: jsonObjectArg(a.query, "query"),
              body: jsonArg(a.body, "body"),
            }),
          );
        }
        case "get_endpoint_schema": {
          if (typeof a.path !== "string" || a.path.trim() === "") {
            throw new Error("path is required, e.g. /wp/v2/posts");
          }
          const options = await wp.rest.describe(a.path);
          const answer = isIndexRoute(wp.parseRoute(a.path).route, options)
            ? (await wp.rest.request("GET", a.path)).body
            : options;
          return ok(summarizeEndpoint(a.path, answer));
        }

        default:
          return text(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(e);
    }
  });

  return server;
}
