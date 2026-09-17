/**
 * Writes smoke test: every create/update tool's full field set, custom fields
 * through `meta`, wordpress_request and get_endpoint_schema, against a real
 * WordPress site through the built server (see harness.mjs).
 *
 *   npm run build
 *   WP_API_URL=http://localhost:8099 WP_API_USERNAME=admin \
 *     WP_API_PASSWORD="xxxx xxxx xxxx" node scripts/smoke-writes.mjs
 *
 * The site needs Yoast SEO active and these meta keys registered with
 * `show_in_rest` (scripts/fixtures/rest-meta.php does exactly that — drop it in
 * mu-plugins):
 *   post meta     _yoast_wpseo_focuskw, _yoast_wpseo_title, _yoast_wpseo_metadesc
 *                 (with an auth_callback) and _locked_without_callback (without)
 *   term meta     term_note
 *   comment meta  comment_note
 *
 * It WRITES to the target site (posts, pages, media, terms, comments, and
 * settings it puts back), so point it at a scratch install, never a live one.
 */
import { startServer, createChecks } from "./harness.mjs";

const { rpc, callParts, callText, callJson, stop } = await startServer();
const { check, attempt, finish } = createChecks();

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const run = Date.now().toString(36);
const YOAST = {
  _yoast_wpseo_focuskw: "ai summarizer",
  _yoast_wpseo_title: `AI Summarizer for Research ${run}`,
  _yoast_wpseo_metadesc: "Use an AI summarizer to turn papers into structured briefs.",
};

// ── Schema: what CoChat's argument allowlist will let through ─────────────
await attempt("tool schemas", async () => {
  const { result } = await rpc("tools/list", {});
  const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
  const writers = Object.keys(byName).filter((n) => /^(create|update)_/.test(n) && n !== "update_site_settings");
  const withoutMeta = writers.filter((n) => byName[n].inputSchema.properties?.meta?.type !== "string");
  check("every create/update tool declares meta as a JSON string", withoutMeta.length === 0, `${writers.length} tools; missing: ${withoutMeta.join(", ") || "none"}`);
  check("wordpress_request and get_endpoint_schema are listed", Boolean(byName.wordpress_request && byName.get_endpoint_schema), `${result.tools.length} tools`);

  // Parity with what WordPress itself accepts on each write route.
  const expected = {
    update_post: ["author", "categories", "comment_status", "content", "date", "date_gmt", "excerpt", "featured_media", "format", "meta", "password", "ping_status", "slug", "status", "sticky", "tags", "template", "title"],
    update_page: ["author", "comment_status", "content", "date", "date_gmt", "excerpt", "featured_media", "menu_order", "meta", "parent", "password", "ping_status", "slug", "status", "template", "title"],
    update_media: ["alt_text", "author", "caption", "comment_status", "date", "date_gmt", "description", "featured_media", "meta", "ping_status", "post", "slug", "status", "template", "title"],
    update_category: ["description", "meta", "name", "parent", "slug"],
    update_tag: ["description", "meta", "name", "slug"],
    update_comment: ["author", "author_email", "author_ip", "author_name", "author_url", "author_user_agent", "content", "date", "date_gmt", "meta", "parent", "post", "status"],
    update_site_settings: ["date_format", "default_category", "default_comment_status", "default_ping_status", "default_post_format", "description", "email", "language", "page_for_posts", "page_on_front", "posts_per_page", "show_on_front", "site_icon", "site_logo", "start_of_week", "time_format", "timezone", "title", "url", "use_smilies"],
  };
  for (const [tool, fields] of Object.entries(expected)) {
    const declared = new Set(Object.keys(byName[tool].inputSchema.properties));
    const missing = fields.filter((f) => !declared.has(f));
    check(`${tool} declares every field WordPress accepts`, missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : `${fields.length} fields`);
  }
});

