/**
 * McpClientManager.ts
 *
 * Gerencia conexões a servidores MCP externos (PJe, DataJud, etc.)
 * via transporte SSE (Server-Sent Events).
 *
 * Os resultados de tool calls externos podem ser:
 *  1. Injetados como notas Markdown no vault
 *  2. Retornados diretamente para uso programático
 */

import { App, normalizePath, TFile } from "obsidian";
import McpBridgePlugin, { ExternalServer } from "../src/main";

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpClientConnection {
  server: ExternalServer;
  tools: McpToolInfo[];
  status: "connected" | "connecting" | "error" | "disconnected";
  error?: string;
  messageId: number;
  pendingRequests: Map<string | number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>;
  eventSource?: EventSource;
  postEndpoint?: string;
}

export class McpClientManager {
  private plugin: McpBridgePlugin;
  private app: App;
  private connections: Map<string, McpClientConnection> = new Map();

  constructor(plugin: McpBridgePlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  getConnectedCount(): number {
    return [...this.connections.values()].filter(c => c.status === "connected").length;
  }

  getConnections(): McpClientConnection[] {
    return [...this.connections.values()];
  }

  async connectAll(): Promise<void> {
    for (const server of this.plugin.settings.externalServers) {
      if (server.enabled) {
        await this.connect(server);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [id, conn] of this.connections) {
      this.disconnect(id);
    }
    this.connections.clear();
  }

  disconnect(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (conn?.eventSource) {
      conn.eventSource.close();
    }
    this.connections.delete(serverId);
  }

  async connect(server: ExternalServer): Promise<void> {
    if (this.connections.has(server.id)) {
      this.disconnect(server.id);
    }

    const conn: McpClientConnection = {
      server,
      tools: [],
      status: "connecting",
      messageId: 0,
      pendingRequests: new Map(),
    };
    this.connections.set(server.id, conn);

    try {
      await this.establishSseConnection(conn);
    } catch (err) {
      conn.status = "error";
      conn.error = String(err);
      this.plugin.log(`Erro ao conectar em ${server.name}: ${err}`);
    }
  }

  private async establishSseConnection(conn: McpClientConnection): Promise<void> {
    const { server } = conn;
    const sseUrl = server.authToken
      ? `${server.url}?token=${encodeURIComponent(server.authToken)}`
      : server.url;

    return new Promise((resolve, reject) => {
      const es = new EventSource(sseUrl);
      conn.eventSource = es;

      const timeout = setTimeout(() => {
        es.close();
        reject(new Error(`Timeout conectando a ${server.name}`));
      }, 15000);

      es.addEventListener("endpoint", async (event: MessageEvent) => {
        clearTimeout(timeout);
        try {
          // Some MCP servers send the POST endpoint URL via this event
          const data = JSON.parse(event.data);
          conn.postEndpoint = data.uri || data.endpoint || server.url.replace("/sse", "/mcp");
          conn.status = "connected";
          this.plugin.log(`Conectado a: ${server.name}`);

          // Initialize the connection
          await this.sendRequest(conn, "initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "obsidian-mcp-bridge", version: "1.0.0" },
          });

          // List available tools
          const toolsResult = await this.sendRequest(conn, "tools/list", {}) as { tools: McpToolInfo[] };
          conn.tools = toolsResult?.tools ?? [];
          this.plugin.log(`${server.name}: ${conn.tools.length} tools disponíveis`);

          resolve();
        } catch (err) {
          reject(err);
        }
      });

      es.addEventListener("message", (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id !== undefined) {
            const pending = conn.pendingRequests.get(msg.id);
            if (pending) {
              conn.pendingRequests.delete(msg.id);
              if (msg.error) {
                pending.reject(new Error(msg.error.message));
              } else {
                pending.resolve(msg.result);
              }
            }
          }
        } catch {
          // ignore parse errors
        }
      });

      es.onerror = () => {
        clearTimeout(timeout);
        conn.status = "error";
        conn.error = "Conexão SSE perdida";
        // Auto-reconnect after 30s
        setTimeout(() => {
          if (conn.server.enabled) {
            this.plugin.log(`Tentando reconectar a ${server.name}...`);
            this.connect(server);
          }
        }, 30000);
      };
    });
  }

  async sendRequest(
    conn: McpClientConnection,
    method: string,
    params: unknown
  ): Promise<unknown> {
    const id = ++conn.messageId;
    const msg = { jsonrpc: "2.0", id, method, params };

    const postUrl = conn.postEndpoint ?? conn.server.url.replace("/sse", "/mcp");

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (conn.server.authToken) {
      headers["Authorization"] = `Bearer ${conn.server.authToken}`;
    }

    return new Promise(async (resolve, reject) => {
      conn.pendingRequests.set(id, { resolve, reject });

      try {
        const response = await fetch(postUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(msg),
        });

        if (!response.ok) {
          conn.pendingRequests.delete(id);
          reject(new Error(`HTTP ${response.status}: ${await response.text()}`));
          return;
        }

        // Some servers respond directly (not via SSE)
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await response.json();
          conn.pendingRequests.delete(id);
          if (data.error) {
            reject(new Error(data.error.message));
          } else {
            resolve(data.result);
          }
        }
        // Otherwise, wait for the SSE message with this id
      } catch (err) {
        conn.pendingRequests.delete(id);
        reject(err);
      }

      // Timeout for pending request
      setTimeout(() => {
        if (conn.pendingRequests.has(id)) {
          conn.pendingRequests.delete(id);
          reject(new Error(`Timeout aguardando resposta do método ${method}`));
        }
      }, 30000);
    });
  }

  /**
   * Chama uma tool em um servidor externo e opcionalmente injeta resultado no vault.
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      injectToVault?: boolean;
      notePath?: string;
    }
  ): Promise<unknown> {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== "connected") {
      throw new Error(`Servidor ${serverId} não está conectado.`);
    }

    const result = await this.sendRequest(conn, "tools/call", {
      name: toolName,
      arguments: args,
    });

    if (options?.injectToVault && this.plugin.settings.injectResultsToVault) {
      await this.injectToVault(conn.server, toolName, args, result, options.notePath);
    }

    return result;
  }

  /**
   * Lista todas as tools disponíveis em todos os servidores conectados.
   */
  getAllTools(): { serverId: string; serverName: string; tool: McpToolInfo }[] {
    const result: { serverId: string; serverName: string; tool: McpToolInfo }[] = [];
    for (const [serverId, conn] of this.connections) {
      if (conn.status === "connected") {
        for (const tool of conn.tools) {
          result.push({ serverId, serverName: conn.server.name, tool });
        }
      }
    }
    return result;
  }

  private async injectToVault(
    server: ExternalServer,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    customPath?: string
  ): Promise<void> {
    try {
      const folder = this.plugin.settings.injectFolder;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const fileName = customPath ?? `${folder}/${server.name}/${toolName}-${timestamp}.md`;
      const path = normalizePath(fileName);

      const content = [
        `---`,
        `source: ${server.name}`,
        `tool: ${toolName}`,
        `args: ${JSON.stringify(args)}`,
        `timestamp: ${new Date().toISOString()}`,
        `---`,
        ``,
        `# Resultado: ${toolName}`,
        `**Servidor:** ${server.name}  `,
        `**Argumentos:** \`${JSON.stringify(args)}\`  `,
        `**Data:** ${new Date().toLocaleString("pt-BR")}`,
        ``,
        `## Conteúdo`,
        ``,
        this.formatResult(result),
      ].join("\n");

      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir) await this.ensureFolder(dir);
        await this.app.vault.create(path, content);
      }
    } catch (err) {
      this.plugin.log(`Erro ao injetar resultado no vault: ${err}`);
    }
  }

  private formatResult(result: unknown): string {
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
      const r = result as { content?: { type: string; text: string }[] };
      if (Array.isArray(r.content)) {
        return r.content
          .filter(c => c.type === "text")
          .map(c => c.text)
          .join("\n\n");
      }
    }
    return JSON.stringify(result, null, 2);
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current).catch(() => {});
      }
    }
  }
}
