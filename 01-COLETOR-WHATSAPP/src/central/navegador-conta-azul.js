"use strict";

// =============================================================================
// NAVEGADOR DO ROBO DE TELA (site do Conta Azul)
// =============================================================================
//
// A API publica do Conta Azul nao grava anexo (testado em 11/11/2026). O que o
// site faz na aba "Anexo" so o proprio site grava. Este modulo abre um
// navegador comum (Chrome ou Edge ja instalado) com um PERFIL PROPRIO, guardado
// em dados/navegador-conta-azul, e conversa com ele pelo protocolo de depuracao
// (CDP), sem instalar nada.
//
// O login e feito pela PESSOA, uma vez, nessa janela (senha e codigo nunca
// passam pelo programa); a sessao fica guardada no perfil. A porta de depuracao
// so atende em 127.0.0.1 e e sorteada pelo navegador a cada abertura.
// =============================================================================

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const RAIZ = path.resolve(__dirname, "..", "..");
const PERFIL_PADRAO = path.join(RAIZ, "dados", "navegador-conta-azul");
const NAVEGADORES = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function acharNavegador(preferido = null) {
    const lista = preferido ? [preferido, ...NAVEGADORES] : NAVEGADORES;
    const achado = lista.find((caminho) => caminho && fs.existsSync(caminho));
    if (!achado) throw new Error("Nenhum navegador encontrado (Chrome ou Edge). Informe o caminho em config.central.robo_conta_azul.navegador.");
    return achado;
}

/** Porta de depuracao de um navegador ja aberto com este perfil (ou null). */
async function portaAberta(perfil) {
    try {
        const [porta] = fs.readFileSync(path.join(perfil, "DevToolsActivePort"), "utf8").split(/\r?\n/);
        const resposta = await fetch(`http://127.0.0.1:${Number(porta)}/json/version`, { signal: AbortSignal.timeout(1500) });
        return resposta.ok ? Number(porta) : null;
    } catch (_) { return null; }
}

/**
 * Abre o navegador do robo (ou reaproveita o que ja esta aberto) e devolve a
 * porta de depuracao. `url` abre numa aba nova quando o navegador ja existia.
 */