// ── Posts ─────────────────────────────────────────────────────────────────
let postId;
await attempt("create_post", async () => {
  const post = await callJson("create_post", {
    title: `Flexible writes ${run}`,
    content: "<p>Body</p>",
    status: "publish",
    ping_status: "closed",
    date_gmt: "2026-01-02T03:04:05",
    meta: JSON.stringify(YOAST),
  });
  postId = post.id;
  check("create_post saves Yoast meta from a JSON string", post.meta?._yoast_wpseo_focuskw === YOAST._yoast_wpseo_focuskw && post.meta?._yoast_wpseo_metadesc === YOAST._yoast_wpseo_metadesc, JSON.stringify(post.meta));
  check("create_post applies the newly declared fields", post.ping_status === "closed" && post.date_gmt === "2026-01-02T03:04:05", `ping_status=${post.ping_status} date_gmt=${post.date_gmt}`);

  // Yoast reads its own keys back: the SEO title and description reach the
  // head it renders, so these are the values Yoast actually uses.
  const head = await callJson("wordpress_request", { method: "GET", path: `/wp/v2/posts/${postId}`, query: JSON.stringify({ _fields: "yoast_head_json" }) });
  const yoast = head.body?.yoast_head_json ?? {};
  check("Yoast renders the SEO title and meta description", String(yoast.title ?? "").includes(YOAST._yoast_wpseo_title) && yoast.description === YOAST._yoast_wpseo_metadesc, `title=${JSON.stringify(yoast.title)} description=${JSON.stringify(yoast.description)}`);
});

await attempt("update_post", async () => {
  const updated = await callJson("update_post", { id: postId, meta: { _yoast_wpseo_focuskw: "research summarizer" } });
  check("update_post accepts meta as a real object (non-CoChat clients)", updated.meta?._yoast_wpseo_focuskw === "research summarizer", JSON.stringify(updated.meta?._yoast_wpseo_focuskw));
  check("update_post leaves meta it was not given alone", updated.meta?._yoast_wpseo_metadesc === YOAST._yoast_wpseo_metadesc, JSON.stringify(updated.meta?._yoast_wpseo_metadesc));

  const parts = await callParts("update_post", { id: postId, meta: JSON.stringify({ _yoast_wpseo_title: "Kept", not_registered_key: "x" }) });
  const body = JSON.parse(parts[0]);
  check("a registered key still saves beside an unregistered one", body.meta?._yoast_wpseo_title === "Kept", JSON.stringify(body.meta?._yoast_wpseo_title));
  check("the result names the meta key WordPress ignored", parts.length === 2 && parts[1].includes("not_registered_key") && !parts[1].includes("_yoast_wpseo_title"), parts[1] ?? "(no warning block)");

  const clean = await callParts("update_post", { id: postId, meta: JSON.stringify({ _yoast_wpseo_title: "Kept again" }) });
  check("no warning when every key was saved", clean.length === 1, `${clean.length} blocks`);

  const cleared = await callJson("update_post", { id: postId, meta: JSON.stringify({ _yoast_wpseo_focuskw: null }) });
  check("null deletes a meta key", cleared.meta?._yoast_wpseo_focuskw === "", JSON.stringify(cleared.meta?._yoast_wpseo_focuskw));

  const locked = await callText("update_post", { id: postId, meta: JSON.stringify({ _locked_without_callback: "x" }) });
  check("a key the site gives no write permission for fails loudly", /Error 40[13]/.test(locked) && locked.includes("rest_cannot_update"), locked.slice(0, 120));

  const bad = await callText("update_post", { id: postId, meta: "{not json" });
  check("malformed meta is refused with a clear message", /meta must be a JSON object/.test(bad), bad.slice(0, 120));

  const notObject = await callText("update_post", { id: postId, meta: "[1, 2]" });
  check("meta that is not an object is refused", /meta must be a JSON object/.test(notObject), notObject.slice(0, 120));

  const plain = await callJson("update_post", { id: postId, sticky: true, format: "aside", password: "" });
  check("update_post without meta still works", plain.sticky === true && plain.format === "aside", `sticky=${plain.sticky} format=${plain.format}`);
});

