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

/** Resultado do ultimo treino com a planilha (ferramentas/treinar-central.js), se houver. */
function resumoPlanilha() {
    const arquivo = path.join(RAIZ, "dados", "aprendizado", "relatorio-central.json");
    try {
        if (!fs.existsSync(arquivo)) return null;
        const relatorio = JSON.parse(fs.readFileSync(arquivo, "utf8"));
        return {
            gerado_em: relatorio.gerado_em, divisao: relatorio.divisao,
            resultados: relatorio.resultados.map((r) => ({ abordagem: r.abordagem, acerto_geral: r.acerto_geral, precisao: r.precisao, cobertura: r.cobertura,
                por_tipo: r.por_tipo })),
            recomendacoes: relatorio.recomendacoes,
        };
    } catch (_) { return null; }
}

/** Uso do Azure no mes, com o limite do config (pipeline.limite_paginas_azure_mes). */
function situacaoAzure() {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(RAIZ, "config.json"), "utf8"));
        return require("../cota-azure").situacao({ limite: config.pipeline?.limite_paginas_azure_mes ?? undefined });
    } catch (_) { return require("../cota-azure").situacao(); }
}

/** Ultima medicao da versao atual contra as notas aprovadas (ferramentas/medir-contra-aprovadas.js). */
function resumoMaturidade() {
    const arquivo = path.join(RAIZ, "dados", "aprendizado", "medicao-aprovadas.json");
    try {
        if (!fs.existsSync(arquivo)) return null;
        const medicao = JSON.parse(fs.readFileSync(arquivo, "utf8"));
        return { gerado_em: medicao.gerado_em, aprovadas: medicao.aprovadas, ...medicao.maturidade };
    } catch (_) { return null; }
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
function criarRotas({ db = banco, cad = () => cadastros.carregar(), identificarRemetentes = null, contaConectada = () => null } = {}) {
    const rotas = express.Router();
    const responder = (fn) => (req, res, next) => {
        try { res.json(fn(req)); } catch (erro) { next(erro); }
    };

    rotas.get("/opcoes", responder(() => revisao.opcoes(cad())));
    rotas.get("/despesas", responder((req) => revisao.listar(db(), {
        aba: String(req.query.aba || "revisar"), operador: req.query.operador ? String(req.query.operador) : null, cad: cad(),
        de: req.query.de ? String(req.query.de) : null, ate: req.query.ate ? String(req.query.ate) : null,
        pela: req.query.pela === "recebida" ? "recebida" : "nota",
    })));
    rotas.get("/despesas/:id", (req, res, next) => {
        try {
            const detalhe = revisao.detalhar(db(), idDe(req));
            if (!detalhe) return res.status(404).json({ erro: "Despesa não encontrada." });
            const imagem = detalhe.midia && localizarArquivo(detalhe.midia.arquivo);
            return res.json({ ...detalhe, imagem_url: imagem ? `/api/central/midias/${detalhe.midia.id}/imagem` : null });
        } catch (erro) { return next(erro); }
    });
    rotas.post("/despesas/:id/corrigir", responder((req) => revisao.corrigir(db(), cad(), idDe(req), req.body?.alteracoes, req.body?.autor)));
    rotas.post("/despesas/:id/aprovar", responder((req) => revisao.aprovar(db(), idDe(req), req.body?.autor,
        { naoUsarNoTreino: Array.isArray(req.body?.nao_usar_no_treino) ? req.body.nao_usar_no_treino.map(String) : [] })));
    rotas.post("/despesas/:id/descartar", responder((req) => revisao.descartar(db(), idDe(req), req.body?.motivo, req.body?.autor)));
    rotas.post("/despesas/:id/comentario", responder((req) => revisao.comentarParaIa(db(), idDe(req), req.body?.texto, req.body?.autor)));
    rotas.get("/comentarios-ia", responder(() => revisao.comentariosParaIa(db())));
    rotas.post("/despesas/:id/reabrir", responder((req) => revisao.reabrir(db(), idDe(req), req.body?.motivo, req.body?.autor)));
    rotas.post("/despesas/:id/regenerar", responder((req) => revisao.regenerar(db(), cad(), idDe(req), { regras: regras() })));
    rotas.get("/metricas", responder(() => ({ ...revisao.metricas(db(), { nomes: revisao.nomesDasPessoas(cad()) }), planilha: resumoPlanilha(), azure: situacaoAzure(), maturidade: resumoMaturidade() })));
    // Marca o numero conectado ao programa (quem mandou foi a propria conta).
    rotas.get("/remetentes", responder(() => {
        const conta = contaConectada() || {};
        return revisao.remetentesNaoVinculados(db()).map((item) => ({
            ...item, conta_conectada: Boolean(item.remetente_id && [conta.lid, conta.telefone].filter(Boolean).includes(String(item.remetente_id).split("@")[0].split(":")[0])),
        }));
    }));
    // Busca nos contatos do WhatsApp o telefone dos remetentes desconhecidos (precisa estar conectado).
    rotas.post("/remetentes/identificar", async (req, res, next) => {
        try {
            if (!identificarRemetentes) throw new Error("Busca de contatos indisponível: o WhatsApp não está ligado nesta janela.");
            res.json(await identificarRemetentes());
        } catch (erro) { next(erro); }
    });
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
    // --- Assistente (chat pela assinatura Claude da empresa) -------------------
    const assistente = require("../assistente/servico");
    // Regras do operador aprendidas das observacoes (botao "Reclassificar com minhas observações").
    const aprender = require("./aprender-regras");
    const regrasOp = require("./regras-operador");
    const regerarUma = require("./orquestrador").regenerarPrevia;
    rotas.get("/regras-operador", responder(() => regrasOp.listar(db(), { todas: true })));
    rotas.post("/regras-operador/propor", async (req, res, next) => {
        try {
            res.json(await aprender.propor(db(), cad(), { perguntar: require("../assistente/assinatura").perguntar, modelo: String(req.body?.modelo || "") }));
        } catch (erro) { next(erro); }
    });
    rotas.post("/regras-operador/confirmar", responder((req) => aprender.confirmarEReclassificar(db(), cad(),
        Array.isArray(req.body?.regras) ? req.body.regras : [], String(req.body?.autor || "?"), { regenerar: regerarUma, opcoes: { regras: regras() } })));
    rotas.post("/regras-operador/reclassificar", responder(() => aprender.reclassificar(db(), cad(), { regenerar: regerarUma, opcoes: { regras: regras() } })));
    const avisosGerencia = require("./avisos-gerencia");
    rotas.get("/avisos-gerencia", responder(() => avisosGerencia.pendentes(db(), cad())));
    rotas.post("/avisos-gerencia/ler-agora", async (req, res, next) => {
        try { res.json(await avisosGerencia.lerAgora(db(), cad(), { perguntar: require("../assistente/assinatura").perguntar, origem: String(req.body?.origem || "botao") })); } catch (erro) { next(erro); }
    });
    rotas.get("/avisos-gerencia/ultima-leitura", responder(() => avisosGerencia.ultimaLeitura()));
    rotas.post("/avisos-gerencia/:id", responder((req) => avisosGerencia.decidir(db(), cad(), idDe(req), {
        aceito: req.body?.aceito === true, autor: String(req.body?.autor || ""), regenerar: regerarUma, opcoes: { regras: regras() } })));
    rotas.post("/regras-operador/:id/desativar", responder((req) => regrasOp.desativar(db(), idDe(req))));
    rotas.post("/arquivo-drive/executar", responder((req) => require("./arquivo-drive").arquivarPendentes(db(), cad(), { simular: req.body?.simular === true })));
    rotas.get("/assistente/estado", responder(() => assistente.estado()));
    rotas.get("/assistente/conversas", responder((req) => assistente.listarConversas(db(), { pessoa: req.query.pessoa ? String(req.query.pessoa) : null })));
    rotas.get("/assistente/conversas/:id", responder((req) => assistente.lerConversa(db(), idDe(req))));
    rotas.get("/assistente/sugestoes", responder(() => assistente.sugestoes(db())));
    rotas.post("/assistente/sugestoes/:id", responder((req) => assistente.mudarSugestao(db(), idDe(req), String(req.body?.status || ""))));
    // Arquivo criado ou achado pelo assistente (modo completo): so dentro das pastas liberadas, nunca segredos.
    rotas.get("/assistente/arquivo", (req, res) => {
        const caminho = require("../assistente/assinatura").arquivoLiberado(req.query.caminho);
        if (!caminho) return res.status(404).json({ erro: "Arquivo não encontrado ou fora das pastas liberadas." });
        if (req.query.baixar === "1") return res.download(caminho);
        return res.sendFile(caminho, { dotfiles: "allow" });
    });
    rotas.get("/assistente/anexos/:conversa/:arquivo", (req, res) => {
        const caminho = require("../assistente/anexos").caminhoDoAnexo(req.params.conversa, req.params.arquivo);
        if (!caminho) return res.status(404).json({ erro: "Anexo não encontrado." });
        return res.sendFile(caminho);
    });
    rotas.post("/assistente/parar", responder(() => ({ parado: assistente.parar() })));
    // Resposta ao vivo: uma linha JSON por evento (texto chegando, ferramenta, fim).
    rotas.post("/assistente/enviar", async (req, res) => {
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        const escrever = (evento) => { try { res.write(`${JSON.stringify(evento)}\n`); } catch (_) { /* tela fechada */ } };
        try {
            const final = await assistente.enviar(db(), {
                pessoa: req.body?.pessoa, texto: req.body?.texto, anexos: Array.isArray(req.body?.anexos) ? req.body.anexos : [], conversaId: req.body?.conversa_id || null,
                modelo: String(req.body?.modelo || ""), emitir: escrever, sinal: {},
            });
            escrever({ ...final, resultado: final.tipo, tipo: "final" });
        } catch (erro) {
            escrever({ tipo: "falha", erro: erro.message });
        }
        res.end();
    });
    rotas.post("/assistente/propostas/:id", async (req, res, next) => {
        try {
            res.json(await assistente.decidir(db(), idDe(req), { pessoa: req.body?.pessoa, aceito: req.body?.aceito === true,
                rodar: require("../assistente/assinatura").rodarTurno,
                ctx: { cad: cad(), regerar: () => revisao.regenerarPendentes(db(), cad(), { regras: regras() }).regeradas } }));
        } catch (erro) { next(erro); }
    });

    return rotas;
}

module.exports = { criarRotas, localizarArquivo, lerJson };
