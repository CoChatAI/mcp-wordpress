# mcp-wordpress

A [Model Context Protocol](https://modelcontextprotocol.io) server for the WordPress REST API. Gives AI assistants full read/write access to any WordPress site using standard [Application Passwords](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/) — no plugins required.

## Features

- **Posts** — list, get, create, update, delete
- **Pages** — list, get, create, update, delete
- **Media** — list, get, update metadata, delete
- **Categories** — list, create, update, delete
- **Tags** — list, create, update, delete
- **Comments** — list, create, update, delete
- **Users** — list, get current user
- **Site Settings** — get and update

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
| `update_media` | Update media metadata (alt text, caption, etc.) |
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

## License

MIT
