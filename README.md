# mcp-wordpress

A [Model Context Protocol](https://modelcontextprotocol.io) server for the WordPress REST API. Gives AI assistants full read/write access to any WordPress site using standard [Application Passwords](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/) — no plugins required.

## Features

- **Posts** — list, get, create, update, delete
- **Pages** — list, get, create, update, delete
- **Media** — list, get, upload, update, delete
- **Categories** — list, create, update, delete
- **Tags** — list, create, update, delete
- **Comments** — list, create, update, delete
- **Users** — list, get current user
- **Site Settings** — get and update
- **Custom fields** — the create and update tools for posts, pages, media, categories, tags and comments take `meta` (Yoast SEO fields, ACF-registered fields, …)
- **Any REST route** — `wordpress_request` for custom post types, plugin APIs and anything else, with `get_endpoint_schema` to discover what a route accepts

Every create and update tool declares every field WordPress core accepts on that route.

## Requirements

- WordPress 5.6+ (Application Passwords built in)
- A WordPress user with appropriate permissions
- An [Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/) generated for that user

## Usage

### With npx

```bash
WP_API_URL=https://mysite.com \
WP_API_USERNAME=myuser \
WP_API_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx" \
npx @cochatai/mcp-wordpress
```

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "npx",
      "args": ["-y", "@cochatai/mcp-wordpress"],
      "env": {
        "WP_API_URL": "https://mysite.com",
        "WP_API_USERNAME": "myuser",
        "WP_API_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

## Setup: Application Password

1. Log in to your WordPress admin
2. Go to **Users → Profile**
3. Scroll to **Application Passwords**
4. Enter a name (e.g. "CoChat") and click **Add New Application Password**
5. Copy the generated password (spaces are fine — they're stripped automatically)

## Environment Variables

| Variable | Description |
|---|---|
| `WP_API_URL` | Base URL of your WordPress site (e.g. `https://mysite.com`) |
| `WP_API_USERNAME` | WordPress username |
| `WP_API_PASSWORD` | WordPress application password |

## Available Tools

| Tool | Description |
|---|---|
| `list_posts` | List posts with filtering by status, author, category, tag |
| `get_post` | Get a single post by ID |
| `create_post` | Create a new post |
| `update_post` | Update an existing post |
| `delete_post` | Delete or trash a post |
| `list_pages` | List pages |
| `get_page` | Get a single page by ID |
| `create_page` | Create a new page |
| `update_page` | Update an existing page |
| `delete_page` | Delete or trash a page |
| `list_media` | List media library items |
| `get_media` | Get a single media item |
| `create_media` | Upload a file to the media library |
| `update_media` | Update a media item's attributes |
| `delete_media` | Permanently delete a media item |
| `list_categories` | List categories |
| `create_category` | Create a new category |
| `update_category` | Update a category |
| `delete_category` | Delete a category |
| `list_tags` | List tags |
| `create_tag` | Create a new tag |
| `update_tag` | Update a tag |
| `delete_tag` | Delete a tag |
| `list_comments` | List comments with filtering |
| `create_comment` | Create a new comment |
| `update_comment` | Update a comment or change its status |
| `delete_comment` | Delete a comment |
| `list_users` | List users with filtering by role |
| `get_current_user` | Get the authenticated user |
| `get_site_settings` | Get site title, description, timezone, etc. |
| `update_site_settings` | Update site settings |
| `wordpress_request` | Call any REST route on the site (any method, query, JSON body) |
| `get_endpoint_schema` | Describe a route: methods, arguments, and the meta keys it stores |

## Uploading media

`create_media` takes the file one of two ways — exactly one per call:

```jsonc
// from a public URL: the server downloads it, then uploads it
{ "source_url": "https://example.com/chart.png", "alt_text": "Quarterly revenue" }

// from bytes you already hold, base64-encoded (a data: URI works too)
{ "data_base64": "iVBORw0KGgo…", "filename": "chart.png", "title": "Q3 chart" }
```

`filename` and `mime_type` are inferred where possible — from the URL, the
response headers, or each other — and WordPress rejects a file whose extension
it does not allow, so pass them when the source is ambiguous. `title`,
`alt_text`, `caption`, `description`, `post` and `author` are optional.

The call returns the media item. Use its `id` as `featured_media` on
`create_post` / `update_post` to set a featured image, or its `source_url` to
embed the file in post content.

Two limits worth knowing: uploads are capped at 25MB (and by whatever the site
itself allows), and a `source_url` must resolve to a public address — loopback,
private-range and link-local hosts are refused, since the server fetching them
may sit inside a private network.

## Custom fields (`meta`)

The create and update tools for posts, pages, media, categories, tags and
comments take `meta` — a **JSON object passed as a string**. (Site settings have
no custom fields in WordPress, so `update_site_settings` does not.)

```jsonc
// update_post
{
  "id": 123,
  "meta": "{\"_yoast_wpseo_focuskw\": \"ai summarizer\", \"_yoast_wpseo_title\": \"AI Summarizer for Research\", \"_yoast_wpseo_metadesc\": \"Turn papers into structured briefs.\"}"
}
```

It is a string, not an object, because that is the one shape every model provider
fills in reliably: Gemini's function calling cannot express an object with
free-form keys and sends `{}`, silently dropping every value. Clients that pass a
real object are accepted too. Values can be any JSON; `null` deletes a key.

WordPress stores only meta keys **registered for the REST API** on the site, and
skips any other key without an error. The tool checks what came back: when
WordPress ignored a key, the result carries a second message naming it.
`get_endpoint_schema` lists the keys a route stores under `meta_keys`.

Keys starting with an underscore — Yoast's among them — are also protected: a
site has to grant write permission when it registers them, or the write fails
with `rest_cannot_update`. A minimal mu-plugin that exposes Yoast's three core
fields:

```php
<?php
add_action( 'init', function () {
	foreach ( array( '_yoast_wpseo_focuskw', '_yoast_wpseo_title', '_yoast_wpseo_metadesc' ) as $key ) {
		register_post_meta( '', $key, array(
			'type'          => 'string',
			'single'        => true,
			'show_in_rest'  => true,
			'auth_callback' => function ( $allowed, $meta_key, $post_id ) {
				return current_user_can( 'edit_post', $post_id );
			},
		) );
	}
} );
```

## Any REST route

`wordpress_request` calls any route under `/wp-json` on the configured site — custom
post types, users, menus, templates, or plugin namespaces such as `yoast/v1`,
`wc/v3` or ACF. `query` and `body` are JSON strings, for the same reason `meta` is:

```jsonc
{ "method": "GET",  "path": "/wp/v2/users/me", "query": "{\"context\": \"edit\"}" }
{ "method": "GET",  "path": "/wp/v2/product", "query": "{\"per_page\": 20, \"_fields\": \"id,title,link\"}" }
{ "method": "POST", "path": "/wp/v2/posts/123", "body": "{\"excerpt\": \"New\", \"meta\": {\"key\": \"value\"}}" }
```

It returns `{status, total, total_pages, body}` (the totals appear on paginated
lists), and WordPress's own error for anything that fails. The path must be a
route on this site's REST API: full URLs and `.`/`..` segments are refused, so the
credentials never reach anything outside `/wp-json`. It can do whatever the
WordPress user can — with an administrator's application password that includes
managing plugins, users and settings — so connect a user whose role matches what
you want an assistant to be able to change.

`get_endpoint_schema` answers the question to ask first: what does this route
accept? It returns each method's arguments, the meta keys the route stores, and —
for `/` or a namespace such as `/wp/v2` — the routes that exist.

## Development

```bash
npm install
npm run build

# End-to-end checks against a scratch WordPress site — they write posts, pages,
# media, terms and comments, so never point them at a live one. The site needs
# pretty permalinks (/wp-json/ does not route without them); the writes suite
# also needs Yoast SEO active and scripts/fixtures/smoke-mu-plugin.php in mu-plugins.
export WP_API_URL=http://localhost:8099 WP_API_USERNAME=admin \
  WP_API_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx"
npm run smoke          # both suites
npm run smoke:media    # uploads only
npm run smoke:writes   # create/update fields, meta, wordpress_request
```

## License

MIT
