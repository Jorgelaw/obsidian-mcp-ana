/**
 * SettingTab.ts
 * 
 * Interface de configuração do plugin MCP Bridge no Obsidian.
 * Permite configurar:
 *  - Porta e token do servidor MCP local
 *  - Servidores MCP externos (PJe, DataJud, etc.)
 *  - Opções de injeção de resultados no vault
 */

import {
  App,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  ButtonComponent,
} from "obsidian";
import McpBridgePlugin, { ExternalServer } from "../src/main";

export class MpcBridgeSettingTab extends PluginSettingTab {
  plugin: McpBridgePlugin;

  constructor(app: App, plugin: McpBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Header ────────────────────────────────────────────────────────────────
    containerEl.createEl("h1", { text: "MCP Bridge" });
    containerEl.createEl("p", {
      text: "Expõe seu vault como servidor MCP e conecta a servidores externos (PJe, DataJud, etc.)",
      cls: "setting-item-description",
    });

    // ── Servidor Local ────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "🖥️ Servidor MCP Local" });

    new Setting(containerEl)
      .setName("Servidor ativo")
      .setDesc("Expõe o vault como servidor MCP. Reinicie o plugin após alterar.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.serverEnabled)
          .onChange(async v => {
            this.plugin.settings.serverEnabled = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Porta")
      .setDesc("Porta HTTP do servidor MCP local. Padrão: 27123.")
      .addText(text =>
        text
          .setPlaceholder("27123")
          .setValue(String(this.plugin.settings.serverPort))
          .onChange(async v => {
            const port = parseInt(v);
            if (port > 1024 && port < 65535) {
              this.plugin.settings.serverPort = port;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Token de autenticação")
      .setDesc("Token Bearer para proteger o servidor. Deixe vazio para acesso local sem autenticação.")
      .addText(text =>
        text
          .setPlaceholder("Deixe vazio para sem autenticação")
          .setValue(this.plugin.settings.serverAuthToken)
          .onChange(async v => {
            this.plugin.settings.serverAuthToken = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Status do servidor")
      .setDesc("Verifique se o servidor está respondendo.")
      .addButton(btn =>
        btn
          .setButtonText("Testar")
          .setCta()
          .onClick(async () => {
            try {
              const port = this.plugin.settings.serverPort;
              const resp = await fetch(`http://localhost:${port}/health`);
              const data = await resp.json();
              new Notice(`✅ Servidor OK\nVault: ${data.vault}\nTools: ${data.tools}`, 5000);
            } catch {
              new Notice("❌ Servidor não está respondendo.", 5000);
            }
          })
      );

    new Setting(containerEl)
      .setName("Configuração para Claude Desktop")
      .setDesc("Clique para copiar a configuração MCP para usar no Claude Desktop.")
      .addButton(btn =>
        btn.setButtonText("Copiar JSON").onClick(async () => {
          const port = this.plugin.settings.serverPort;
          const token = this.plugin.settings.serverAuthToken;
          const config = {
            mcpServers: {
              obsidian: {
                command: "node",
                args: ["-e", `
                  const http = require('http');
                  const EventSource = require('eventsource');
                  // SSE proxy for Claude Desktop
                `],
                env: {
                  MCP_SSE_URL: `http://localhost:${port}/sse${token ? `?token=${token}` : ""}`,
                },
              },
            },
          };
          // Simpler config for HTTP transport (newer Claude Desktop versions)
          const simpleConfig = {
            mcpServers: {
              "obsidian-vault": {
                url: `http://localhost:${port}/sse${token ? `?token=${token}` : ""}`,
              },
            },
          };
          await navigator.clipboard.writeText(JSON.stringify(simpleConfig, null, 2));
          new Notice("✅ Configuração copiada! Cole em claude_desktop_config.json", 4000);
        })
      );

    // ── Servidores Externos ────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "🔌 Servidores MCP Externos" });
    containerEl.createEl("p", {
      text: "Conecte o Obsidian a servidores MCP externos. Os resultados podem ser injetados como notas no vault.",
      cls: "setting-item-description",
    });

    // List existing servers
    for (const server of this.plugin.settings.externalServers) {
      this.renderExternalServer(containerEl, server);
    }

    // Add server button
    new Setting(containerEl)
      .setName("Adicionar servidor")
      .addButton(btn =>
        btn
          .setButtonText("+ Adicionar")
          .setCta()
          .onClick(() => {
            new AddServerModal(this.app, this.plugin, () => this.display()).open();
          })
      );

    // Preset servers
    new Setting(containerEl)
      .setName("Servidores predefinidos")
      .setDesc("Adicione rapidamente servidores do ecossistema ANA/TJMA.")
      .addButton(btn =>
        btn.setButtonText("MCP ANA PJe").onClick(async () => {
          await this.addPreset({
            id: "mcp-ana-pje",
            name: "MCP ANA PJe",
            url: "https://mcpana.tjma.jus.br/sse/",
            enabled: false,
            description: "Servidor MCP do Projeto ANA — acesso ao PJe TJMA",
          });
        })
      )
      .addButton(btn =>
        btn.setButtonText("MCP Nacional").onClick(async () => {
          await this.addPreset({
            id: "mcp-nacional",
            name: "MCP Nacional",
            url: "https://srv1630577.hstgr.cloud/sse",
            enabled: false,
            description: "Servidor MCP Nacional — DataJud/CNJ",
          });
        })
      );

    // ── Injeção no Vault ───────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "📥 Injeção de Resultados no Vault" });

    new Setting(containerEl)
      .setName("Injetar resultados no vault")
      .setDesc("Quando uma tool externa for chamada, salva o resultado como nota Markdown.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.injectResultsToVault)
          .onChange(async v => {
            this.plugin.settings.injectResultsToVault = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Pasta de injeção")
      .setDesc("Pasta onde os resultados externos serão salvos. Ex: _mcp-results")
      .addText(text =>
        text
          .setPlaceholder("_mcp-results")
          .setValue(this.plugin.settings.injectFolder)
          .onChange(async v => {
            this.plugin.settings.injectFolder = v;
            await this.plugin.saveSettings();
          })
      );

    // ── Debug ─────────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "⚙️ Avançado" });

    new Setting(containerEl)
      .setName("Modo debug")
      .setDesc("Exibe logs detalhados no console do desenvolvedor.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async v => {
            this.plugin.settings.debugMode = v;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderExternalServer(containerEl: HTMLElement, server: ExternalServer): void {
    const conn = this.plugin.clientManager.getConnections().find(c => c.server.id === server.id);
    const statusIcon = conn?.status === "connected" ? "🟢" : conn?.status === "connecting" ? "🟡" : "🔴";
    const toolCount = conn?.tools?.length ?? 0;

    const setting = new Setting(containerEl)
      .setName(`${statusIcon} ${server.name}`)
      .setDesc(`${server.url}${toolCount > 0 ? ` • ${toolCount} tools` : ""}`)
      .addToggle(toggle =>
        toggle.setValue(server.enabled).onChange(async v => {
          server.enabled = v;
          await this.plugin.saveSettings();
          if (v) {
            await this.plugin.clientManager.connect(server);
          } else {
            this.plugin.clientManager.disconnect(server.id);
          }
          this.display();
        })
      )
      .addButton(btn =>
        btn.setIcon("pencil").setTooltip("Editar").onClick(() => {
          new AddServerModal(this.app, this.plugin, () => this.display(), server).open();
        })
      )
      .addButton(btn =>
        btn.setIcon("trash").setTooltip("Remover").onClick(async () => {
          this.plugin.settings.externalServers = this.plugin.settings.externalServers.filter(
            s => s.id !== server.id
          );
          this.plugin.clientManager.disconnect(server.id);
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }

  private async addPreset(preset: ExternalServer): Promise<void> {
    const exists = this.plugin.settings.externalServers.find(s => s.id === preset.id);
    if (exists) {
      new Notice(`Servidor "${preset.name}" já adicionado.`);
      return;
    }
    this.plugin.settings.externalServers.push(preset);
    await this.plugin.saveSettings();
    new Notice(`✅ "${preset.name}" adicionado. Insira o token e ative-o.`);
    this.display();
  }
}

class AddServerModal extends Modal {
  plugin: McpBridgePlugin;
  onSuccess: () => void;
  editing?: ExternalServer;

  constructor(
    app: App,
    plugin: McpBridgePlugin,
    onSuccess: () => void,
    editing?: ExternalServer
  ) {
    super(app);
    this.plugin = plugin;
    this.onSuccess = onSuccess;
    this.editing = editing;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: this.editing ? "Editar servidor MCP" : "Adicionar servidor MCP" });

    const draft: Partial<ExternalServer> = this.editing
      ? { ...this.editing }
      : { enabled: true };

    new Setting(contentEl).setName("Nome").addText(t =>
      t.setPlaceholder("Ex: MCP ANA PJe").setValue(draft.name ?? "").onChange(v => (draft.name = v))
    );

    new Setting(contentEl).setName("URL SSE").setDesc("Endpoint SSE do servidor.").addText(t =>
      t
        .setPlaceholder("https://mcpana.tjma.jus.br/sse/TOKEN")
        .setValue(draft.url ?? "")
        .onChange(v => (draft.url = v))
    );

    new Setting(contentEl)
      .setName("Token de autenticação")
      .setDesc("Bearer token, se necessário. Opcional.")
      .addText(t =>
        t.setPlaceholder("Opcional").setValue(draft.authToken ?? "").onChange(v => (draft.authToken = v))
      );

    new Setting(contentEl).setName("Descrição").addText(t =>
      t.setValue(draft.description ?? "").onChange(v => (draft.description = v))
    );

    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText(this.editing ? "Salvar" : "Adicionar")
          .setCta()
          .onClick(async () => {
            if (!draft.name || !draft.url) {
              new Notice("Nome e URL são obrigatórios.");
              return;
            }

            if (this.editing) {
              Object.assign(this.editing, draft);
            } else {
              draft.id = Date.now().toString();
              this.plugin.settings.externalServers.push(draft as ExternalServer);
            }

            await this.plugin.saveSettings();
            this.close();
            this.onSuccess();
          })
      )
      .addButton(btn =>
        btn.setButtonText("Cancelar").onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
