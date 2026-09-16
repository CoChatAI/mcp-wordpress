import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import * as wp from "./client.js";
import { resolveSource } from "./upload.js";

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function ok(data: unknown) {
  return text(JSON.stringify(data, null, 2));
}

function err(e: unknown) {
  if (e instanceof wp.WordPressError) {
    return text(`Error ${e.status}: ${e.message}\n${JSON.stringify(e.body, null, 2)}`);
  }
  return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
}

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
    description: "Create a new WordPress post",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Post title" },
        content: { type: "string", description: "Post content (HTML or blocks)" },
        excerpt: { type: "string", description: "Post excerpt" },
        status: { type: "string", enum: ["publish", "draft", "pending", "private", "future"], description: "Post status (default: draft)" },
        slug: { type: "string", description: "Post slug (URL-friendly name)" },
        author: { type: "number", description: "Author user ID" },
        categories: { type: "array", items: { type: "number" }, description: "Category IDs" },
        tags: { type: "array", items: { type: "number" }, description: "Tag IDs" },
        featured_media: { type: "number", description: "Featured image media ID" },
        comment_status: { type: "string", enum: ["open", "closed"], description: "Allow comments" },
        sticky: { type: "boolean", description: "Stick post to front page" },
        date: { type: "string", description: "Publication date (ISO 8601)" },
        format: { type: "string", description: "Post format: standard, aside, chat, gallery, link, image, quote, status, video, audio" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_post",
    description: "Update an existing WordPress post",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Post ID to update" },
        title: { type: "string" },
        content: { type: "string" },
        excerpt: { type: "string" },
        status: { type: "string", enum: ["publish", "draft", "pending", "private", "future"] },
        slug: { type: "string" },
        author: { type: "number" },
        categories: { type: "array", items: { type: "number" } },
        tags: { type: "array", items: { type: "number" } },
        featured_media: { type: "number" },
        comment_status: { type: "string", enum: ["open", "closed"] },
        sticky: { type: "boolean" },
        date: { type: "string" },
      },
      required: ["id"],
    },
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
    description: "Create a new WordPress page",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Page title" },
        content: { type: "string", description: "Page content" },
        excerpt: { type: "string" },
        status: { type: "string", enum: ["publish", "draft", "pending", "private", "future"] },
        slug: { type: "string" },
        author: { type: "number" },
        parent: { type: "number", description: "Parent page ID" },
        menu_order: { type: "number", description: "Order in menu" },
        featured_media: { type: "number" },
        comment_status: { type: "string", enum: ["open", "closed"] },
      },
      required: ["title"],
    },
  },
  {
    name: "update_page",
    description: "Update an existing WordPress page",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        title: { type: "string" },
        content: { type: "string" },
        excerpt: { type: "string" },
        status: { type: "string", enum: ["publish", "draft", "pending", "private", "future"] },
        slug: { type: "string" },
        parent: { type: "number" },
        menu_order: { type: "number" },
      },
      required: ["id"],
    },
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
        title: { type: "string", description: "Media title (defaults to the filename)" },
        alt_text: { type: "string", description: "Alternative text for accessibility" },
        caption: { type: "string", description: "Media caption" },
        description: { type: "string", description: "Media description" },
        post: { type: "number", description: "Post or page ID to attach the file to" },
        author: { type: "number", description: "Author user ID" },
      },
    },
  },
  {
    name: "update_media",
    description: "Update media item metadata (title, alt text, caption, description)",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        title: { type: "string" },
        alt_text: { type: "string", description: "Alternative text for accessibility" },
        caption: { type: "string" },
        description: { type: "string" },
      },
      required: ["id"],
    },
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
    description: "Create a new WordPress category",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        slug: { type: "string" },
        description: { type: "string" },
        parent: { type: "number" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_category",
    description: "Update a WordPress category",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        slug: { type: "string" },
        description: { type: "string" },
        parent: { type: "number" },
      },
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
    description: "Create a new WordPress tag",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        slug: { type: "string" },
        description: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_tag",
    description: "Update a WordPress tag",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        slug: { type: "string" },
        description: { type: "string" },
      },
      required: ["id"],
    },
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
    description: "Create a new comment on a post",
    inputSchema: {
      type: "object",
      properties: {
        post: { type: "number", description: "Post ID to comment on" },
        content: { type: "string", description: "Comment content" },
        author_name: { type: "string" },
        author_email: { type: "string" },
        parent: { type: "number", description: "Parent comment ID for replies" },
      },
      required: ["post", "content"],
    },
  },
  {
    name: "update_comment",
    description: "Update a comment (content or status)",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        content: { type: "string" },
        status: { type: "string", description: "approved, hold, spam, trash" },
      },
      required: ["id"],
    },
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
    description: "Update WordPress site settings",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Site title" },
        description: { type: "string", description: "Site tagline" },
        timezone: { type: "string", description: "Timezone string (e.g. America/New_York)" },
        date_format: { type: "string" },
        time_format: { type: "string" },
        posts_per_page: { type: "number" },
        default_category: { type: "number" },
      },
    },
  },
];

