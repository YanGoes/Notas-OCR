"use strict";

// Modelo treinado com a planilha (ferramentas/treinar-central.js). So produz
// SUGESTOES: quem decide a categoria sao as regras e, na falta delas, a pessoa
// que revisa. Sem o arquivo do modelo, simplesmente nao ha sugestao.

const fs = require("fs");
const path = require("path");
const { prever } = require("../aprendizado");

const MODELO_PATH = path.resolve(__dirname, "..", "..", "configuracao", "modelo-central.json");
let cache = null;
let cacheMtime = 0;

function carregar(caminho = MODELO_PATH) {
    try {
        if (!fs.existsSync(caminho)) return null;
        const mtime = fs.statSync(caminho).mtimeMs;
        if (!cache || mtime !== cacheMtime) { cache = JSON.parse(fs.readFileSync(caminho, "utf8")); cacheMtime = mtime; }
        return cache;
    } catch (_) { return null; }
}

/**
 * Sugestao de categoria pelo texto (fornecedor, itens, observacoes).
 * Devolve null quando o modelo nao existe ou nao reconhece nada do texto.
 */
function sugerirCategoria(texto, { modelo = carregar(), confiancaMinima = 0.5 } = {}) {
    if (!modelo?.texto_categoria || !String(texto || "").trim()) return null;
    const resultado = prever(modelo.texto_categoria, texto);
    if (!resultado || resultado.confianca < confiancaMinima) return null;
    return {
        nome: resultado.rotulo, confianca: Number(resultado.confianca.toFixed(3)), origem: "modelo_da_planilha",
        alternativas: resultado.alternativas.map((item) => ({ nome: item.rotulo, probabilidade: Number(item.probabilidade.toFixed(3)) })),
        treinado_em: modelo.treinado_em,
    };
}

module.exports = { carregar, sugerirCategoria, MODELO_PATH };
