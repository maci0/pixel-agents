import { serve } from "bun";
import { watch, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

// Load configuration and parse PNGs to SpriteData
import { PNG } from 'pngjs';

const PNG_ALPHA_THRESHOLD = 128;

// Reused from asset loader
function pngToSpriteData(pngBuffer: Buffer, width: number, height: number): string[][] {
  try {
    const png = PNG.sync.read(pngBuffer);
    const sprite: string[][] = [];
    const data = png.data;
    for (let y = 0; y < height; y++) {
      const row: string[] = [];
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * png.width + x) * 4;
        const r = data[pixelIndex];
        const g = data[pixelIndex + 1];
        const b = data[pixelIndex + 2];
        const a = data[pixelIndex + 3];
        if (a < PNG_ALPHA_THRESHOLD) {
          row.push('');
        } else {
          const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
          row.push(hex);
        }
      }
      sprite.push(row);
    }
    return sprite;
  } catch (err) {
    const sprite: string[][] = [];
    for (let y = 0; y < height; y++) {
      sprite.push(new Array(width).fill(''));
    }
    return sprite;
  }
}

const PUBLIC_DIR = join(import.meta.dir, '../dist/webview');
const WEBVIEW_ASSETS_DIR = join(import.meta.dir, '../webview-ui/public/assets');
const DIST_ASSETS_DIR = join(import.meta.dir, '../dist/assets');

function resolveAsset(relativePath: string): string | null {
  const distPath = join(DIST_ASSETS_DIR, relativePath);
  if (existsSync(distPath)) return distPath;
  const webviewPath = join(WEBVIEW_ASSETS_DIR, relativePath);
  if (existsSync(webviewPath)) return webviewPath;
  return null;
}

let clients = new Set<any>();

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const OPENCODE_DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

let opencodeDb: Database | null = null;
try {
  if (existsSync(OPENCODE_DB_PATH)) {
    opencodeDb = new Database(OPENCODE_DB_PATH, { readonly: true });
    console.log(`[Standalone] Connected to OpenCode DB at ${OPENCODE_DB_PATH}`);
  }
} catch (e) {
  console.error(`[Standalone] Failed to open OpenCode DB:`, e);
}

const broadcast = (data: any) => {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    client.send(msg);
  }
};

interface AgentState {
  id: number;
  type: 'claude' | 'opencode';
  sessionId: string;
  projectName?: string;
  fileOffset?: number;
  lineBuffer?: string;
  lastMessageTime?: number;
}

const agents = new Map<number, AgentState>();
const knownSessions = new Set<string>();
let nextAgentId = 1;

// Load layout
function getLayout() {
  const layoutPath = join(homedir(), '.pixel-agents', 'layout.json');
  if (existsSync(layoutPath)) {
    return JSON.parse(readFileSync(layoutPath, 'utf8'));
  }
  const defaultLayoutPath = resolveAsset('default-layout.json');
  if (defaultLayoutPath) {
    return JSON.parse(readFileSync(defaultLayoutPath, 'utf8'));
  }
  return null;
}

// Extract tool name correctly, like STATUS_TO_TOOL mapping
const formatToolStatus = (toolName: string, input: any) => {
  const base = (p: unknown) => typeof p === 'string' ? basename(p) : '';
  switch (toolName) {
    case 'Read': return `Reading ${base(input?.file_path)}`;
    case 'read': return `Reading ${base(input?.filePath)}`;
    case 'Edit': return `Editing ${base(input?.file_path)}`;
    case 'edit': return `Editing ${base(input?.filePath)}`;
    case 'Write': return `Writing ${base(input?.file_path)}`;
    case 'write': return `Writing ${base(input?.filePath)}`;
    case 'Bash': 
    case 'bash': {
      const cmd = (input?.command as string) || '';
      return `Running: ${cmd.length > 30 ? cmd.slice(0, 30) + '\u2026' : cmd}`;
    }
    case 'Glob': 
    case 'glob': return 'Searching files';
    case 'Grep': 
    case 'grep': return 'Searching code';
    case 'WebFetch':
    case 'webfetch': return 'Fetching web content';
    case 'WebSearch': return 'Searching the web';
    case 'Task': 
    case 'task': {
      const desc = typeof input?.description === 'string' ? input.description : '';
      return desc ? `Subtask: ${desc.length > 40 ? desc.slice(0, 40) + '\u2026' : desc}` : 'Running subtask';
    }
    case 'AskUserQuestion': 
    case 'question': return 'Waiting for your answer';
    default: return `Using ${toolName}`;
  }
};

