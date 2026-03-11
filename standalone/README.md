# Pixel Agents — Standalone Mode

Run Pixel Agents in your browser without VS Code. The standalone server watches both Claude Code JSONL files and OpenCode sessions, serving the same pixel art office UI over a local web server with WebSocket updates.

## Requirements

- [Bun](https://bun.sh/) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) and/or [OpenCode](https://github.com/nichochar/opencode) installed and configured

## Getting Started

1. Install Bun if you haven't already:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. Install dependencies and start the server:
   ```bash
   cd standalone
   bun install
   bun run start
   ```

3. Open `http://localhost:4242` in your browser.

4. The server will automatically detect any new Claude Code or OpenCode sessions and spawn agents in your browser.
