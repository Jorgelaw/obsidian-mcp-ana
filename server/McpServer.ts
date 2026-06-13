/**
 * McpServer.ts
 * 
 * Expõe o vault do Obsidian como um servidor MCP via HTTP/SSE.
 * Qualquer cliente MCP (Claude Desktop, Claude Code, etc.) pode se conectar
 * na URL: http://localhost:{PORT}/sse
 * 
 * Tools expostas:
 *  - read_note       : lê conteúdo de uma nota
 *  - write_note      : cria ou sobrescreve uma nota
 *  - append_note     : adiciona texto ao final de uma nota
 *  - list_files      : lista arquivos/pastas
 *  - search_vault    : busca full-text no vault
 *  - get_metadata    : retorna frontmatter YAML de uma nota
 *  - open_note       : abre nota no editor do Obsidian
 *  - run_command     : executa um comando do Obsidian pelo ID
 */

import { App, TFile, TFolder, normalizePath, Notice } from "obsidian";
import McpBridgePlugin from "../src/main";

// We use the MCP SDK via dynamic import since we're in an Obsidian plugin context
// The actual HTTP server runs using Node's http module (available in Electron)

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpServer {
  private plugin: McpBridgePlugin;
  private app: App;
  private server: import("http").Server | null = null;
  private sseClients: Set<import("http").ServerResponse> = new Set();
  private running = false;

  constructor(plugin: McpBridgePlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const port = this.plugin.settings.serverPort;
    const token = this.plugin.settings.serverAuthToken;

    const http = require("http") as typeof import("http");

    this.server = http.createServer((req, res) => {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Auth check
      if (token) {
        const authHeader = req.headers.authorization || "";
        const queryToken = new URL(req.url || "", `http://localhost`).searchParams.get("token");
        if (!authHeader.includes(token) && queryToken !== token) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      const url = new URL(req.url || "/", `http://localhost:${port}`);

      // SSE endpoint for MCP transport
      if (url.pathname === "/sse" && req.method === "GET") {
        this.handleSSE(req, res);
        return;
      }

      // JSON-RPC POST endpoint
      if (url.pathname === "/mcp" && req.method === "POST") {
        this.handleJsonRpc(req, res);
        return;
      }

      // Health check
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          plugin: "obsidian-mcp-bridge",
          vault: this.app.vault.getName(),
          tools: this.getTools().length,
        }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, "127.0.0.1", () => {
        this.running = true;
        this.plugin.log(`Servidor MCP iniciado na porta ${port}`);
        new Notice(`MCP Bridge: servidor ativo em localhost:${port}`);
        resolve();
      });
      this.server!.on("error", (err) => {
        new Notice(`MCP Bridge: erro ao iniciar servidor — ${err.message}`);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running || !this.server) return;
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.running = false;
    this.plugin.log("Servidor MCP parado.");
  }

  private handleSSE(req: import("http").IncomingMessage, res: import("http").ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    this.sseClients.add(res);
    this.plugin.log("SSE client connected");

    // Send server info as first event
    this.sendSSE(res, "endpoint", JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {
        serverInfo: {
          name: "obsidian-mcp-bridge",
          version: "1.0.0",
        },
        capabilities: {
          tools: {},
        },
      },
    }));

    req.on("close", () => {
      this.sseClients.delete(res);
      this.plugin.log("SSE client disconnected");
    });
  }

  private sendSSE(res: import("http").ServerResponse, event: string, data: string): void {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  private async handleJsonRpc(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const msg: McpMessage = JSON.parse(body);
        const result = await this.processMessage(msg);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  private async processMessage(msg: McpMessage): Promise<McpMessage> {
    const { id, method, params } = msg;

    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "obsidian-mcp-bridge", version: "1.0.0" },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: this.getTools() },
        };

      case "tools/call":
        return await this.handleToolCall(id, params as { name: string; arguments: Record<string, unknown> });

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  private getTools(): Tool[] {
    return [
      {
        name: "read_note",
        description: "Lê o conteúdo completo de uma nota do vault. Retorna o texto Markdown.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Caminho relativo da nota no vault, ex: 'Projetos/ANA/README.md'",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "write_note",
        description: "Cria ou sobrescreve uma nota no vault com o conteúdo fornecido.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Caminho relativo da nota, ex: 'Resultados/relatorio.md'",
            },
            content: {
              type: "string",
              description: "Conteúdo Markdown a ser escrito na nota.",
            },
            overwrite: {
              type: "boolean",
              description: "Se true, sobrescreve se já existir. Padrão: true.",
            },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "append_note",
        description: "Adiciona texto ao final de uma nota existente. Cria a nota se não existir.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Caminho da nota." },
            content: { type: "string", description: "Texto a adicionar ao final." },
            separator: {
              type: "string",
              description: "Separador antes do novo conteúdo. Padrão: '\\n\\n---\\n\\n'",
            },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "list_files",
        description: "Lista arquivos e pastas no vault ou em um diretório específico.",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "Pasta a listar. Use '' ou '/' para a raiz do vault.",
            },
            recursive: {
              type: "boolean",
              description: "Se true, lista recursivamente. Padrão: false.",
            },
            filter: {
              type: "string",
              description: "Filtro de extensão, ex: '.md', '.pdf'. Padrão: sem filtro.",
            },
          },
        },
      },
      {
        name: "search_vault",
        description: "Busca notas no vault pelo conteúdo. Retorna lista com trechos relevantes.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Texto a buscar no vault.",
            },
            limit: {
              type: "number",
              description: "Número máximo de resultados. Padrão: 20.",
            },
            folder: {
              type: "string",
              description: "Restringir busca a uma pasta específica. Opcional.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_metadata",
        description: "Retorna o frontmatter YAML e metadados de uma nota.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Caminho da nota." },
          },
          required: ["path"],
        },
      },
      {
        name: "open_note",
        description: "Abre uma nota no editor do Obsidian.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Caminho da nota a abrir." },
            newLeaf: {
              type: "boolean",
              description: "Se true, abre em nova aba. Padrão: false.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "run_command",
        description: "Executa um comando do Obsidian pelo ID. Use list_commands para ver os disponíveis.",
        inputSchema: {
          type: "object",
          properties: {
            commandId: {
              type: "string",
              description: "ID do comando Obsidian, ex: 'editor:toggle-bold'.",
            },
          },
          required: ["commandId"],
        },
      },
      {
        name: "list_commands",
        description: "Lista todos os comandos disponíveis no Obsidian.",
        inputSchema: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              description: "Filtrar comandos por nome. Opcional.",
            },
          },
        },
      },
    ];
  }

  private async handleToolCall(
    id: string | number | undefined,
    params: { name: string; arguments: Record<string, unknown> }
  ): Promise<McpMessage> {
    const { name, arguments: args } = params;

    try {
      let result: unknown;

      switch (name) {
        case "read_note":
          result = await this.toolReadNote(args);
          break;
        case "write_note":
          result = await this.toolWriteNote(args);
          break;
        case "append_note":
          result = await this.toolAppendNote(args);
          break;
        case "list_files":
          result = await this.toolListFiles(args);
          break;
        case "search_vault":
          result = await this.toolSearchVault(args);
          break;
        case "get_metadata":
          result = await this.toolGetMetadata(args);
          break;
        case "open_note":
          result = await this.toolOpenNote(args);
          break;
        case "run_command":
          result = await this.toolRunCommand(args);
          break;
        case "list_commands":
          result = await this.toolListCommands(args);
          break;
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Tool not found: ${name}` },
          };
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Erro: ${String(err)}` }],
          isError: true,
        },
      };
    }
  }

  // ─── Tool implementations ──────────────────────────────────────────────────

  private async toolReadNote(args: Record<string, unknown>): Promise<string> {
    const path = normalizePath(String(args.path));
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Nota não encontrada: ${path}`);
    }
    return await this.app.vault.read(file);
  }

  private async toolWriteNote(args: Record<string, unknown>): Promise<string> {
    const path = normalizePath(String(args.path));
    const content = String(args.content);
    const overwrite = args.overwrite !== false;

    const existing = this.app.vault.getAbstractFileByPath(path);

    if (existing instanceof TFile) {
      if (!overwrite) throw new Error(`Nota já existe: ${path}. Use overwrite: true para sobrescrever.`);
      await this.app.vault.modify(existing, content);
      return `✅ Nota atualizada: ${path}`;
    } else {
      // Create folder structure if needed
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder) {
        await this.ensureFolder(folder);
      }
      await this.app.vault.create(path, content);
      return `✅ Nota criada: ${path}`;
    }
  }

  private async toolAppendNote(args: Record<string, unknown>): Promise<string> {
    const path = normalizePath(String(args.path));
    const content = String(args.content);
    const separator = args.separator !== undefined ? String(args.separator) : "\n\n---\n\n";

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      await this.app.vault.modify(existing, current + separator + content);
      return `✅ Conteúdo adicionado a: ${path}`;
    } else {
      await this.toolWriteNote({ path, content });
      return `✅ Nota criada (não existia) e conteúdo gravado: ${path}`;
    }
  }

  private async toolListFiles(args: Record<string, unknown>): Promise<object> {
    const folder = args.folder ? normalizePath(String(args.folder)) : "/";
    const recursive = args.recursive === true;
    const filter = args.filter ? String(args.filter) : "";

    const allFiles = this.app.vault.getAllLoadedFiles();
    const results: { path: string; type: string; size?: number }[] = [];

    for (const f of allFiles) {
      const inFolder = folder === "/" || folder === ""
        ? true
        : f.path.startsWith(folder + "/") || f.path === folder;

      if (!inFolder) continue;
      if (!recursive && folder !== "/" && folder !== "") {
        const relative = f.path.slice(folder.length + 1);
        if (relative.includes("/") && !(f instanceof TFolder)) continue;
      }

      if (filter && f instanceof TFile && !f.name.endsWith(filter)) continue;

      results.push({
        path: f.path,
        type: f instanceof TFolder ? "folder" : "file",
        size: f instanceof TFile ? f.stat.size : undefined,
      });
    }

    return {
      folder: folder === "/" ? "(raiz)" : folder,
      count: results.length,
      files: results,
    };
  }

  private async toolSearchVault(args: Record<string, unknown>): Promise<object> {
    const query = String(args.query).toLowerCase();
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const folder = args.folder ? normalizePath(String(args.folder)) : "";

    const results: { path: string; excerpt: string; score: number }[] = [];
    const mdFiles = this.app.vault.getMarkdownFiles();

    for (const file of mdFiles) {
      if (folder && !file.path.startsWith(folder)) continue;

      const content = await this.app.vault.cachedRead(file);
      const lowerContent = content.toLowerCase();

      if (lowerContent.includes(query)) {
        const idx = lowerContent.indexOf(query);
        const start = Math.max(0, idx - 100);
        const end = Math.min(content.length, idx + query.length + 200);
        const excerpt = (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");

        // Simple TF score
        const occurrences = (lowerContent.match(new RegExp(query, "g")) || []).length;
        results.push({ path: file.path, excerpt: excerpt.replace(/\n/g, " "), score: occurrences });
      }

      if (results.length >= limit * 2) break; // over-fetch then sort
    }

    results.sort((a, b) => b.score - a.score);

    return {
      query,
      total: results.length,
      results: results.slice(0, limit),
    };
  }

  private async toolGetMetadata(args: Record<string, unknown>): Promise<object> {
    const path = normalizePath(String(args.path));
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Nota não encontrada: ${path}`);
    }

    const cache = this.app.metadataCache.getFileCache(file);
    return {
      path: file.path,
      name: file.name,
      basename: file.basename,
      extension: file.extension,
      size: file.stat.size,
      created: new Date(file.stat.ctime).toISOString(),
      modified: new Date(file.stat.mtime).toISOString(),
      frontmatter: cache?.frontmatter ?? {},
      tags: cache?.tags?.map(t => t.tag) ?? [],
      links: cache?.links?.map(l => l.link) ?? [],
      headings: cache?.headings?.map(h => ({ level: h.level, heading: h.heading })) ?? [],
    };
  }

  private async toolOpenNote(args: Record<string, unknown>): Promise<string> {
    const path = normalizePath(String(args.path));
    const newLeaf = args.newLeaf === true;

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Nota não encontrada: ${path}`);
    }

    const leaf = newLeaf
      ? this.app.workspace.getLeaf("tab")
      : this.app.workspace.getLeaf();

    await leaf.openFile(file);
    return `✅ Nota aberta: ${path}`;
  }

  private async toolRunCommand(args: Record<string, unknown>): Promise<string> {
    const commandId = String(args.commandId);
    const commands = (this.app as unknown as { commands: { commands: Record<string, { id: string; name: string }> } }).commands;

    if (!commands.commands[commandId]) {
      throw new Error(`Comando não encontrado: ${commandId}`);
    }

    (this.app as unknown as { commands: { executeCommandById: (id: string) => boolean } }).commands.executeCommandById(commandId);
    return `✅ Comando executado: ${commandId}`;
  }

  private async toolListCommands(args: Record<string, unknown>): Promise<object> {
    const filter = args.filter ? String(args.filter).toLowerCase() : "";
    const commands = (this.app as unknown as { commands: { commands: Record<string, { id: string; name: string }> } }).commands.commands;

    const list = Object.values(commands)
      .filter(cmd => !filter || cmd.name.toLowerCase().includes(filter) || cmd.id.includes(filter))
      .map(cmd => ({ id: cmd.id, name: cmd.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { total: list.length, commands: list };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async ensureFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}