// ... OpenCode Polling logic
let lastOpenCodePoll = Date.now();
if (opencodeDb) {
  setInterval(() => {
    try {
      const recentParts = opencodeDb!.query(`SELECT id, session_id, time_created, data FROM part WHERE time_created > ? ORDER BY time_created ASC`).all(lastOpenCodePoll) as any[];
      if (recentParts.length > 0) {
        lastOpenCodePoll = recentParts[recentParts.length - 1].time_created;
      }
      
      for (const part of recentParts) {
        const { session_id, data: dataStr } = part;
        let data: any;
        try {
          data = JSON.parse(dataStr);
        } catch { continue; }
        
        let agentId = -1;
        for (const [id, agent] of agents.entries()) {
          if (agent.type === 'opencode' && agent.sessionId === session_id) {
            agentId = id;
            break;
          }
        }
        
        if (agentId === -1) {
          // Identify opencode project
          let projectName = 'opencode';
          try {
            const row = opencodeDb!.query(`SELECT title, directory FROM session WHERE id = ?`).get(session_id) as any;
            if (row) {
              projectName = basename(row.directory);
            }
          } catch (e) { console.error("[Asset Loading Error]", e); }
          
          agentId = nextAgentId++;
          agents.set(agentId, {
            id: agentId,
            type: 'opencode',
            sessionId: session_id,
            projectName,
            lastMessageTime: Date.now()
          });
          console.log(`[OpenCode] New session detected: ${session_id}`);
          broadcast({ type: 'agentCreated', id: agentId, folderName: projectName });
        }
        
        // Handle parts
        if (data.type === 'tool') {
          if (data.state.status === 'running') {
            const toolName = data.tool;
            const status = formatToolStatus(toolName, data.state.input);
            broadcast({ type: 'agentToolStart', id: agentId, toolId: data.callID, status });
          } else if (data.state.status === 'completed' || data.state.status === 'error') {
            broadcast({ type: 'agentToolDone', id: agentId, toolId: data.callID });
          }
        } else if (data.type === 'step-start') {
          broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
        } else if (data.type === 'step-finish' || data.type === 'text') {
          // If the AI replied, clear tools and maybe set waiting? OpenCode is asynchronous. 
          broadcast({ type: 'agentToolsClear', id: agentId });
          // OpenCode agents typically wait for user
          broadcast({ type: 'agentStatus', id: agentId, status: 'waiting' });
        }
      }
      
      // Also poll for user messages
      const recentMsgs = opencodeDb!.query(`SELECT session_id FROM message WHERE time_created > ? AND json_extract(data, '$.role') = 'user'`).all(lastOpenCodePoll) as any[];
      for (const msg of recentMsgs) {
        let agentId = -1;
        for (const [id, agent] of agents.entries()) {
          if (agent.type === 'opencode' && agent.sessionId === msg.session_id) {
            agentId = id;
            break;
          }
        }
        if (agentId !== -1) {
          broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
        }
      }
      
    } catch (e) {
      console.error('[OpenCode] Poll error:', e);
    }
  }, 1000);
}