// ── Pages ─────────────────────────────────────────────────────────────────
await attempt("pages", async () => {
  const page = await callJson("create_page", { title: `Page ${run}`, status: "draft", menu_order: 7, ping_status: "closed", meta: JSON.stringify({ _yoast_wpseo_metadesc: "Page description" }) });
  check("create_page saves meta and the full field set", page.meta?._yoast_wpseo_metadesc === "Page description" && page.menu_order === 7 && page.ping_status === "closed", `menu_order=${page.menu_order}`);

  // update_page was missing most of create_page's fields before.
  const media = await callJson("create_media", { data_base64: PNG_B64, filename: `page-${run}.png` });
  const updated = await callJson("update_page", { id: page.id, featured_media: media.id, comment_status: "closed", author: 1, meta: JSON.stringify({ _yoast_wpseo_focuskw: "page keyword" }) });
  check("update_page sets featured_media, comment_status and meta", updated.featured_media === media.id && updated.comment_status === "closed" && updated.meta?._yoast_wpseo_focuskw === "page keyword", `featured_media=${updated.featured_media}`);
});

// ── Media ─────────────────────────────────────────────────────────────────
await attempt("media", async () => {
  const media = await callJson("create_media", { data_base64: PNG_B64, filename: `meta-${run}.png`, slug: `meta-slug-${run}`, post: postId, meta: JSON.stringify({ _yoast_wpseo_title: "Media SEO title" }) });
  check("create_media saves meta through the follow-up update", media.meta?._yoast_wpseo_title === "Media SEO title", JSON.stringify(media.meta));
  check("create_media passes the scalar fields on the upload", media.slug === `meta-slug-${run}` && media.post === postId, `slug=${media.slug} post=${media.post}`);

  const orphanCheck = await callText("create_media", { data_base64: PNG_B64, filename: `bad-meta-${run}.png`, meta: "{nope" });
  const listed = await callJson("list_media", { search: `bad-meta-${run}` });
  check("malformed meta on create_media fails before anything is uploaded", /meta must be a JSON object/.test(orphanCheck) && Array.isArray(listed) && listed.length === 0, `${listed.length} orphan(s)`);

  const partial = await callParts("create_media", { data_base64: PNG_B64, filename: `locked-${run}.png`, meta: JSON.stringify({ _locked_without_callback: "x" }) });
  const partialItem = JSON.parse(partial[0]);
  check("a failed meta step still returns the uploaded file and its id", Number.isInteger(partialItem.id) && partial.length === 2 && partial[1].includes(`media id ${partialItem.id}`) && partial[1].includes("rest_cannot_update"), (partial[1] ?? "").slice(0, 140));

  const updated = await callJson("update_media", { id: media.id, alt_text: "Alt", comment_status: "closed", meta: JSON.stringify({ _yoast_wpseo_metadesc: "Media description" }) });
  check("update_media saves meta and the full field set", updated.meta?._yoast_wpseo_metadesc === "Media description" && updated.alt_text === "Alt" && updated.comment_status === "closed", JSON.stringify(updated.meta));
});

// ── Terms ─────────────────────────────────────────────────────────────────
await attempt("terms", async () => {
  const category = await callJson("create_category", { name: `Cat ${run}`, meta: JSON.stringify({ term_note: "from create" }) });
  check("create_category saves term meta", category.meta?.term_note === "from create", JSON.stringify(category.meta));
  const category2 = await callJson("update_category", { id: category.id, description: "Described", meta: JSON.stringify({ term_note: "from update" }) });
  check("update_category saves term meta", category2.meta?.term_note === "from update" && category2.description === "Described", JSON.stringify(category2.meta));

  const tag = await callJson("create_tag", { name: `Tag ${run}`, meta: JSON.stringify({ term_note: "tag create" }) });
  check("create_tag saves term meta", tag.meta?.term_note === "tag create", JSON.stringify(tag.meta));
  const tag2 = await callJson("update_tag", { id: tag.id, meta: JSON.stringify({ term_note: "tag update" }) });
  check("update_tag saves term meta", tag2.meta?.term_note === "tag update", JSON.stringify(tag2.meta));
});

