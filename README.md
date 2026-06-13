# Obsidian MCP Bridge

Plugin para Obsidian que funciona como **servidor MCP** (expõe o vault) **e cliente MCP** (conecta a servidores externos como MCP ANA PJe, DataJud, etc.) simultaneamente.

---

## O que é MCP?

Model Context Protocol (MCP) é o protocolo aberto da Anthropic para conectar LLMs (como Claude) a ferramentas e dados externos. Este plugin substitui o `mcp-obsidian` (descontinuado) com funcionalidades adicionais.

---

## Instalação (desenvolvimento)

### Pré-requisitos
- Node.js 18+
- Obsidian 1.4+

### Passos

```bash
# 1. Clone na pasta de plugins do vault
cd /caminho/do/vault/.obsidian/plugins/
git clone <repo> obsidian-mcp-bridge
cd obsidian-mcp-bridge

# 2. Instale dependências
npm install

# 3. Build de desenvolvimento (com hot-reload)
npm run dev

# 4. No Obsidian: Configurações → Plugins da comunidade → Ativar "MCP Bridge"
```

---

## Configuração

### Servidor MCP Local (vault → Claude)

Após ativar, o servidor inicia automaticamente em `http://localhost:27123`.

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "url": "http://localhost:27123/sse"
    }
  }
}
```

**Claude Code** (`.claude/settings.json` ou via CLI):
```json
{
  "mcpServers": {
    "obsidian": {
      "type": "sse",
      "url": "http://localhost:27123/sse"
    }
  }
}
```

### Servidores Externos (Obsidian → PJe/DataJud)

Em **Configurações → MCP Bridge → Servidores MCP Externos**:

1. Clique em **+ Adicionar** ou use um preset (MCP ANA PJe, MCP Nacional)
2. Insira a URL SSE e o token de autenticação
3. Ative o toggle do servidor

Os resultados podem ser injetados automaticamente como notas Markdown na pasta configurada (padrão: `_mcp-results/`).

---

## Tools disponíveis (vault → Claude)

| Tool | Descrição |
|------|-----------|
| `read_note` | Lê o conteúdo de uma nota |
| `write_note` | Cria ou sobrescreve uma nota |
| `append_note` | Adiciona texto ao final de uma nota |
| `list_files` | Lista arquivos/pastas do vault |
| `search_vault` | Busca full-text no vault |
| `get_metadata` | Retorna frontmatter e metadados |
| `open_note` | Abre uma nota no editor |
| `run_command` | Executa comando Obsidian pelo ID |
| `list_commands` | Lista comandos disponíveis |

---

## Integração com Projeto ANA (TJMA)

Este plugin foi projetado para funcionar no ecossistema ANA do TJMA:

```
Claude Code / Claude Desktop
         ↕ (MCP)
   Obsidian Vault (este plugin)
         ↕ (MCP client)
   MCP ANA PJe / MCP Nacional
         ↕
      PJe TJMA
```

**Exemplo de uso:**
1. Claude lê uma nota de análise do vault (`read_note`)
2. Claude consulta o PJe via MCP ANA PJe embutido no cliente externo
3. Claude escreve a minuta de volta no vault (`write_note`)

---

## Endpoints HTTP

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/health` | GET | Status do servidor |
| `/sse` | GET | Transporte SSE para clientes MCP |
| `/mcp` | POST | JSON-RPC para chamadas diretas |

---

## Segurança

- O servidor escuta apenas em `127.0.0.1` (loopback) — não exposto à rede
- Token Bearer opcional para autenticação
- Para uso remoto, configure um túnel seguro (ex: Cloudflare Tunnel)

---

## Estrutura do projeto

```
obsidian-mcp-bridge/
├── src/
│   └── main.ts              # Entry point do plugin
├── server/
│   └── McpServer.ts         # Servidor MCP HTTP/SSE
├── client/
│   └── McpClientManager.ts  # Cliente para servidores externos
├── settings/
│   └── SettingTab.ts        # UI de configurações
├── styles.css
├── manifest.json
├── package.json
└── tsconfig.json
```

---

## Licença

MIT — ToadaLab / TJMA
