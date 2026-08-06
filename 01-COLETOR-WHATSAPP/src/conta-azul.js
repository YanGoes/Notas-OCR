"use strict";

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");
const TOKEN_URL = "https://auth.contaazul.com/oauth2/token";
const API_URL = "https://api-v2.contaazul.com";
const TOKENS_PATH = path.join(RAIZ, "tokens_conta_azul.json");
const extensoes = new Set([".jpg", ".jpeg", ".png", ".bmp", ".pdf"]);
let emExecucao = false;

function carregarEnv() {
    const arquivo = path.join(RAIZ, ".env");
    if (!fs.existsSync(arquivo)) return {};
    return Object.fromEntries(fs.readFileSync(arquivo, "utf8").split(/\r?\n/)
        .map((linha) => linha.trim()).filter((linha) => linha && !linha.startsWith("#") && linha.includes("="))
        .map((linha) => { const i = linha.indexOf("="); return [linha.slice(0, i).trim(), linha.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; }));
}

function credenciais() {
    const env = { ...carregarEnv(), ...process.env };
    const dados = {
        clientId: env.CONTA_AZUL_CLIENT_ID,
        clientSecret: env.CONTA_AZUL_CLIENT_SECRET,
        redirectUri: env.CONTA_AZUL_REDIRECT_URI,
    };
    if (!dados.clientId || !dados.clientSecret) throw new Error("Credenciais ausentes no arquivo .env.");
    return dados;
}

function lerTokens() {
    if (!fs.existsSync(TOKENS_PATH)) throw new Error("Conta Azul ainda nao conectada. Execute npm run conta-azul:conectar.");
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
}

function salvarTokens(resposta) {
    const anterior = fs.existsSync(TOKENS_PATH) ? JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) : {};
    const tokens = {
        access_token: resposta.access_token,
        refresh_token: resposta.refresh_token || anterior.refresh_token,
        token_type: resposta.token_type || "Bearer",
        expires_at: Date.now() + (Number(resposta.expires_in || 3600) * 1000) - 60000,
    };
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), { encoding: "utf8", mode: 0o600 });
    return tokens;
}

async function trocarToken(parametros) {
    const { clientId, clientSecret } = credenciais();
    const resposta = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(parametros),
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(`Falha OAuth Conta Azul (${resposta.status}): ${JSON.stringify(dados)}`);
    return salvarTokens(dados);
}

async function trocarCodigo(codigo) {
    const { redirectUri } = credenciais();
    if (!redirectUri) throw new Error("CONTA_AZUL_REDIRECT_URI ausente no .env.");
    return trocarToken({ code: codigo, grant_type: "authorization_code", redirect_uri: redirectUri });
}

async function tokenValido(forcar = false) {
    const tokens = lerTokens();
    if (!forcar && tokens.access_token && Date.now() < Number(tokens.expires_at || 0)) return tokens.access_token;
    if (!tokens.refresh_token) throw new Error("Refresh token ausente. Conecte novamente.");
    return (await trocarToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).access_token;
}

async function requisicao(endpoint, opcoes = {}, repetir = true) {
    const token = await tokenValido();
    const resposta = await fetch(`${API_URL}${endpoint}`, {
        ...opcoes,
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(opcoes.headers || {}) },
    });
    if (resposta.status === 401 && repetir) {
        await tokenValido(true);
        return requisicao(endpoint, opcoes, false);
    }
    const texto = await resposta.text();
    let dados = texto;
    try { dados = texto ? JSON.parse(texto) : null; } catch (_) { /* resposta textual */ }
    if (!resposta.ok) throw new Error(`Conta Azul ${resposta.status}: ${typeof dados === "string" ? dados : JSON.stringify(dados)}`);
    return dados;
}

function comentarioDaImagem(imagem) {
    const jsonPath = imagem.replace(/\.[^.]+$/, ".json");
    if (fs.existsSync(jsonPath)) {
        const metadados = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        return String(metadados.legenda || "").trim();
    }
    return "";
}

function descricaoDaImagem(imagem) {
    const auditoriaPath = path.join(RAIZ, "dados", "auditoria", `${path.parse(imagem).name}.json`);
    if (fs.existsSync(auditoriaPath)) {
        const auditoria = JSON.parse(fs.readFileSync(auditoriaPath, "utf8"));
        if (auditoria.conta_azul?.descricao_sugerida) return String(auditoria.conta_azul.descricao_sugerida).slice(0, 255);
    }
    return comentarioDaImagem(imagem).slice(0, 255);
}