serve({
  port: 4242,
  fetch(req, server) {
    // WebSocket upgrade
    if (server.upgrade(req)) {
      return; // upgraded
    }

    const url = new URL(req.url);
    
    // Serve static files from webview-ui/dist
    if (url.pathname === '/') {
      return new Response(Bun.file(join(PUBLIC_DIR, 'index.html')));
    }
    
    // Handle asset loading dynamically since they aren't bundled with postMessage in standalone
    // Wait, the webview API loads assets using messages: furnitureAssetsLoaded, etc.
    // In standalone, we just emulate the VSCode backend.
    
    const filePath = join(PUBLIC_DIR, url.pathname);
    if (!existsSync(filePath)) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(Bun.file(filePath));
  },
  websocket: {
    message(ws, message) {
      const msg = JSON.parse(message as string);
      if (msg.type === 'webviewReady') {
        clients.add(ws);
        
        ws.send(JSON.stringify({ type: 'settingsLoaded', soundEnabled: true }));
        ws.send(JSON.stringify({ type: 'workspaceFolders', folders: [] }));
        
        try {
          const floorPath = resolveAsset('floors.png');
          if (!floorPath) throw new Error('floors.png not found');
          const pngBuffer = readFileSync(floorPath);
          const png = PNG.sync.read(pngBuffer);
          const sprites: string[][][] = [];
          for (let t = 0; t < 7; t++) {
            const sprite: string[][] = [];
            for (let y = 0; y < 16; y++) {
              const row: string[] = [];
              for (let x = 0; x < 16; x++) {
                const px = t * 16 + x;
                const idx = (y * png.width + px) * 4;
                const r = png.data[idx];
                const g = png.data[idx + 1];
                const b = png.data[idx + 2];
                const a = png.data[idx + 3];
                if (a < 128) row.push('');
                else row.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase());
              }
              sprite.push(row);
            }
            sprites.push(sprite);
          }
          ws.send(JSON.stringify({ type: 'floorTilesLoaded', sprites }));
        } catch (e) { console.error("[Asset Loading Error]", e); }
        
        try {
          const wallPath = resolveAsset('walls.png');
          if (!wallPath) throw new Error('walls.png not found');
          const pngBuffer = readFileSync(wallPath);
          const png = PNG.sync.read(pngBuffer);
          const sprites: string[][][] = [];
          for (let mask = 0; mask < 16; mask++) {
            const ox = (mask % 4) * 16;
            const oy = Math.floor(mask / 4) * 32;
            const sprite: string[][] = [];
            for (let r = 0; r < 32; r++) {
              const row: string[] = [];
              for (let c = 0; c < 16; c++) {
                const idx = ((oy + r) * png.width + (ox + c)) * 4;
                const rv = png.data[idx];
                const gv = png.data[idx + 1];
                const bv = png.data[idx + 2];
                const av = png.data[idx + 3];
                if (av < 128) row.push('');
                else row.push(`#${rv.toString(16).padStart(2, '0')}${gv.toString(16).padStart(2, '0')}${bv.toString(16).padStart(2, '0')}`.toUpperCase());
              }
              sprite.push(row);
            }
            sprites.push(sprite);
          }
          ws.send(JSON.stringify({ type: 'wallTilesLoaded', sprites }));
        } catch (e) { console.error("[Asset Loading Error]", e); }
        
        try {
          const characters: any[] = [];
          for (let ci = 0; ci < 6; ci++) {
            const filePath = resolveAsset(join('characters', `char_${ci}.png`));
            if (filePath) {
              const pngBuffer = readFileSync(filePath);
              const png = PNG.sync.read(pngBuffer);
              const charData: any = { down: [], up: [], right: [] };
              const directions = ['down', 'up', 'right'];
              for (let dirIdx = 0; dirIdx < 3; dirIdx++) {
                const dir = directions[dirIdx];
                const rowOffsetY = dirIdx * 32;
                const frames: string[][][] = [];
                for (let f = 0; f < 7; f++) {
                  const sprite: string[][] = [];
                  const frameOffsetX = f * 16;
                  for (let y = 0; y < 32; y++) {
                    const row: string[] = [];
                    for (let x = 0; x < 16; x++) {
                      const idx = (((rowOffsetY + y) * png.width) + (frameOffsetX + x)) * 4;
                      const r = png.data[idx];
                      const g = png.data[idx + 1];
                      const b = png.data[idx + 2];
                      const a = png.data[idx + 3];
                      if (a < 128) row.push('');
                      else row.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase());
                    }
                    sprite.push(row);
                  }
                  frames.push(sprite);
                }
                charData[dir] = frames;
              }
              characters.push(charData);
            }
          }
          ws.send(JSON.stringify({ type: 'characterSpritesLoaded', characters }));
        } catch (e) { console.error("[Asset Loading Error]", e); }

        try {
          const catalogPath = resolveAsset(join('furniture', 'furniture-catalog.json'));
          if (catalogPath) {
            const catalogData = JSON.parse(readFileSync(catalogPath, 'utf8'));
            const catalog = catalogData.assets || [];
            const spritesObj: Record<string, string[][]> = {};
            for (const asset of catalog) {
              const assetPath = resolveAsset(asset.file.replace('assets/', ''));
              if (assetPath) {
                const pngBuffer = readFileSync(assetPath);
                spritesObj[asset.id] = pngToSpriteData(pngBuffer, asset.width, asset.height);
              }
            }
            ws.send(JSON.stringify({ type: 'furnitureAssetsLoaded', catalog, sprites: spritesObj }));
          }
        } catch (e) { console.error("[Asset Loading Error]", e); }
        
        const agentIds = Array.from(agents.keys());
        const folderNames: Record<number, string> = {};
        for (const [id, agent] of agents) {
          if (agent.projectName) folderNames[id] = agent.projectName;
        }
        ws.send(JSON.stringify({ type: 'existingAgents', agents: agentIds, folderNames }));
        
        const layout = getLayout();
        ws.send(JSON.stringify({ type: 'layoutLoaded', layout }));
        
      } else if (msg.type === 'openClaude') {
        // Mock opening new claude if wanted, though usually it comes from file watcher
      }
    },
    close(ws) {
      clients.delete(ws);
    }
  }
});