// ── Comments ──────────────────────────────────────────────────────────────
await attempt("comments", async () => {
  const own = await callJson("create_comment", { post: postId, content: "As the connected user", meta: JSON.stringify({ comment_note: "own" }) });
  check("create_comment with no author fields posts as the connected user", own.author > 0 && own.meta?.comment_note === "own", `author=${own.author}`);

  const comment = await callJson("create_comment", { post: postId, content: "Nice", author_name: "Guest", author_email: "guest@example.com", author_url: "https://example.com/me", meta: JSON.stringify({ comment_note: "from create" }) });
  check("create_comment saves comment meta and the author fields", comment.meta?.comment_note === "from create" && comment.author_url === "https://example.com/me" && comment.author_name === "Guest", JSON.stringify(comment.meta));
  const updated = await callJson("update_comment", { id: comment.id, status: "hold", author_name: "Renamed", meta: JSON.stringify({ comment_note: "from update" }) });
  check("update_comment saves meta, status and author_name", updated.meta?.comment_note === "from update" && updated.status === "hold" && updated.author_name === "Renamed", `status=${updated.status}`);
});

// ── Settings ──────────────────────────────────────────────────────────────
await attempt("settings", async () => {
  const before = await callJson("get_site_settings", {});
  const changed = await callJson("update_site_settings", { default_comment_status: before.default_comment_status === "open" ? "closed" : "open", start_of_week: 3 });
  check("update_site_settings sets newly declared settings", changed.default_comment_status !== before.default_comment_status && changed.start_of_week === 3, `default_comment_status=${changed.default_comment_status}`);
  await callJson("update_site_settings", { default_comment_status: before.default_comment_status, start_of_week: before.start_of_week });
});

