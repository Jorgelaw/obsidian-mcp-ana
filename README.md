# Obsidian MCP ANA

Plugin para Obsidian que funciona como **servidor MCP** (expõe o vault) **e cliente MCP** (conecta a servidores externos como MCP ANA PJe, DataJud, etc.) simultaneamente. Compatível com Claude Desktop, Claude Code e qualquer cliente MCP.

---

## O que é MCP?

Model Context Protocol (MCP) é o protocolo aberto da Anthropic para conectar LLMs (como Claude) a ferramentas e dados externos. Este plugin substitui o `mcp-obsidian` (descontinuado) com funcionalidades adicionais.

---

## Instalação

### Via BRAT (recomendado)
1. Instale o plugin **BRAT** (Obsidian42 - BRAT) pela comunidade.
2. **Configurações → BRAT → Add Beta Plugin** → cole: `https://github.com/Jorgelaw/obsidian-mcp-ana`
3. Ative o **"MCP ANA"** em Plugins da comunidade.

### Manual
Baixe `main.js`, `manifest.json` e `styles.css` (da release ou do repositório) e coloque em `.obsidian/plugins/obsidian-mcp-ana/`. Em seguida, ative o **"MCP ANA"**.

### Desenvolvimento
```bash
cd /caminho/do/vault/.obsidian/plugins/
git clone https://github.com/Jorgelaw/obsidian-mcp-ana
cd obsidian-mcp-ana
npm install
npm run build
```

---

## Configuração

### Servidor MCP Local (vault → Claude)

Após ativar, o servidor inicia automaticamente em `http://localhost:27123`.

**Claude Desktop** (`claude_desktop_config.json`) — use o transporte via `mcp-remote`:
```json
{
  "mcpServers": {
    "obsidian-mcp-ana": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:27123/sse"]
    }
  }
}
```

> O servidor implementa o transporte MCP HTTP+SSE (evento `endpoint` + respostas pelo stream SSE), compatível com `mcp-remote` e demais clientes MCP.

### Servidores Externos (Obsidian → PJe/DataJud)

Em **Configurações → MCP ANA → Servidores MCP Externos**:

1. Clique em **+ Adicionar** ou use um preset (MCP ANA PJe, MCP Nacional)
2. Insira a URL SSE e o token de autenticação
3. Ative o toggle do servidor

Os resultados podem ser injetados automaticamente como notas Markdown na pasta configurada (padrão: `_mcp-results/`).

---

## Ferramentas (26)

**Notas e vault**

| Tool | Descrição |
|------|-----------|
| `read_note` / `get_vault_file` | Lê o conteúdo de uma nota |
| `write_note` / `create_vault_file` | Cria ou sobrescreve uma nota |
| `append_note` / `append_to_vault_file` | Adiciona texto ao final de uma nota |
| `patch_vault_file` | Insere/substitui relativo a heading, bloco (^id) ou frontmatter |
| `delete_vault_file` | Move um arquivo para a lixeira (ou exclui) |
| `list_files` / `list_vault_files` | Lista arquivos/pastas do vault |
| `get_metadata` | Retorna frontmatter e metadados |
| `open_note` / `show_file_in_obsidian` | Abre uma nota no editor |
| `run_command` / `list_commands` | Executa/lista comandos do Obsidian |

**Busca**

| Tool | Descrição |
|------|-----------|
| `search_vault` / `search_vault_simple` | Busca textual no vault |
| `search_vault_smart` | Busca semântica (via Smart Connections) |

**Nota ativa (editor)**

| Tool | Descrição |
|------|-----------|
| `get_active_file` | Lê a nota aberta no editor |
| `update_active_file` | Sobrescreve a nota ativa |
| `append_to_active_file` | Adiciona ao final da nota ativa |
| `patch_active_file` | Patch na nota ativa (heading/bloco/frontmatter) |
| `delete_active_file` | Move a nota ativa para a lixeira |

**Outras**

| Tool | Descrição |
|------|-----------|
| `get_server_info` | Informações do servidor (vault, tools, porta) |
| `fetch` | Busca o conteúdo de uma URL na web |
| `execute_template` | Executa um template do Templater |

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
| `/mcp` | POST | JSON-RPC (com `?sessionId=` no transporte SSE) |

---

## Segurança

- O servidor escuta apenas em `127.0.0.1` (loopback) — não exposto à rede
- Token Bearer opcional para autenticação
- Para uso remoto, configure um túnel seguro (ex: Cloudflare Tunnel)

---

## Estrutura do projeto

```
obsidian-mcp-ana/
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