async function abrir({ perfil = PERFIL_PADRAO, navegador = null, url = "about:blank", esperaMs = 20000 } = {}) {
    let porta = await portaAberta(perfil);
    if (porta) return { porta, perfil, reaproveitado: true };
    fs.mkdirSync(perfil, { recursive: true });
    try { fs.unlinkSync(path.join(perfil, "DevToolsActivePort")); } catch (_) { /* nao existia */ }
    const processo = spawn(acharNavegador(navegador), [
        `--user-data-dir=${perfil}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", "--disable-features=Translate", url,
    ], { detached: true, stdio: "ignore" });
    processo.unref();
    const limite = Date.now() + esperaMs;
    while (Date.now() < limite) {
        porta = await portaAberta(perfil);
        if (porta) return { porta, perfil, reaproveitado: false };
        await esperar(300);
    }
    throw new Error("O navegador do robô não respondeu. Feche as janelas dele e tente de novo.");
}

async function listarAbas(porta) {
    const resposta = await fetch(`http://127.0.0.1:${porta}/json/list`, { signal: AbortSignal.timeout(5000) });
    return (await resposta.json()).filter((alvo) => alvo.type === "page");
}

async function novaAba(porta, url = "about:blank") {
    const resposta = await fetch(`http://127.0.0.1:${porta}/json/new?${encodeURIComponent(url)}`, { method: "PUT", signal: AbortSignal.timeout(5000) });
    return resposta.json();
}

/**
 * Liga-se a uma aba. Devolve { enviar, avaliar, navegar, capturar, aoEvento,
 * rede, fechar }. `rede` guarda as requisicoes vistas depois de ligarRede().
 */
async function conectar(porta, { aba = null, urlContem = null } = {}) {
    const abas = await listarAbas(porta);
    const alvo = aba || (urlContem ? abas.find((a) => a.url.includes(urlContem)) : null) || abas[0] || await novaAba(porta);
    const ws = new WebSocket(alvo.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("Não foi possível ligar ao navegador do robô.")); });
    let proximo = 0;
    let fechada = false;
    const pendentes = new Map();
    const ouvintes = new Set();
    // Janela ou aba fechada: quem estava esperando resposta recebe erro (nao fica pendurado).
    ws.onclose = () => {
        fechada = true;
        for (const { reject } of pendentes.values()) reject(new Error("A janela do robô foi fechada."));
        pendentes.clear();
    };
    ws.onmessage = (mensagem) => {
        const dados = JSON.parse(mensagem.data);
        if (dados.id && pendentes.has(dados.id)) {
            const { resolve, reject } = pendentes.get(dados.id);
            pendentes.delete(dados.id);
            if (dados.error) reject(new Error(`${dados.error.message}${dados.error.data ? `: ${dados.error.data}` : ""}`));
            else resolve(dados.result);
        } else if (dados.method) {
            for (const ouvinte of ouvintes) { try { ouvinte(dados.method, dados.params); } catch (_) { /* ouvinte nao derruba */ } }
        }
    };
    const enviar = (method, params = {}) => new Promise((resolve, reject) => {
        if (fechada) { reject(new Error("A janela do robô foi fechada.")); return; }
        proximo += 1;
        pendentes.set(proximo, { resolve, reject });
        ws.send(JSON.stringify({ id: proximo, method, params }));
    });
    /** Roda JavaScript na pagina e devolve o valor (aguarda Promise). */
    const avaliar = async (expressao) => {
        const r = await enviar("Runtime.evaluate", { expression: expressao, awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.exceptionDetails) throw new Error(`Erro na página: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result?.value;
    };
    const navegar = async (url, { esperaMs = 30000 } = {}) => {
        await enviar("Page.enable");
        const carregou = new Promise((resolve) => {
            const ouvinte = (metodo) => { if (metodo === "Page.loadEventFired") { ouvintes.delete(ouvinte); resolve(); } };
            ouvintes.add(ouvinte);
            setTimeout(() => { ouvintes.delete(ouvinte); resolve(); }, esperaMs);
        });
        await enviar("Page.navigate", { url });
        await carregou;
    };
    const capturar = async (arquivo) => {
        const { data } = await enviar("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(arquivo, Buffer.from(data, "base64"));
        return arquivo;
    };
    const rede = [];
    /** Passa a anotar as requisicoes da aba (metodo, url, corpo enviado, status). */
    const ligarRede = async () => {
        await enviar("Network.enable", { maxPostDataSize: 200000 });
        const porId = new Map();
        ouvintes.add((metodo, p) => {
            if (metodo === "Network.requestWillBeSent" && ["XHR", "Fetch"].includes(p.type)) {
                const item = { id: p.requestId, metodo: p.request.method, url: p.request.url, corpo: p.request.postData || null, tipo_corpo: p.request.headers?.["Content-Type"] || p.request.headers?.["content-type"] || null, status: null };
                porId.set(p.requestId, item);
                rede.push(item);
            } else if (metodo === "Network.responseReceived" && porId.has(p.requestId)) {
                porId.get(p.requestId).status = p.response.status;
            }
        });
    };
    const corpoDaResposta = async (id) => {
        try { return (await enviar("Network.getResponseBody", { requestId: id })).body; } catch (_) { return null; }
    };
    return {
        aba: alvo, enviar, avaliar, navegar, capturar, rede, ligarRede, corpoDaResposta,
        fechada: () => fechada,
        aoEvento: (ouvinte) => { ouvintes.add(ouvinte); return () => ouvintes.delete(ouvinte); },
        fechar: () => { try { ws.close(); } catch (_) { /* ja fechado */ } },
    };
}

module.exports = { abrir, conectar, listarAbas, novaAba, acharNavegador, portaAberta, PERFIL_PADRAO };
