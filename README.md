# YouTube MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
MCP client (Claude Desktop, Claude Code, etc.) search YouTube, pull video
transcripts, and run semantic search over a local library of stored transcripts.

Inspired by [ia-programming/youtube-mcp](https://github.com/ia-programming/youtube-mcp),
rebuilt to **work out of the box with no API keys**:

- **Search** uses `yt-dlp` (reads public YouTube data — no YouTube Data API key).
- **Transcripts** use `youtube-transcript-api`.
- **Semantic search** uses [ChromaDB](https://www.trychroma.com/) with a bundled
  local embedding model (`all-MiniLM-L6-v2`). A Google API key is *optional* and
  only needed if you'd rather use Google's embedding models.

## Tools

| Tool | Description |
| --- | --- |
| `search_youtube(query, max_results=5)` | Search YouTube for videos. Returns id, title, url, channel, duration, views. |
| `get_transcript(url, languages=None)` | Fetch a video's transcript by URL or 11-char id. |
| `store_video_info(url, title=None, transcript=None, languages=None)` | Store a transcript in the vector DB (fetches it automatically if not provided). |
| `search_transcripts(query, max_results=5)` | Semantic search across stored transcripts. |

## Requirements

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip

## Setup

```bash
# Clone, then install dependencies into a virtual environment
uv sync
```

The first semantic-search or `store_video_info` call downloads the local
embedding model (~80 MB) into `~/.cache/chroma`; subsequent calls are offline.

## Running

```bash
# Run the server over stdio
uv run youtube-mcp
# or
uv run python -m youtube_mcp.server
```

## Configuration

All configuration is optional (see `.env.example`):

| Variable | Purpose | Default |
| --- | --- | --- |
| `YT_MCP_STORE_PATH` | Where the persistent vector store lives | `./.youtube_mcp_store` |
| `GOOGLE_API_KEY` | Use Google embeddings instead of the local model | *(local model)* |
| `YT_MCP_EMBED_MODEL` | Google embedding model name | `models/text-embedding-004` |

## Use with Claude Desktop

Add this to your `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "youtube": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/youtube-mcp", "run", "youtube-mcp"]
    }
  }
}
```

## Use with Claude Code

```bash
claude mcp add youtube -- uv --directory /absolute/path/to/youtube-mcp run youtube-mcp
```

## Development

```bash
uv run pytest        # run the test suite (no network required)
```

## Project layout

```
.
├── src/youtube_mcp/
│   ├── server.py      # FastMCP server + tool definitions
│   ├── youtube.py     # search + transcript helpers
│   └── store.py       # ChromaDB-backed transcript vector store
├── tests/             # offline unit tests
├── pyproject.toml
└── README.md
```

## Notes

- Search and transcript retrieval hit YouTube directly, so a network
  environment that blocks `youtube.com` (e.g. a restricted CI/sandbox network
  policy) will prevent those two tools from returning results. The vector store
  and semantic search run fully locally.
- YouTube does not publish transcripts for every video; `get_transcript`
  returns a clear error when none is available.
