"use strict";

// =============================================================================
// ASSISTENTE PELA ASSINATURA CLAUDE DA EMPRESA (Claude Code), SEM API PAGA
// =============================================================================
//
// Mesma estrutura do RodMac (D:\10-LuMac\calc\assistente_assinatura.py):
// cada pergunta roda um `claude -p` logado na assinatura da empresa neste PC,
// com as ferramentas embutidas desligadas (--tools ""), so o servidor MCP do
// programa (--strict-mcp-config) e as instrucoes do assistente no lugar do
// prompt padrao. A conversa continua com --resume.
//
// As variaveis de chave (ANTHROPIC_API_KEY etc.) sao retiradas do ambiente:
// sem elas o Claude Code usa o login da assinatura e nunca a API paga.
// =============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const RAIZ = path.resolve(__dirname, "..", "..");
const TEMPO_LIMITE_MS = 10 * 60 * 1000;
const VARIAVEIS_FORA = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];
const PISTAS_LIMITE = ["usage limit", "session limit", "weekly limit", "limit reached", "hit your", "out of extra usage", "rate limit"];
const PISTAS_LOGIN = ["/login", "not logged in", "invalid api key", "oauth token", "authentication", "please run"];

const MSG_SEM_CLI = "O Claude Code não foi encontrado neste PC. Instale-o e entre com a conta da empresa (vmacprocessamento).";
const MSG_LIMITE = "Acabou o limite de uso da assinatura Claude por enquanto. O assistente volta quando o limite renovar (o resto do programa segue normal).";
const MSG_LOGIN = "O Claude Code deste PC está sem login. Abra um terminal, rode `claude` e entre com a conta da empresa.";

const SISTEMA = `Você é o Assistente da Central de Despesas da VMac Engenharia (programa que lê as notas de despesa que os operadores de campo mandam no WhatsApp e prepara os lançamentos no Conta Azul).
Quem conversa com você: o Yan (responsável pelo programa), o Jhonathan (supervisor), a Vanessa (financeiro) e o Cauã. Responda em português do Brasil, direto e curto, com números em R$ no formato brasileiro.

Regras:
- Use SÓ as ferramentas do programa (servidor "vmac") para saber qualquer número, nota, cadastro ou situação. Nunca invente valores, datas ou nomes; se a ferramenta não trouxer, diga que não há o dado.
- Diga sempre de que fonte veio um total: "notas da Central" (WhatsApp desde 11/10/2026) ou "planilha do Conta Azul" (meses anteriores).
- Lançar no Conta Azul: só quando a pessoa pedir explicitamente. Use preparar_lancamento; isso NÃO lança, só mostra um botão Confirmar. Diga isso à pessoa. Não aprove, não corrija e não descarte notas: isso é feito na Central.
- Treinar a IA: só quando a pessoa pedir. Use treinar_ia; também vira um botão Confirmar.
- Se a pessoa der uma ideia de melhoria ou relatar um problema do programa, anote com registrar_sugestao e avise que anotou.
- Nunca mostre telefones nem dados pessoais além do nome.
- Tabelas pequenas em Markdown são bem-vindas para relatórios.
- Responda do mais genérico ao mais específico: veículo (km, consumo, gasto) use "veiculos"; gastos use "relatorio_gastos"; se nenhuma ferramenta pronta servir, use "consulta_livre" (SQL só de leitura) antes de dizer que não dá.
- Se a pessoa pedir uma capacidade nova que vai se repetir, ou pedir para você "aprender" a responder algo: teste a consulta com "consulta_livre" e proponha "criar_habilidade" (vira botão Confirmar). Habilidades criadas aparecem como ferramentas h_<nome>.
- Mudança no programa que consulta não resolve (tela nova, regra nova da IA): anote com "registrar_sugestao" como pedido para o Yan/Claude implementarem.`;

/** Caminho do Claude Code: config, binario nativo do npm, extensao do VS Code ou PATH. */
function localizarClaude(configurado = "") {
    if (configurado) return fs.existsSync(configurado) ? configurado : "";
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const candidatos = [
        path.join(appdata, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
        path.join(os.homedir(), ".local", "bin", "claude.exe"),
    ];
    const extensoes = path.join(os.homedir(), ".vscode", "extensions");
    if (fs.existsSync(extensoes)) {
        for (const nome of fs.readdirSync(extensoes).filter((n) => n.startsWith("anthropic.claude-code-")).sort().reverse()) {
            candidatos.push(path.join(extensoes, nome, "resources", "native-binary", "claude.exe"));
        }
    }
    return candidatos.find((caminho) => fs.existsSync(caminho)) || "";
}

/** Linha de comando do `claude -p` (sem shell: os argumentos vao exatos). */
function comando({ configMcp, sessao = null, modelo = "", esforco = "" }) {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--tools", "", "--strict-mcp-config", "--mcp-config", configMcp, "--allowedTools", "mcp__vmac",
        "--system-prompt", SISTEMA, "--permission-mode", "default"];
    if (modelo) args.push("--model", modelo);
    if (esforco) args.push("--effort", esforco);
    if (sessao) args.push("--resume", sessao);
    return args;
}

/** Traduz o stream-json do Claude Code em eventos para a tela. */
class LeitorEventos {
    constructor(emitir) {
        this.emitir = emitir;
        this.sessao = null;
        this.resultado = null;
        this.outras = [];
    }

