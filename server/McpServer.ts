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

import { App, TFile, TFolder, normalizePath, Notice, requestUrl } from "obsidian";
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
  private sseSessions: Map<string, import("http").ServerResponse> = new Map();
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
          plugin: "obsidian-mcp-ana",
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
        new Notice(`MCP ANA: servidor ativo em localhost:${port}`);
        resolve();
      });
      this.server!.on("error", (err) => {
        new Notice(`MCP ANA: erro ao iniciar servidor — ${err.message}`);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running || !this.server) return;
    for (const sseRes of this.sseSessions.values()) {
      sseRes.end();
    }
    this.sseSessions.clear();
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

    // Create a session for this SSE connection (MCP HTTP+SSE transport)
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.sseSessions.set(sessionId, res);
    this.plugin.log(`SSE client connected (session ${sessionId})`);

    // Per the MCP HTTP+SSE transport, the FIRST SSE event must be "endpoint"
    // carrying the URI where the client should POST its JSON-RPC messages.
    this.sendSSE(res, "endpoint", `/mcp?sessionId=${sessionId}`);

    // Periodic comment lines keep the connection from idling out.
    const keepAlive = setInterval(() => {
      try { res.write(": keep-alive\n\n"); } catch { /* connection closed */ }
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAlive);
      this.sseSessions.delete(sessionId);
      this.plugin.log(`SSE client disconnected (session ${sessionId})`);
    });
  }

  private sendSSE(res: import("http").ServerResponse, event: string, data: string): void {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  private async handleJsonRpc(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> {
    const reqUrl = new URL(req.url || "/", "http://localhost");
    const sessionId = reqUrl.searchParams.get("sessionId");
    const sseRes = sessionId ? this.sseSessions.get(sessionId) : undefined;

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const msg: McpMessage = JSON.parse(body);

        // JSON-RPC notifications (no id, e.g. notifications/initialized) get no reply.
        const isNotification = msg.id === undefined || msg.id === null;
        const result = isNotification ? null : await this.processMessage(msg);

        if (sseRes) {
          // MCP HTTP+SSE transport: ack the POST, deliver the JSON-RPC
          // response back over the SSE stream as a "message" event.
          res.writeHead(202, { "Content-Type": "text/plain" });
          res.end("Accepted");
          if (result) this.sendSSE(sseRes, "message", JSON.stringify(result));
        } else {
          // Legacy direct mode (no SSE session): reply in the POST body.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result ?? { jsonrpc: "2.0", id: null, result: {} }));
        }
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
            serverInfo: { name: "obsidian-mcp-ana", version: "1.0.0" },
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
      {
        name: "get_server_info",
        description: "Retorna informações do servidor: nome, versão, vault, contagem de tools e servidores externos conectados.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "list_vault_files",
        description: "Lista arquivos do vault (Markdown por padrão). Use 'folder' para restringir e 'extension' para filtrar.",
        inputSchema: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Pasta a listar. Vazio = raiz." },
            extension: { type: "string", description: "Extensão, ex: '.md', '.pdf'. Padrão: '.md'." },
            recursive: { type: "boolean", description: "Recursivo. Padrão: true." },
          },
        },
      },
      {
        name: "get_vault_file",
        description: "Lê o conteúdo de um arquivo do vault pelo caminho.",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Caminho do arquivo." } }, required: ["path"] },
      },
      {
        name: "create_vault_file",
        description: "Cria ou sobrescreve um arquivo no vault.",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Caminho." }, content: { type: "string", description: "Conteúdo." }, overwrite: { type: "boolean", description: "Sobrescrever. Padrão: true." } }, required: ["path", "content"] },
      },
      {
        name: "append_to_vault_file",
        description: "Adiciona conteúdo ao final de um arquivo do vault (cria se não existir).",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Caminho." }, content: { type: "string", description: "Conteúdo a anexar." } }, required: ["path", "content"] },
      },
      {
        name: "patch_vault_file",
        description: "Insere/substitui conteúdo em um arquivo do vault relativo a heading, bloco (^id) ou frontmatter.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Caminho do arquivo." },
            operation: { type: "string", description: "'append', 'prepend' ou 'replace'. Padrão: 'append'." },
            targetType: { type: "string", description: "'heading', 'block' ou 'frontmatter'." },
            target: { type: "string", description: "Cabeçalho, id do bloco (sem ^) ou chave do frontmatter." },
            content: { type: "string", description: "Conteúdo." },
          },
          required: ["path", "targetType", "target", "content"],
        },
      },
      {
        name: "delete_vault_file",
        description: "Move um arquivo do vault para a lixeira (ou exclui). Use com cautela.",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Caminho." }, permanent: { type: "boolean", description: "Excluir permanentemente. Padrão: false." } }, required: ["path"] },
      },
      {
        name: "search_vault_simple",
        description: "Busca textual simples no vault; retorna caminhos e trecho de contexto.",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "Texto a buscar." }, limit: { type: "number", description: "Máximo. Padrão: 20." } }, required: ["query"] },
      },
      {
        name: "search_vault_smart",
        description: "Busca semântica via Smart Connections (precisa do plugin instalado e indexado).",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "Consulta em linguagem natural." }, limit: { type: "number", description: "Máximo. Padrão: 10." } }, required: ["query"] },
      },
      {
        name: "get_active_file",
        description: "Retorna o caminho e o conteúdo da nota aberta no editor.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "update_active_file",
        description: "Sobrescreve o conteúdo da nota aberta no editor.",
        inputSchema: { type: "object", properties: { content: { type: "string", description: "Novo conteúdo." } }, required: ["content"] },
      },
      {
        name: "append_to_active_file",
        description: "Adiciona conteúdo ao final da nota aberta no editor.",
        inputSchema: { type: "object", properties: { content: { type: "string", description: "Conteúdo a anexar." } }, required: ["content"] },
      },
      {
        name: "patch_active_file",
        description: "Insere/substitui conteúdo na nota ativa relativo a heading, bloco (^id) ou frontmatter.",
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string", description: "'append', 'prepend' ou 'replace'. Padrão: 'append'." },
            targetType: { type: "string", description: "'heading', 'block' ou 'frontmatter'." },
            target: { type: "string", description: "Cabeçalho, id do bloco (sem ^) ou chave do frontmatter." },
            content: { type: "string", description: "Conteúdo." },
          },
          required: ["targetType", "target", "content"],
        },
      },
      {
        name: "delete_active_file",
        description: "Move a nota ativa para a lixeira (ou exclui). Use com cautela.",
        inputSchema: { type: "object", properties: { permanent: { type: "boolean", description: "Excluir permanentemente. Padrão: false." } } },
      },
      {
        name: "show_file_in_obsidian",
        description: "Abre um arquivo no editor do Obsidian.",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Caminho." }, newLeaf: { type: "boolean", description: "Nova aba. Padrão: false." } }, required: ["path"] },
      },
      {
        name: "fetch",
        description: "Busca o conteúdo de uma URL na web e retorna o texto (HTML/JSON/Markdown).",
        inputSchema: { type: "object", properties: { url: { type: "string", description: "URL (https)." }, maxLength: { type: "number", description: "Máx. de caracteres. Padrão: 20000." } }, required: ["url"] },
      },
      {
        name: "execute_template",
        description: "Executa um template do Templater e retorna o resultado (ou grava em uma nota). Precisa do Templater instalado.",
        inputSchema: {
          type: "object",
          properties: {
            templatePath: { type: "string", description: "Caminho do template no vault." },
            targetPath: { type: "string", description: "Opcional: nota a criar com o resultado." },
          },
          required: ["templatePath"],
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
        case "get_server_info":
          result = await this.toolGetServerInfo(args);
          break;
        case "list_vault_files":
          result = await this.toolListVaultFiles(args);
          break;
        case "get_vault_file":
          result = await this.toolReadNote(args);
          break;
        case "create_vault_file":
          result = await this.toolWriteNote(args);
          break;
        case "append_to_vault_file":
          result = await this.toolAppendNote(args);
          break;
        case "patch_vault_file":
          result = await this.toolPatchFile(args, false);
          break;
        case "delete_vault_file":
          result = await this.toolDeleteFile(args, false);
          break;
        case "search_vault_simple":
          result = await this.toolSearchVault(args);
          break;
        case "search_vault_smart":
          result = await this.toolSearchSmart(args);
          break;
        case "get_active_file":
          result = await this.toolGetActiveFile(args);
          break;
        case "update_active_file":
          result = await this.toolUpdateActiveFile(args);
          break;
        case "append_to_active_file":
          result = await this.toolAppendActiveFile(args);
          break;
        case "patch_active_file":
          result = await this.toolPatchFile(args, true);
          break;
        case "delete_active_file":
          result = await this.toolDeleteFile(args, true);
          break;
        case "show_file_in_obsidian":
          result = await this.toolOpenNote(args);
          break;
        case "fetch":
          result = await this.toolFetch(args);
          break;
        case "execute_template":
          result = await this.toolExecuteTemplate(args);
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

  private async toolGetServerInfo(_args: Record<string, unknown>): Promise<object> {
    return {
      server: "obsidian-mcp-ana",
      version: "1.0.0",
      vault: this.app.vault.getName(),
      running: this.running,
      port: this.plugin.settings.serverPort,
      tools: this.getTools().length,
      externalServersConnected: this.plugin.clientManager?.getConnectedCount?.() ?? 0,
      protocol: "2024-11-05",
    };
  }

  private async toolListVaultFiles(args: Record<string, unknown>): Promise<object> {
    const folder = args.folder ? normalizePath(String(args.folder)) : "";
    const recursive = args.recursive !== false;
    const extension = args.extension ? String(args.extension) : ".md";

    const files = this.app.vault.getFiles().filter((f) => {
      if (extension && !f.path.endsWith(extension)) return false;
      if (!folder) return true;
      if (!(f.path.startsWith(folder + "/") || f.path === folder)) return false;
      if (!recursive) {
        const dir = f.path.split("/").slice(0, -1).join("/");
        return dir === folder;
      }
      return true;
    });

    return {
      folder: folder || "(raiz)",
      extension,
      count: files.length,
      files: files.map((f) => ({ path: f.path, size: f.stat.size })),
    };
  }

  private getFileOrThrow(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!file || !(file instanceof TFile)) throw new Error(`Arquivo não encontrado: ${path}`);
    return file;
  }

  private getActiveFileOrThrow(): TFile {
    const file = this.app.workspace.getActiveFile();
    if (!file) throw new Error("Nenhuma nota está aberta no editor.");
    return file;
  }

  private async toolGetActiveFile(_args: Record<string, unknown>): Promise<object> {
    const file = this.getActiveFileOrThrow();
    return { path: file.path, content: await this.app.vault.read(file) };
  }

  private async toolUpdateActiveFile(args: Record<string, unknown>): Promise<string> {
    const file = this.getActiveFileOrThrow();
    await this.app.vault.modify(file, String(args.content));
    return `✅ Nota ativa atualizada: ${file.path}`;
  }

  private async toolAppendActiveFile(args: Record<string, unknown>): Promise<string> {
    const file = this.getActiveFileOrThrow();
    const current = await this.app.vault.read(file);
    const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    await this.app.vault.modify(file, current + sep + String(args.content));
    return `✅ Conteúdo adicionado à nota ativa: ${file.path}`;
  }

  private async toolDeleteFile(args: Record<string, unknown>, active: boolean): Promise<string> {
    const file = active ? this.getActiveFileOrThrow() : this.getFileOrThrow(String(args.path));
    if (args.permanent === true) {
      await this.app.vault.delete(file);
      return `🗑️ Excluído permanentemente: ${file.path}`;
    }
    await this.app.vault.trash(file, true);
    return `🗑️ Movido para a lixeira: ${file.path}`;
  }

  private async toolFetch(args: Record<string, unknown>): Promise<object> {
    const url = String(args.url);
    if (!/^https?:\/\//i.test(url)) throw new Error("URL inválida (use http/https).");
    const maxLength = typeof args.maxLength === "number" ? args.maxLength : 20000;
    const resp = await requestUrl({ url });
    let text = resp.text ?? "";
    const truncated = text.length > maxLength;
    if (truncated) text = text.slice(0, maxLength);
    const headers = (resp.headers ?? {}) as Record<string, string>;
    return {
      url,
      status: resp.status,
      contentType: headers["content-type"] ?? headers["Content-Type"] ?? "",
      truncated,
      content: text,
    };
  }

  private async toolPatchFile(args: Record<string, unknown>, active: boolean): Promise<string> {
    const file = active ? this.getActiveFileOrThrow() : this.getFileOrThrow(String(args.path));
    const operation = (args.operation ? String(args.operation) : "append").toLowerCase();
    const targetType = String(args.targetType).toLowerCase();
    const target = String(args.target);
    const content = String(args.content);
    const original = await this.app.vault.read(file);

    let updated: string;
    if (targetType === "frontmatter") updated = this.patchFrontmatter(original, target, content, operation);
    else if (targetType === "heading") updated = this.patchHeading(original, target, content, operation);
    else if (targetType === "block") updated = this.patchBlock(original, target, content, operation);
    else throw new Error(`targetType inválido: ${targetType} (use heading, block ou frontmatter).`);

    await this.app.vault.modify(file, updated);
    return `✅ Patch (${operation} em ${targetType} '${target}'): ${file.path}`;
  }

  private patchHeading(text: string, heading: string, content: string, op: string): string {
    const lines = text.split("\n");
    const want = heading.trim().toLowerCase();
    let start = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (m && m[2].trim().toLowerCase() === want) { start = i; level = m[1].length; break; }
    }
    if (start === -1) throw new Error(`Cabeçalho não encontrado: ${heading}`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+/);
      if (m && m[1].length <= level) { end = i; break; }
    }
    if (op === "replace") {
      return [...lines.slice(0, start + 1), content, ...lines.slice(end)].join("\n");
    }
    if (op === "prepend") {
      return [...lines.slice(0, start + 1), content, ...lines.slice(start + 1)].join("\n");
    }
    const before = lines.slice(0, end);
    while (before.length && before[before.length - 1].trim() === "") before.pop();
    return [...before, content, "", ...lines.slice(end)].join("\n");
  }

  private patchBlock(text: string, blockId: string, content: string, op: string): string {
    const id = blockId.replace(/^\^/, "");
    const lines = text.split("\n");
    const idx = lines.findIndex((l) => l.includes(`^${id}`));
    if (idx === -1) throw new Error(`Bloco não encontrado: ^${id}`);
    if (op === "replace") lines[idx] = content;
    else if (op === "prepend") lines.splice(idx, 0, content);
    else lines.splice(idx + 1, 0, content);
    return lines.join("\n");
  }

  private patchFrontmatter(text: string, key: string, value: string, op: string): string {
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
    let fmLines: string[] = [];
    let body = text;
    if (fmMatch) { fmLines = fmMatch[1].split("\n"); body = text.slice(fmMatch[0].length); }
    const keyIdx = fmLines.findIndex((l) => l.startsWith(`${key}:`));
    if (keyIdx >= 0 && op === "append") fmLines[keyIdx] = `${fmLines[keyIdx].replace(/\s*$/, "")} ${value}`;
    else if (keyIdx >= 0) fmLines[keyIdx] = `${key}: ${value}`;
    else fmLines.push(`${key}: ${value}`);
    return `---\n${fmLines.join("\n")}\n---\n${body}`;
  }

  private async toolSearchSmart(args: Record<string, unknown>): Promise<object> {
    const query = String(args.query);
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const sc = (this.app as unknown as { plugins?: { plugins?: Record<string, any> } }).plugins?.plugins?.["smart-connections"];
    if (!sc) throw new Error("Plugin 'Smart Connections' não está instalado/ativo.");

    let results: any[] = [];
    if (sc.api && typeof sc.api.search === "function") {
      results = await sc.api.search(query);
    } else if (sc.env?.smart_sources?.lookup) {
      const r = await sc.env.smart_sources.lookup({ hypotheticals: [query] });
      results = Array.isArray(r) ? r : (r?.results ?? []);
    } else if (sc.env?.smart_blocks?.lookup) {
      const r = await sc.env.smart_blocks.lookup({ hypotheticals: [query] });
      results = Array.isArray(r) ? r : (r?.results ?? []);
    } else {
      throw new Error("API do Smart Connections não reconhecida nesta versão.");
    }

    const mapped = (results || []).slice(0, limit).map((r: any) => ({
      path: r?.path ?? r?.item?.path ?? r?.key ?? String(r),
      score: r?.score ?? r?.sim ?? r?.similarity,
    }));
    return { query, total: mapped.length, results: mapped };
  }

  private async toolExecuteTemplate(args: Record<string, unknown>): Promise<object> {
    const templatePath = normalizePath(String(args.templatePath));
    const targetPath = args.targetPath ? normalizePath(String(args.targetPath)) : undefined;
    const tp = (this.app as unknown as { plugins?: { plugins?: Record<string, any> } }).plugins?.plugins?.["templater-obsidian"];
    if (!tp) throw new Error("Plugin 'Templater' não está instalado/ativo.");

    const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
    if (!templateFile || !(templateFile instanceof TFile)) throw new Error(`Template não encontrado: ${templatePath}`);

    const templater = tp.templater;
    let rendered = "";
    if (typeof templater?.read_and_parse_template === "function") {
      rendered = await templater.read_and_parse_template({ template_file: templateFile, target_file: templateFile });
    } else if (typeof templater?.parse_template === "function") {
      const raw = await this.app.vault.read(templateFile);
      rendered = await templater.parse_template({ template_file: templateFile, target_file: templateFile }, raw);
    } else {
      throw new Error("API do Templater não reconhecida nesta versão.");
    }

    if (targetPath) {
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, rendered);
      } else {
        const dir = targetPath.split("/").slice(0, -1).join("/");
        if (dir) await this.ensureFolder(dir);
        await this.app.vault.create(targetPath, rendered);
      }
      return { templatePath, targetPath, written: true, length: rendered.length };
    }
    return { templatePath, rendered };
  }

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
