"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RAIZ = path.resolve(__dirname, "..");
const MODELO_PATH = path.join(RAIZ, "configuracao", "modelo-historico.json");
const stopwords = new Set("a ao aos as com da das de do dos e em no nos na nas o os para por um uma uns umas r reais ref referente pagamento pago parcela despesa despesas".split(" "));
let cache = null;
let cacheMtime = 0;
const vocabulariosCache = new WeakMap();

function normalizar(texto) {
    return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(texto) {
    const base = normalizar(texto).split(/\s+/).filter((token) => token.length > 1 && !stopwords.has(token));
    const resultado = [...base];
    for (let i = 0; i < base.length - 1; i += 1) resultado.push(`${base[i]}_${base[i + 1]}`);
    return [...new Set(resultado)].slice(0, 500);
}

function hashGrupo(texto) {
    return parseInt(crypto.createHash("sha256").update(normalizar(texto)).digest("hex").slice(0, 8), 16);
}

function criarModelo(exemplos, campoRotulo, campoTexto, minimoClasse = 5) {
    const frequenciaClasses = {};
    for (const exemplo of exemplos) frequenciaClasses[exemplo[campoRotulo]] = (frequenciaClasses[exemplo[campoRotulo]] || 0) + 1;
    const permitidas = new Set(Object.entries(frequenciaClasses).filter(([, total]) => total >= minimoClasse).map(([nome]) => nome));
    const classes = {};
    const vocabulario = new Set();
    let documentos = 0;
    for (const exemplo of exemplos) {
        const rotulo = exemplo[campoRotulo];
        if (!rotulo || !permitidas.has(rotulo)) continue;
        const termos = tokens(exemplo[campoTexto]);
        if (!termos.length) continue;
        const classe = classes[rotulo] ||= { documentos: 0, total_tokens: 0, tokens: {} };
        classe.documentos += 1; documentos += 1;
        for (const termo of termos) {
            vocabulario.add(termo); classe.tokens[termo] = (classe.tokens[termo] || 0) + 1; classe.total_tokens += 1;
        }
    }
    return { documentos, vocabulario: vocabulario.size, classes };
}

function prever(modelo, texto) {
    if (!modelo?.documentos || !Object.keys(modelo.classes || {}).length) return null;
    let vocabularioConhecido = vocabulariosCache.get(modelo);
    if (!vocabularioConhecido) {
        vocabularioConhecido = new Set();
        for (const classe of Object.values(modelo.classes)) for (const termo of Object.keys(classe.tokens || {})) vocabularioConhecido.add(termo);
        vocabulariosCache.set(modelo, vocabularioConhecido);
    }
    const termos = tokens(texto).filter((termo) => vocabularioConhecido.has(termo));
    if (!termos.length) return null;
    const pontuacoes = Object.entries(modelo.classes).map(([rotulo, classe]) => {
        let score = Math.log(classe.documentos / modelo.documentos);
        const denominador = classe.total_tokens + modelo.vocabulario;
        for (const termo of termos) score += Math.log(((classe.tokens[termo] || 0) + 1) / denominador);
        return { rotulo, score };
    }).sort((a, b) => b.score - a.score);
    const maximo = pontuacoes[0].score;
    const exp = pontuacoes.map((item) => Math.exp(item.score - maximo));
    const soma = exp.reduce((a, b) => a + b, 0);
    return {
        rotulo: pontuacoes[0].rotulo,
        confianca: exp[0] / soma,
        margem: pontuacoes.length > 1 ? pontuacoes[0].score - pontuacoes[1].score : 99,
        alternativas: pontuacoes.slice(0, 3).map((item, i) => ({ rotulo: item.rotulo, probabilidade: exp[i] / soma })),
    };
}

function carregarModelo() {
    if (!fs.existsSync(MODELO_PATH)) return null;
    const mtime = fs.statSync(MODELO_PATH).mtimeMs;
    if (!cache || mtime !== cacheMtime) { cache = JSON.parse(fs.readFileSync(MODELO_PATH, "utf8")); cacheMtime = mtime; }
    return cache;
}

function sugerir({ legenda, fornecedor, textoOcr }) {
    const modelo = carregarModelo();
    if (!modelo) return null;
    const textoBase = [fornecedor, legenda, textoOcr].filter(Boolean).join(" ");
    const familia = prever(modelo.familia, textoBase);
    const categoria = prever(modelo.categoria, textoBase);
    const centro = prever(modelo.centro, `${textoBase} categoria ${categoria?.rotulo || ""}`);
    return { familia, categoria, centro, versao: modelo.versao, treinado_em: modelo.treinado_em };
}

module.exports = { normalizar, tokens, hashGrupo, criarModelo, prever, carregarModelo, sugerir, MODELO_PATH };