    ler(linha) {
        let evento;
        try { evento = JSON.parse(linha); } catch (_) {
            if (linha.trim()) this.outras.push(linha.trim());
            return;
        }
        const tipo = evento.type;
        if (tipo === "system" && evento.subtype === "init") {
            this.sessao = evento.session_id || this.sessao;
            this.emitir({ tipo: "inicio", modelo: evento.model || "" });
        } else if (tipo === "rate_limit_event") {
            const info = evento.rate_limit_info || {};
            const janelas = info.unifiedWindows || {};
            this.emitir({ tipo: "uso_plano", status: info.status || "", janela_5h: janelas.five_hour?.utilization ?? null,
                semana: janelas.seven_day?.utilization ?? null, renova_em: info.resetsAt || null });
        } else if (tipo === "stream_event") {
            const ev = evento.event || {};
            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") this.emitir({ tipo: "texto_parcial", texto: ev.delta.text || "" });
            else if (ev.type === "content_block_start" && ev.content_block?.type === "thinking") this.emitir({ tipo: "pensando" });
        } else if (tipo === "assistant") {
            for (const bloco of evento.message?.content || []) {
                if (bloco.type === "tool_use") this.emitir({ tipo: "ferramenta", nome: String(bloco.name || "").replace(/^mcp__vmac__/, ""), entrada: bloco.input || {} });
            }
        } else if (tipo === "result") {
            this.resultado = evento;
            this.sessao = evento.session_id || this.sessao;
        }
    }
}

/**
 * Roda um turno. `iniciar` permite trocar o spawn nos testes.
 * @returns {Promise<{tipo:"resposta"|"indisponivel"|"erro", texto:string, sessao:string|null, propostas:object[]}>}
 */
async function rodarTurno({ texto, sessao = null, pessoa = "", conversaId = null, emitir = () => {}, executavel = localizarClaude(), modelo = "", esforco = "",
    iniciar = spawn, pasta = path.join(RAIZ, "dados", "assistente"), sinal = null }) {
    if (!executavel) return { tipo: "indisponivel", texto: MSG_SEM_CLI, sessao, propostas: [] };
    fs.mkdirSync(pasta, { recursive: true });
    const ident = crypto.randomUUID();
    const fila = path.join(pasta, `fila_${ident}.jsonl`);
    const configMcp = path.join(pasta, `mcp_${ident}.json`);
    fs.writeFileSync(configMcp, JSON.stringify({ mcpServers: { vmac: { type: "stdio", command: process.execPath,
        args: [path.join(RAIZ, "src", "assistente", "mcp.js"), "--fila", fila, "--pessoa", pessoa || "?", "--conversa", String(conversaId || "")] } } }), "utf8");
    const ambiente = Object.fromEntries(Object.entries(process.env).filter(([chave]) => !VARIAVEIS_FORA.includes(chave)));
    const leitor = new LeitorEventos(emitir);
    const codigo = await new Promise((resolver) => {
        let processo;
        try {
            processo = iniciar(executavel, comando({ configMcp, sessao, modelo, esforco }), { cwd: pasta, env: ambiente, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        } catch (_) { resolver(-2); return; }
        const relogio = setTimeout(() => processo.kill(), TEMPO_LIMITE_MS);
        if (sinal) sinal.parar = () => processo.kill();
        let resto = "";
        const consumir = (pedaco) => {
            resto += pedaco.toString("utf8");
            const linhas = resto.split(/\r?\n/);
            resto = linhas.pop();
            for (const linha of linhas) leitor.ler(linha);
        };
        processo.stdout.on("data", consumir);
        processo.stderr.on("data", (pedaco) => leitor.outras.push(pedaco.toString("utf8").trim()));
        processo.on("error", () => { clearTimeout(relogio); resolver(-2); });
        processo.on("close", (codigoSaida) => { clearTimeout(relogio); if (resto) leitor.ler(resto); resolver(codigoSaida ?? 0); });
        processo.stdin.end(texto);
    });
    const propostas = lerFila(fila);
    for (const arquivo of [fila, configMcp]) try { fs.rmSync(arquivo, { force: true }); } catch (_) { /* temporario */ }
    if (codigo === -2) return { tipo: "indisponivel", texto: MSG_SEM_CLI, sessao, propostas: [] };
    const dados = leitor.resultado || { is_error: true, result: leitor.outras.slice(-5).join("\n") };
    const resposta = String(dados.result || "").trim();
    const novaSessao = leitor.sessao || sessao;
    if (dados.is_error || codigo) {
        const minusculo = `${resposta} ${leitor.outras.join(" ")}`.toLowerCase();
        if (PISTAS_LIMITE.some((pista) => minusculo.includes(pista))) return { tipo: "indisponivel", texto: `${MSG_LIMITE}${resposta ? ` (${resposta})` : ""}`, sessao: novaSessao, propostas: [] };
        if (PISTAS_LOGIN.some((pista) => minusculo.includes(pista))) return { tipo: "indisponivel", texto: MSG_LOGIN, sessao: novaSessao, propostas: [] };
        if (sinal?.parado) return { tipo: "erro", texto: "Parado. A conversa continua de onde parou na próxima mensagem.", sessao: novaSessao, propostas: [] };
        return { tipo: "erro", texto: `O assistente não conseguiu responder: ${resposta || "erro do Claude Code"}`, sessao: novaSessao, propostas: [] };
    }
    return { tipo: "resposta", texto: resposta, sessao: novaSessao, propostas };
}

function lerFila(fila) {
    if (!fs.existsSync(fila)) return [];
    return fs.readFileSync(fila, "utf8").split(/\r?\n/).filter(Boolean).map((linha) => { try { return JSON.parse(linha); } catch (_) { return null; } }).filter(Boolean);
}

module.exports = { localizarClaude, comando, rodarTurno, LeitorEventos, SISTEMA, MSG_SEM_CLI, MSG_LIMITE, MSG_LOGIN };