// ── wordpress_request ─────────────────────────────────────────────────────
await attempt("wordpress_request", async () => {
  const list = await callJson("wordpress_request", { method: "GET", path: "/wp/v2/posts", query: JSON.stringify({ per_page: 1, _fields: "id,title" }) });
  check("GET returns status, pagination totals and the body", list.status === 200 && Number.isInteger(list.total) && Number.isInteger(list.total_pages) && Array.isArray(list.body) && list.body.length === 1, `status=${list.status} total=${list.total} pages=${list.total_pages}`);

  const inline = await callJson("wordpress_request", { method: "GET", path: `/wp-json/wp/v2/posts/${postId}?_fields=id,slug` });
  check("a /wp-json prefix and an inline query string both work", inline.body?.id === postId && Object.keys(inline.body).sort().join() === "id,slug", JSON.stringify(inline.body));

  const posted = await callJson("wordpress_request", { method: "POST", path: `/wp/v2/posts/${postId}`, body: JSON.stringify({ excerpt: "Raw excerpt", meta: { _yoast_wpseo_focuskw: "raw request" } }) });
  check("POST with a JSON body updates fields and meta", posted.status === 200 && posted.body?.meta?._yoast_wpseo_focuskw === "raw request", JSON.stringify(posted.body?.meta?._yoast_wpseo_focuskw));

  const me = await callJson("wordpress_request", { method: "GET", path: "/wp/v2/users/me", query: JSON.stringify({ context: "edit" }) });
  check("reaches routes no other tool covers (users/me, edit context)", me.status === 200 && Array.isArray(me.body?.roles), JSON.stringify(me.body?.roles));

  // Yoast's own index rather than /yoast/v1/get_head: that route resolves the
  // URL through the site's front end, which a throwaway install cannot always
  // do, and answers 404 even for a page that serves 200.
  const yoastRoute = await callJson("wordpress_request", { method: "GET", path: "/yoast/v1" });
  check("reaches plugin namespaces (yoast/v1)", yoastRoute.status === 200 && yoastRoute.body?.namespace === "yoast/v1", `status=${yoastRoute.status}`);

  const created = await callJson("wordpress_request", { method: "POST", path: "/wp/v2/tags", body: { name: `Raw tag ${run}` } });
  check("a body passed as a real object works too", created.status === 201 && created.body?.name === `Raw tag ${run}`, `status=${created.status}`);
  const deleted = await callJson("wordpress_request", { method: "DELETE", path: `/wp/v2/tags/${created.body.id}`, query: JSON.stringify({ force: true }) });
  check("DELETE with query parameters", deleted.status === 200 && deleted.body?.deleted === true, `status=${deleted.status}`);

  const notFound = await callText("wordpress_request", { method: "GET", path: "/wp/v2/no-such-route" });
  check("a missing route reports WordPress's 404", notFound.startsWith("Error 404") && notFound.includes("rest_no_route"), notFound.slice(0, 80));

  for (const [label, args, pattern] of [
    ["refuses dot segments", { method: "GET", path: "/wp/v2/../../wp-login.php" }, /"\." or "\.\." segments/],
    ["refuses encoded dot segments", { method: "GET", path: "/wp/v2/%2e%2e/%2e%2e/wp-admin/" }, /"\." or "\.\." segments/],
    ["refuses a full URL", { method: "GET", path: "https://example.com/wp-json/wp/v2/posts" }, /not a URL/],
    ["refuses a body on GET", { method: "GET", path: "/wp/v2/posts", body: "{}" }, /cannot carry a body/],
    ["refuses an unknown method", { method: "TRACE", path: "/wp/v2/posts" }, /method must be one of/],
    ["refuses malformed query JSON", { method: "GET", path: "/wp/v2/posts", query: "{oops" }, /query must be a JSON object/],
  ]) {
    const out = await callText("wordpress_request", args);
    check(`wordpress_request ${label}`, pattern.test(out), out.slice(0, 100));
  }
});

// ── get_endpoint_schema ───────────────────────────────────────────────────
await attempt("get_endpoint_schema", async () => {
  const schema = await callJson("get_endpoint_schema", { path: "/wp/v2/posts" });
  check("lists the meta keys a route stores", ["_yoast_wpseo_focuskw", "_yoast_wpseo_title", "_yoast_wpseo_metadesc"].every((k) => schema.meta_keys?.[k] === "string"), JSON.stringify(schema.meta_keys));
  check("lists each method's arguments", typeof schema.methods?.POST?.meta === "string" && /required/.test(schema.methods?.GET?.context ?? "") === false && typeof schema.methods?.GET?.per_page === "string", Object.keys(schema.methods ?? {}).join(","));
  check("is compact", JSON.stringify(schema).length < 20_000, `${JSON.stringify(schema).length} chars`);

  const terms = await callJson("get_endpoint_schema", { path: "/wp/v2/categories" });
  check("term routes list term meta keys", terms.meta_keys?.term_note === "string", JSON.stringify(terms.meta_keys));

  const index = await callJson("get_endpoint_schema", { path: "/" });
  check("the API index lists namespaces and routes", Array.isArray(index.namespaces) && index.namespaces.includes("yoast/v1") && typeof index.routes?.["/wp/v2/posts"] === "string", `${index.namespaces?.length} namespaces, ${Object.keys(index.routes ?? {}).length} routes`);

  const namespace = await callJson("get_endpoint_schema", { path: "/yoast/v1" });
  check("a namespace index lists its routes", namespace.namespace === "yoast/v1" && Object.keys(namespace.routes ?? {}).some((r) => r.startsWith("/yoast/v1/")), `${Object.keys(namespace.routes ?? {}).length} routes`);
});

stop();
process.exit(finish());
