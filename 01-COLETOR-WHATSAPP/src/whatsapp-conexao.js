"use strict";

// =============================================================================
// CONEXAO COM O WHATSAPP: versao, diagnostico de quedas e registro
// =============================================================================
//
// Por que existe: o celular RECUSA vincular um aparelho que se apresenta com
// uma versao do WhatsApp Web defasada ("Nao foi possivel conectar o
// aparelho"). A biblioteca (Baileys) pega a versao numa lista do proprio
// GitHub, que fica para tras em relacao ao WhatsApp Web real. Aqui a versao
// vem do site do WhatsApp Web; sem internet, usa a ultima que deu certo.
//
// Tambem traduz cada motivo de queda numa ACAO (gerar QR novo, reconectar na
// hora, limpar a sessao, parar e avisar) e grava tudo em
// dados/logs/whatsapp-conexao.log para nunca mais ficarmos sem o motivo.
// =============================================================================

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");
const ARQUIVO_VERSAO = path.join(RAIZ, "dados", "whatsapp-versao.json");
const ARQUIVO_LOG = path.join(RAIZ, "dados", "logs", "whatsapp-conexao.log");
const LIMITE_LOG_BYTES = 512 * 1024;

function registrarLog(evento, detalhes = {}) {
    try {
        fs.mkdirSync(path.dirname(ARQUIVO_LOG), { recursive: true });
        // Log pequeno: passou do limite, guarda so a metade mais recente.
        if (fs.existsSync(ARQUIVO_LOG) && fs.statSync(ARQUIVO_LOG).size > LIMITE_LOG_BYTES) {
            const texto = fs.readFileSync(ARQUIVO_LOG, "utf8");
            fs.writeFileSync(ARQUIVO_LOG, texto.slice(Math.floor(texto.length / 2)), "utf8");
        }
        fs.appendFileSync(ARQUIVO_LOG, `${new Date().toISOString()} ${evento} ${JSON.stringify(detalhes)}\n`, "utf8");
    } catch (_) { /* o log nunca pode derrubar a conexao */ }
}

function comTempoLimite(promessa, ms) {
    return Promise.race([promessa, new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error(`tempo limite de ${ms} ms`)), ms))]);
}

/**
 * Versao do WhatsApp Web para se apresentar ao celular.
 * Ordem: site do WhatsApp Web -> ultima que deu certo (arquivo) -> lista do
 * Baileys -> versao embutida na biblioteca (undefined).
 */
async function versaoWhatsAppWeb(baileys, { tempoLimiteMs = 8000 } = {}) {
    const tentativas = [
        ["whatsapp_web", () => baileys.fetchLatestWaWebVersion?.({})],
        ["ultima_que_funcionou", async () => JSON.parse(fs.readFileSync(ARQUIVO_VERSAO, "utf8"))],
        ["lista_do_baileys", () => baileys.fetchLatestBaileysVersion?.()],
    ];
    for (const [origem, buscar] of tentativas) {
        try {
            const resultado = await comTempoLimite(Promise.resolve(buscar()), tempoLimiteMs);
            const versao = resultado?.version;
            if (Array.isArray(versao) && versao.length === 3 && versao.every(Number.isFinite)) {
                if (origem === "whatsapp_web") {
                    try {
                        fs.mkdirSync(path.dirname(ARQUIVO_VERSAO), { recursive: true });
                        fs.writeFileSync(ARQUIVO_VERSAO, JSON.stringify({ version: versao, obtida_em: new Date().toISOString() }), "utf8");
                    } catch (_) { /* cache opcional */ }
                }
                return { versao, origem };
            }
        } catch (_) { /* tenta a proxima fonte */ }
    }
    return { versao: undefined, origem: "embutida_na_biblioteca" };
}

// Codigos do WhatsApp/Baileys (DisconnectReason).
const CODIGOS = {
    LOGGED_OUT: 401, FORBIDDEN: 403, TIMED_OUT: 408, MULTIDEVICE_MISMATCH: 411, CONNECTION_CLOSED: 428,
    CONNECTION_REPLACED: 440, BAD_SESSION: 500, UNAVAILABLE: 503, RESTART_REQUIRED: 515,
};

/**
 * O que fazer quando a conexao cai.
 * @param {number|undefined} codigo — statusCode do lastDisconnect
 * @param {object} contexto
 * @param {boolean} contexto.saidaPedida — a pessoa clicou em "Sair do WhatsApp"
 * @param {boolean} contexto.registrado — a sessao ja estava vinculada ao celular
 * @param {string} contexto.statusAnterior — estado antes da queda
 * @returns {{acao: 'PARAR'|'NOVO_QR'|'RECONECTAR_JA'|'RECONECTAR_COM_ESPERA', limparSessao: boolean, mensagem: string|null}}
 */
function diagnosticarQueda(codigo, { saidaPedida = false, registrado = false, statusAnterior = "" } = {}) {
    if (saidaPedida) return { acao: "PARAR", limparSessao: true, mensagem: null };
    switch (codigo) {
        case CODIGOS.RESTART_REQUIRED:
            // Normal logo depois de ler o QR: o WhatsApp pede para reabrir a conexao.
            return { acao: "RECONECTAR_JA", limparSessao: false, mensagem: "Vínculo aceito pelo celular; finalizando a conexão..." };
        case CODIGOS.LOGGED_OUT:
            if (!registrado) {
                return { acao: "NOVO_QR", limparSessao: true, mensagem: "O celular não aceitou o vínculo. Um QR Code novo foi gerado: leia em até 20 segundos. "
                    + "Se repetir, confira no celular se já existem 4 aparelhos conectados (o limite do WhatsApp) e remova um que não use." };
            }
            return { acao: "PARAR", limparSessao: true, mensagem: "A sessão foi encerrada pelo celular (aparelho removido em Aparelhos conectados). Clique em Conectar para gerar um QR Code novo." };
        case CODIGOS.BAD_SESSION:
        case CODIGOS.MULTIDEVICE_MISMATCH:
            return { acao: "NOVO_QR", limparSessao: true, mensagem: "A sessão salva estava inválida e foi descartada. Leia o QR Code novo." };
        case CODIGOS.CONNECTION_REPLACED:
            return { acao: "PARAR", limparSessao: false, mensagem: "Outra cópia do programa abriu esta mesma sessão do WhatsApp. Feche as outras janelas do programa e clique em Conectar." };
        case CODIGOS.FORBIDDEN:
            return { acao: "PARAR", limparSessao: false, mensagem: "O WhatsApp bloqueou esta conexão (403). Verifique o número no celular antes de tentar de novo." };
        case CODIGOS.TIMED_OUT:
            // Sem leitura do QR dentro do prazo: gera outro na hora, sem castigo de espera.
            if (!registrado && ["aguardando_qr", "conectando", "aguardando_codigo"].includes(statusAnterior)) {
                return { acao: "NOVO_QR", limparSessao: false, mensagem: "O QR Code expirou e foi renovado." };
            }
            return { acao: "RECONECTAR_COM_ESPERA", limparSessao: false, mensagem: null };
        default:
            return { acao: "RECONECTAR_COM_ESPERA", limparSessao: false, mensagem: null };
    }
}

module.exports = { versaoWhatsAppWeb, diagnosticarQueda, registrarLog, CODIGOS, ARQUIVO_LOG };