// ── Server ─────────────────────────────────────────────────────────────────

export function createServer(): Server {
  const server = new Server(
    { name: "mcp-wordpress", version: "1.1.0" },
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
        case "create_post":
          return ok(await wp.posts.create(a as wp.PostInput));
        case "update_post": {
          const { id, ...data } = a;
          return ok(await wp.posts.update(Number(id), data as wp.PostInput));
        }
        case "delete_post":
          return ok(await wp.posts.delete(Number(a.id), Boolean(a.force)));

        // ── Pages ──
        case "list_pages":
          return ok(await wp.pages.list(a as Parameters<typeof wp.pages.list>[0]));
        case "get_page":
          return ok(await wp.pages.get(Number(a.id)));
        case "create_page":
          return ok(await wp.pages.create(a as wp.PageInput));
        case "update_page": {
          const { id, ...data } = a;
          return ok(await wp.pages.update(Number(id), data as wp.PageInput));
        }
        case "delete_page":
          return ok(await wp.pages.delete(Number(a.id), Boolean(a.force)));

        // ── Media ──
        case "list_media":
          return ok(await wp.media.list(a as Parameters<typeof wp.media.list>[0]));
        case "get_media":
          return ok(await wp.media.get(Number(a.id)));
        case "create_media": {
          const file = await resolveSource({
            source_url: a.source_url as string | undefined,
            data_base64: a.data_base64 as string | undefined,
            filename: a.filename as string | undefined,
            mime_type: a.mime_type as string | undefined,
          });
          // Named one by one rather than spread: everything here becomes a
          // query parameter, and an unadvertised key (a `status` borrowed from
          // create_post, say) would reach WordPress as an invalid one.
          const metadata: wp.MediaMetadata = {
            title: a.title as string | undefined,
            alt_text: a.alt_text as string | undefined,
            caption: a.caption as string | undefined,
            description: a.description as string | undefined,
            post: a.post === undefined ? undefined : Number(a.post),
            author: a.author === undefined ? undefined : Number(a.author),
          };
          return ok(await wp.media.create(file, metadata));
        }
        case "update_media": {
          const { id, ...data } = a;
          return ok(await wp.media.update(Number(id), data as Parameters<typeof wp.media.update>[1]));
        }
        case "delete_media":
          return ok(await wp.media.delete(Number(a.id), Boolean(a.force)));

        // ── Categories ──
        case "list_categories":
          return ok(await wp.categories.list(a as Parameters<typeof wp.categories.list>[0]));
        case "create_category":
          return ok(await wp.categories.create(a as Parameters<typeof wp.categories.create>[0]));
        case "update_category": {
          const { id, ...data } = a;
          return ok(await wp.categories.update(Number(id), data as Parameters<typeof wp.categories.update>[1]));
        }
        case "delete_category":
          return ok(await wp.categories.delete(Number(a.id), Boolean(a.force)));

        // ── Tags ──
        case "list_tags":
          return ok(await wp.tags.list(a as Parameters<typeof wp.tags.list>[0]));
        case "create_tag":
          return ok(await wp.tags.create(a as Parameters<typeof wp.tags.create>[0]));
        case "update_tag": {
          const { id, ...data } = a;
          return ok(await wp.tags.update(Number(id), data as Parameters<typeof wp.tags.update>[1]));
        }
        case "delete_tag":
          return ok(await wp.tags.delete(Number(a.id), Boolean(a.force)));

        // ── Comments ──
        case "list_comments":
          return ok(await wp.comments.list(a as Parameters<typeof wp.comments.list>[0]));
        case "create_comment":
          return ok(await wp.comments.create(a as Parameters<typeof wp.comments.create>[0]));
        case "update_comment": {
          const { id, ...data } = a;
          return ok(await wp.comments.update(Number(id), data as Parameters<typeof wp.comments.update>[1]));
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

        default:
          return text(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(e);
    }
  });

  return server;
}
