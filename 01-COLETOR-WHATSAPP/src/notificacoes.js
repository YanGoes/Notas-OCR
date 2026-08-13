"use strict";

// =============================================================================
// NOTIFICACOES DO PROGRAMA
// =============================================================================
//
// Central de avisos que aparece no painel. E o canal principal de retorno para
// o operador: toda vez que o sistema conclui (ou nao consegue concluir) uma
// despesa, o aviso fica registrado aqui, com o que precisa ser feito.
//
// O mesmo texto tambem pode ser enviado ao WhatsApp, mas o painel e a fonte
// confiavel: o WhatsApp pode estar desconectado, o painel nao perde o aviso.
// =============================================================================

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");
const ARQUIVO = path.join(RAIZ, "dados", "notificacoes.json");
const LIMITE = 200;

function ler() {
    if (!fs.existsSync(ARQUIVO)) return [];
    try {
        const dados = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
        return Array.isArray(dados) ? dados : [];
    } catch (_) { return []; }
}

function gravar(lista) {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
    const temporario = `${ARQUIVO}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(lista.slice(0, LIMITE), null, 2), "utf8");
    fs.renameSync(temporario, ARQUIVO);
}

/**
 * Registra um aviso para o operador.
 *
 * @param {object} aviso
 * @param {string} aviso.titulo — resumo curto, aparece em destaque
 * @param {string} aviso.texto — corpo com os detalhes e o que fazer
 * @param {"sucesso"|"atencao"|"erro"} [aviso.nivel="atencao"]
 * @param {string} [aviso.base] — documento relacionado
 * @param {string[]} [aviso.pendencias] — acoes que dependem de uma pessoa
 */
function registrar({ titulo, texto, nivel = "atencao", base = null, pendencias = [] }) {
    const notificacao = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        criada_em: new Date().toISOString(),
        titulo: String(titulo || "Aviso"),
        texto: String(texto || ""),
        nivel,
        base,
        pendencias: Array.isArray(pendencias) ? pendencias : [],
        lida: false,
    };
    const lista = ler();
    lista.unshift(notificacao);
    gravar(lista);
    return notificacao;
}

function listar({ apenasNaoLidas = false } = {}) {
    const lista = ler();
    return apenasNaoLidas ? lista.filter((item) => !item.lida) : lista;
}

function contarNaoLidas() {
    return ler().filter((item) => !item.lida).length;
}

/** Marca uma notificacao como lida, ou todas quando `id` nao e informado. */
function marcarLida(id = null) {
    const lista = ler();
    for (const item of lista) {
        if (!id || item.id === id) item.lida = true;
    }
    gravar(lista);
    return contarNaoLidas();
}

function limpar() {
    gravar([]);
}

module.exports = { registrar, listar, contarNaoLidas, marcarLida, limpar, ARQUIVO };
