"use strict";

// Rotas da Central de revisao (/api/central/...). Nenhuma delas lanca no
// Conta Azul nem copia para o Drive: so leem e corrigem as previas.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { banco, lerJson } = require("./banco");
const cadastros = require("./cadastros");
const revisao = require("./revisao");
const projetosAdmin = require("./projetos-admin");

const RAIZ = path.resolve(__dirname, "..", "..");
// "importados" recebe as fotos trazidas por ferramentas/importar-para-central.js.
const PASTAS_IMAGEM = ["entrada", "simulacao", "revisao", "bloqueados", "erros", "enviados", "importados"];

function regras() {
    const arquivo = path.join(RAIZ, "configuracao", "regras.json");
    try { return fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, "utf8")) : {}; } catch (_) { return {}; }
}

function localizarArquivo(nome) {
    if (!nome || path.basename(nome) !== nome) return null;
    for (const pasta of PASTAS_IMAGEM) {
        const caminho = path.join(RAIZ, "dados", pasta, nome);
        if (fs.existsSync(caminho)) return caminho;
    }
    return null;
}

const idDe = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Identificador inválido.");
    return id;
};

/** @param {object} [opcoes] @param {() => object} [opcoes.db] — permite usar outro banco (testes) */
function criarRotas({ db = banco, cad = () => cadastros.carregar() } = {}) {
    const rotas = express.Router();
    const responder = (fn) => (req, res, next) => {
        try { res.json(fn(req)); } catch (erro) { next(erro); }
    };

    rotas.get("/opcoes", responder(() => revisao.opcoes(cad())));
    rotas.get("/despesas", responder((req) => revisao.listar(db(), { aba: String(req.query.aba || "revisar") })));
    rotas.get("/despesas/:id", (req, res, next) => {
        try {
            const detalhe = revisao.detalhar(db(), idDe(req));
            if (!detalhe) return res.status(404).json({ erro: "Despesa não encontrada." });
            const imagem = detalhe.midia && localizarArquivo(detalhe.midia.arquivo);
            return res.json({ ...detalhe, imagem_url: imagem ? `/api/central/midias/${detalhe.midia.id}/imagem` : null });
        } catch (erro) { return next(erro); }
    });
    rotas.post("/despesas/:id/corrigir", responder((req) => revisao.corrigir(db(), cad(), idDe(req), req.body?.alteracoes, req.body?.autor)));
    rotas.post("/despesas/:id/aprovar", responder((req) => revisao.aprovar(db(), idDe(req), req.body?.autor)));
    rotas.post("/despesas/:id/descartar", responder((req) => revisao.descartar(db(), idDe(req), req.body?.motivo, req.body?.autor)));
    rotas.post("/despesas/:id/reabrir", responder((req) => revisao.reabrir(db(), idDe(req), req.body?.motivo, req.body?.autor)));
    rotas.post("/despesas/:id/regenerar", responder((req) => revisao.regenerar(db(), cad(), idDe(req), { regras: regras() })));
    rotas.get("/metricas", responder(() => revisao.metricas(db())));
    rotas.get("/remetentes", responder(() => revisao.remetentesNaoVinculados(db())));
    rotas.post("/remetentes", responder((req) => revisao.vincularRemetente(db(), cad(), String(req.body?.whatsapp_id || ""),
        String(req.body?.pessoa_id || ""), { regras: regras() })));
    rotas.post("/regerar-pendentes", responder(() => revisao.regenerarPendentes(db(), cad(), { regras: regras() })));

    // Cadastro de projetos / centros de custo (configuracao/projetos.json)
    rotas.get("/projetos", responder(() => ({ ...projetosAdmin.listar(), historico: projetosAdmin.historico(db(), 30) })));
    rotas.post("/projetos", responder((req) => projetosAdmin.criar(db(), req.body?.projeto, req.body?.autor)));
    rotas.post("/projetos/editar", responder((req) => projetosAdmin.editar(db(), String(req.body?.nome_atual || ""), req.body?.alteracoes, req.body?.autor)));

    rotas.get("/midias/:id/imagem", (req, res, next) => {
        try {
            const midia = db().prepare("SELECT arquivo FROM midias WHERE id = ?").get(idDe(req));
            const caminho = midia && localizarArquivo(midia.arquivo);
            if (!caminho) return res.status(404).json({ erro: "Imagem não encontrada." });
            res.setHeader("Cache-Control", "no-store");
            return res.sendFile(caminho);
        } catch (erro) { return next(erro); }
    });
    return rotas;
}

module.exports = { criarRotas, localizarArquivo, lerJson };