console.log('[Standalone] Server running at http://localhost:4242');


// Claude Code JSONL Watcher
const fileOffsets = new Map<string, number>();
const lineBuffers = new Map<string, string>();

// Only track JSONL files modified within this window (ms)
const CLAUDE_RECENCY_MS = 10 * 60 * 1000; // 10 minutes

function processClaude() {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return;
  const now = Date.now();
  let projects: string[];
  try { projects = readdirSync(CLAUDE_PROJECTS_DIR); } catch { return; }
  for (const proj of projects) {
    const projDir = join(CLAUDE_PROJECTS_DIR, proj);
    let files: string[];
    try { files = readdirSync(projDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const filePath = join(projDir, f);
      const sessionId = f.replace('.jsonl', '');
      let stat: ReturnType<typeof statSync>;
      try { stat = statSync(filePath); } catch { continue; }

      // Skip stale sessions — only pick up recently-modified files
      if (!knownSessions.has(sessionId)) {
        if (now - stat.mtimeMs > CLAUDE_RECENCY_MS) continue;
        knownSessions.add(sessionId);
        const agentId = nextAgentId++;
        agents.set(agentId, { id: agentId, type: 'claude', sessionId, projectName: proj, lastMessageTime: Date.now() });
        console.log(`[Claude] Active session detected: ${sessionId}`);
        broadcast({ type: 'agentCreated', id: agentId, folderName: proj });
        // Start reading from end of file (don't replay history)
        fileOffsets.set(sessionId, stat.size);
        lineBuffers.set(sessionId, '');
        continue;
      }

      const offset = fileOffsets.get(sessionId) ?? stat.size;
      if (stat.size <= offset) continue;

      const buf = readFileSync(filePath);
      const newText = buf.toString('utf8', offset);
      fileOffsets.set(sessionId, stat.size);

      let agentId = -1;
      for (const [id, agent] of agents.entries()) {
        if (agent.type === 'claude' && agent.sessionId === sessionId) {
          agentId = id; break;
        }
      }
      if (agentId === -1) continue;

      const fullText = (lineBuffers.get(sessionId) || '') + newText;
      const lines = fullText.split('\n');
      lineBuffers.set(sessionId, lines.pop() || '');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
            broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
            for (const block of record.message.content) {
              if (block.type === 'tool_use') {
                const toolName = block.name || '';
                const status = formatToolStatus(toolName, block.input || {});
                broadcast({ type: 'agentToolStart', id: agentId, toolId: block.id, status });
              }
            }
          } else if (record.type === 'user') {
            const content = record.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_result' && block.tool_use_id) {
                  broadcast({ type: 'agentToolDone', id: agentId, toolId: block.tool_use_id });
                }
              }
            } else if (typeof content === 'string') {
              broadcast({ type: 'agentToolsClear', id: agentId });
            }
          } else if (record.type === 'system' && record.subtype === 'turn_duration') {
            broadcast({ type: 'agentToolsClear', id: agentId });
            broadcast({ type: 'agentStatus', id: agentId, status: 'waiting' });
          }
        } catch { /* malformed JSONL line, skip */ }
      }
    }
  }
}

setInterval(processClaude, 1000);