async function enviarDocumento(imagem) {
    const stat = fs.statSync(imagem);
    if (!extensoes.has(path.extname(imagem).toLowerCase())) throw new Error("Formato nao aceito pela Captura.");
    if (stat.size > 10 * 1024 * 1024) throw new Error("Arquivo maior que 10 MB.");
    const form = new FormData();
    form.append("arquivo", new Blob([fs.readFileSync(imagem)]), path.basename(imagem));
    const descricao = descricaoDaImagem(imagem);
    if (descricao) form.append("descricao", descricao);
    return requisicao("/v1/captura/documentos", { method: "POST", body: form });
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function aguardarCaptura(idDocumento, timeoutSegundos) {
    const inicio = Date.now();
    while ((Date.now() - inicio) / 1000 < timeoutSegundos) {
        const status = await requisicao(`/v1/captura/documentos/status?ids=${encodeURIComponent(idDocumento)}&tamanho_pagina=20`);
        const item = status?.itens?.find((x) => x.id_documento === idDocumento) || status?.itens?.[0];
        const captura = item?.capturas?.[0];
        if (captura?.status_captura === "PENDENTE") return captura.id_captura;
        if (["FALHA", "REJEITADA"].includes(captura?.status_captura) || ["ERRO", "IGNORADO", "EXCLUIDO"].includes(item?.status_documento)) {
            throw new Error(`Processamento falhou: ${JSON.stringify(item)}`);
        }
        await esperar(5000);
    }
    throw new Error("Tempo limite da extracao excedido; o arquivo permanecera na entrada para nova tentativa.");
}

function moverConjunto(imagem, destino) {
    fs.mkdirSync(destino, { recursive: true });
    const base = imagem.replace(/\.[^.]+$/, "");
    for (const arquivo of [imagem, `${base}.txt`, `${base}.json`]) {
        if (fs.existsSync(arquivo)) fs.renameSync(arquivo, path.join(destino, path.basename(arquivo)));
    }
}

async function processarImagem(imagem, pastaEntrada, opcoes) {
    const respostas = path.join(RAIZ, "respostas_conta_azul");
    fs.mkdirSync(respostas, { recursive: true });
    const estadoPath = path.join(respostas, `${path.parse(imagem).name}_estado.json`);
    let estado = fs.existsSync(estadoPath) ? JSON.parse(fs.readFileSync(estadoPath, "utf8")) : {};
    const envio = estado.envio || await enviarDocumento(imagem);
    if (!estado.envio) {
        estado = { arquivo: path.basename(imagem), envio };
        fs.writeFileSync(estadoPath, JSON.stringify(estado, null, 2), "utf8");
    }
    const idCaptura = await aguardarCaptura(envio.id, Number(opcoes.timeout_processamento_segundos || 300));
    const extracao = await requisicao(`/v1/captura/${encodeURIComponent(idCaptura)}`);
    const registro = { arquivo: path.basename(imagem), comentario_whatsapp: comentarioDaImagem(imagem), envio, extracao };
    if (opcoes.aceitar_despesa_automaticamente) {
        if (extracao?.previa_evento_financeiro?.tipo !== "DESPESA") throw new Error("A previa nao foi identificada como DESPESA; aceite bloqueado.");
        registro.aceite = await requisicao(`/v1/captura/${encodeURIComponent(idCaptura)}`, { method: "POST" });
    }
    fs.writeFileSync(path.join(respostas, `${path.parse(imagem).name}_conta_azul.json`), JSON.stringify(registro, null, 2), "utf8");
    if (fs.existsSync(estadoPath)) fs.unlinkSync(estadoPath);
    moverConjunto(imagem, path.join(RAIZ, "processados_conta_azul"));
    console.log(`Conta Azul: ${path.basename(imagem)} processado${registro.aceite ? " e despesa criada" : "; aguardando revisao manual"}.`);
}

async function processarPendentes(pastaEntrada, opcoes) {
    if (emExecucao) return;
    emExecucao = true;
    try {
        const imagens = fs.readdirSync(pastaEntrada).filter((nome) => extensoes.has(path.extname(nome).toLowerCase()));
        for (const nome of imagens) {
            const imagem = path.join(pastaEntrada, nome);
            try { await processarImagem(imagem, pastaEntrada, opcoes); }
            catch (erro) {
                console.error(`Conta Azul: erro em ${nome}: ${erro.message}`);
                const erroTemporario = /Tempo limite|Credenciais ausentes|ainda nao conectada|401|429|Conta Azul 5\d\d/i.test(erro.message);
                if (!erroTemporario) moverConjunto(imagem, path.join(RAIZ, "erros_conta_azul"));
            }
        }
    } finally { emExecucao = false; }
}

function iniciarMonitor(pastaEntrada, opcoes) {
    if (!opcoes?.habilitada) return;
    console.log(`Integracao Conta Azul ativa (aceite automatico: ${opcoes.aceitar_despesa_automaticamente ? "SIM" : "NAO"}).`);
    const executar = () => processarPendentes(pastaEntrada, opcoes).catch((erro) => console.error("Conta Azul:", erro.message));
    setTimeout(executar, 2000);
    setInterval(executar, Math.max(5, Number(opcoes.intervalo_segundos || 10)) * 1000);
}

module.exports = { API_URL, TOKEN_URL, credenciais, trocarCodigo, tokenValido, requisicao, iniciarMonitor, descricaoDaImagem };
