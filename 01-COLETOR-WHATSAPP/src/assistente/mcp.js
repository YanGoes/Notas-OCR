"use strict";

// =============================================================================
// SERVIDOR MCP (stdio) DO ASSISTENTE
// =============================================================================
//
// O Claude Code (`claude -p`, rodado por src/assistente/assinatura.js) sobe
// este processo e conversa por JSON-RPC, uma mensagem por linha. Mesma ideia do
// calc/mcp_assistente.py do RodMac (Jhonathan):
//
//   - consulta: roda aqui e devolve o resultado;
//   - ferramenta que grava: NAO roda; vira uma linha na fila (JSONL) que a
//     Central le no fim da resposta e mostra como cartao "Confirmar".
//
// Protocolo a mao (initialize, tools/list, tools/call, ping).
//   node src/assistente/mcp.js --fila <arquivo> --pessoa <nome> --conversa <id>
// =============================================================================

const fs = require("fs");
const readline = require("readline");
const ferramentas = require("./ferramentas");

const VERSAO_PROTOCOLO = "2025-06-18";
const LIMITE_RESULTADO = 20000;

function anotar(fila, nome, parametros) {
    fs.appendFileSync(fila, JSON.stringify({ ferramenta: nome, parametros }) + "\n", "utf8");
}

async function chamar(ctx, nome, parametros) {
    let ferramenta;
    try { ferramenta = ferramentas.obter(nome); } catch (erro) { return { texto: erro.message, erro: true }; }
    if (ferramenta.grava) {
        anotar(ctx.fila, nome, parametros);
        return { texto: "Proposta registrada: a Central mostra um botão Confirmar para uma pessoa autorizada. Não chame outra ferramenta que grava; termine a resposta dizendo o que vai ser feito.", erro: false };
    }
    try {
        let texto = JSON.stringify(await ferramenta.executar(ctx, parametros || {}));
        if (texto.length > LIMITE_RESULTADO) texto = `${texto.slice(0, LIMITE_RESULTADO)} …(cortado: refine o filtro)`;
        return { texto, erro: false };
    } catch (erro) {
        return { texto: `Erro: ${erro.message}`, erro: true };
    }
}

/** Resposta JSON-RPC para uma mensagem (null para notificacao). */
async function tratar(mensagem, ctx) {
    const { method: metodo, id } = mensagem || {};
    if (id === undefined || id === null) return null;
    let resultado;
    if (metodo === "initialize") {
        resultado = { protocolVersion: mensagem.params?.protocolVersion || VERSAO_PROTOCOLO, capabilities: { tools: {} }, serverInfo: { name: "vmac", version: "1" } };
    } else if (metodo === "tools/list") {
        resultado = { tools: ferramentas.FERRAMENTAS.map((f) => ({ name: f.nome, description: f.descricao, inputSchema: f.esquema })) };
    } else if (metodo === "tools/call") {
        const { texto, erro } = await chamar(ctx, mensagem.params?.name, mensagem.params?.arguments || {});
        resultado = { content: [{ type: "text", text: texto }], isError: erro };
    } else if (metodo === "ping") {
        resultado = {};
    } else {
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Método ${metodo} não existe.` } };
    }
    return { jsonrpc: "2.0", id, result: resultado };
}

function argumento(nome) {
    const indice = process.argv.indexOf(`--${nome}`);
    return indice > 0 ? process.argv[indice + 1] : null;
}

async function principal() {
    const { banco } = require("../central/banco");
    const cadastros = require("../central/cadastros");
    const ctx = { db: banco(), cad: cadastros.carregar(), fila: argumento("fila"), pessoa: argumento("pessoa"), conversaId: Number(argumento("conversa")) || null };
    if (!ctx.fila) throw new Error("--fila obrigatório");
    const leitor = readline.createInterface({ input: process.stdin });
    for await (const linha of leitor) {
        if (!linha.trim()) continue;
        let resposta;
        try { resposta = await tratar(JSON.parse(linha), ctx); } catch (_) { resposta = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido." } }; }
        if (resposta) process.stdout.write(JSON.stringify(resposta) + "\n");
    }
}

if (require.main === module) principal().catch((erro) => { process.stderr.write(`mcp: ${erro.message}\n`); process.exitCode = 1; });

module.exports = { tratar, chamar };
