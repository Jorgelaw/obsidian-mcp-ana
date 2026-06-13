import { Plugin, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { McpServer } from "../server/McpServer";
import { McpClientManager } from "../client/McpClientManager";
import { MpcBridgeSettingTab } from "../settings/SettingTab";

export interface ExternalServer {
  id: string;
  name: string;
  url: string;           // SSE endpoint, ex: https://mcpana.tjma.jus.br/sse/TOKEN
  enabled: boolean;
  authToken?: string;
  description?: string;
}

export interface McpBridgeSettings {
  serverPort: number;
  serverEnabled: boolean;
  serverAuthToken: string;
  allowedOrigins: string;
  externalServers: ExternalServer[];
  injectResultsToVault: boolean;
  injectFolder: string;
  debugMode: boolean;
}

const DEFAULT_SETTINGS: McpBridgeSettings = {
  serverPort: 27123,
  serverEnabled: true,
  serverAuthToken: "",
  allowedOrigins: "http://localhost:*,app://obsidian.md",
  externalServers: [],
  injectResultsToVault: true,
  injectFolder: "_mcp-results",
  debugMode: false,
};

export default class McpBridgePlugin extends Plugin {
  settings: McpBridgeSettings;
  mcpServer: McpServer;
  clientManager: McpClientManager;

  async onload() {
    await this.loadSettings();

    this.mcpServer = new McpServer(this);
    this.clientManager = new McpClientManager(this);

    // Start MCP server if enabled
    if (this.settings.serverEnabled) {
      await this.mcpServer.start();
    }

    // Connect to external MCP servers
    await this.clientManager.connectAll();

    // Settings tab
    this.addSettingTab(new MpcBridgeSettingTab(this.app, this));

    // Ribbon icon
    const ribbonIcon = this.addRibbonIcon(
      "network",
      "MCP Bridge",
      () => this.showStatusModal()
    );
    ribbonIcon.addClass("mcp-bridge-ribbon");

    // Commands
    this.addCommand({
      id: "mcp-bridge-status",
      name: "Mostrar status do MCP Bridge",
      callback: () => this.showStatusModal(),
    });

    this.addCommand({
      id: "mcp-bridge-restart-server",
      name: "Reiniciar servidor MCP",
      callback: async () => {
        await this.mcpServer.stop();
        await this.mcpServer.start();
        new Notice("Servidor MCP reiniciado na porta " + this.settings.serverPort);
      },
    });

    this.addCommand({
      id: "mcp-bridge-reconnect-clients",
      name: "Reconectar servidores MCP externos",
      callback: async () => {
        await this.clientManager.disconnectAll();
        await this.clientManager.connectAll();
        new Notice("Reconectando servidores externos...");
      },
    });

    this.log("MCP Bridge carregado.");
  }

  async onunload() {
    await this.mcpServer.stop();
    await this.clientManager.disconnectAll();
    this.log("MCP Bridge descarregado.");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  log(msg: string, ...args: unknown[]) {
    if (this.settings.debugMode) {
      console.log(`[MCP Bridge] ${msg}`, ...args);
    }
  }

  showStatusModal() {
    const serverStatus = this.mcpServer?.isRunning()
      ? `✅ Servidor ativo na porta ${this.settings.serverPort}`
      : "❌ Servidor inativo";

    const connectedClients = this.clientManager?.getConnectedCount() ?? 0;
    const totalClients = this.settings.externalServers.filter(s => s.enabled).length;

    new Notice(
      `MCP Bridge\n${serverStatus}\n🔌 Clientes: ${connectedClients}/${totalClients} conectados`,
      8000
    );
  }
}
