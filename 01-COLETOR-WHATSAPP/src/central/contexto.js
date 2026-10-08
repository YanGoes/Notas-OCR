"use strict";

// =============================================================================
// CONTEXTO TEMPORAL DAS CONVERSAS
// =============================================================================
//
// Registra toda mensagem relevante no banco e responde, para uma foto que
// chegou num certo momento, qual era o contexto daquele operador naquele grupo:
//
//   - lote do dia (cabecalho "Despesas 30/09/2026 ..." enviado antes das fotos);
//   - projeto vigente (continua valendo entre dias ate o operador trocar);
//   - cartao declarado pelo operador no lote;
//   - politica de cartao do projeto definida pela gerencia (Vanessa), valida
//     desde a mensagem ate ser substituida.
//
// Contexto NUNCA atravessa operadores: o cabecalho do Almir nao vale para a
// foto do Vitor, mesmo no mesmo grupo.
// =============================================================================

const { agora, json, lerJson, transacao } = require("./banco");
const { normalizar } = require("./texto");
const cadastros = require("./cadastros");
const { interpretar, INTENCOES } = require("./interpretador");

/** Chave estavel do projeto: nome oficial quando resolvido, senao o texto normalizado. */
function chaveProjeto(cad, texto) {
    const resolucao = cadastros.resolverProjeto(cad, texto);
    return {
        chave: resolucao.status === "RESOLVIDO" ? normalizar(resolucao.projeto.nome_oficial) : normalizar(texto),
        resolucao,
    };
}

function vinculosConfirmados(db) {
    return new Map(db.prepare("SELECT whatsapp_id, pessoa_id FROM remetentes_vinculados").all()
        .map((linha) => [linha.whatsapp_id, linha.pessoa_id]));
}

function identificar(db, cad, remetenteId, nomeExibido) {
    return cadastros.identificarPessoa(cad, remetenteId, { vinculos: vinculosConfirmados(db), nomeExibido });
}

/**
 * Registra uma mensagem (com ou sem foto) e o contexto que ela cria.
 * Idempotente: a mesma mensagem registrada duas vezes devolve o registro existente.
 *
 * @returns {{mensagemRef:number, interpretacao:object, pessoa:object, loteId:number|null, nova:boolean}}
 */
function registrarMensagem(db, cad, msg) {
    const existente = db.prepare("SELECT * FROM mensagens WHERE grupo_id = ? AND mensagem_id = ?")
        .get(String(msg.grupoId), String(msg.mensagemId));
    if (existente) {
        const lote = db.prepare("SELECT id FROM lotes WHERE mensagem_ref = ?").get(existente.id);
        return {
            mensagemRef: existente.id, interpretacao: lerJson(existente.interpretacao, {}),
            pessoa: identificar(db, cad, existente.remetente_id, existente.remetente_nome),
            loteId: lote?.id || null, nova: false,
        };
    }

    const identificacao = identificar(db, cad, msg.remetenteId, msg.remetenteNome);
    const interpretacao = interpretar(cad, {
        texto: msg.texto, temMidia: Boolean(msg.temMidia),
        pessoa: identificacao.pessoa, nomeRemetente: msg.remetenteNome,
    });
    const enviadaEm = new Date(msg.enviadaEm || Date.now()).toISOString();

    return transacao(db, () => {
        const { lastInsertRowid: mensagemRef } = db.prepare(`
            INSERT INTO mensagens (grupo_id, mensagem_id, remetente_id, remetente_nome, pessoa_id, enviada_em,
                texto, citado_id, tem_midia, intencao, interpretacao, registrada_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            String(msg.grupoId), String(msg.mensagemId), String(msg.remetenteId), msg.remetenteNome || null,
            identificacao.pessoa?.id || null, enviadaEm, msg.texto || null, msg.citadoId || null,
            msg.temMidia ? 1 : 0, interpretacao.intencao, json(interpretacao), agora());

        const dados = interpretacao.dados;
        const evento = (tipo, extra) => db.prepare(`
            INSERT INTO eventos_contexto (tipo, grupo_id, remetente_id, autor_pessoa_id, projeto_texto, projeto_chave,
                cartao, valido_desde, mensagem_ref, status, dados, criado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            tipo, String(msg.grupoId), String(msg.remetenteId), identificacao.pessoa?.id || null,
            extra.projetoTexto || null, extra.projetoChave || null, extra.cartao || null, enviadaEm,
            Number(mensagemRef), extra.status || "VALIDO", json(extra.dados || null), agora());

        let loteId = null;
        if (interpretacao.intencao === INTENCOES.INICIO_LOTE_DIARIO) {
            const projeto = dados.projeto_texto ? chaveProjeto(cad, dados.projeto_texto) : null;
            ({ lastInsertRowid: loteId } = db.prepare(`
                INSERT INTO lotes (grupo_id, remetente_id, data_declarada, projeto_texto, projeto_chave, cartao,
                    quantidades, observacoes, mensagem_ref, criado_em)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                String(msg.grupoId), String(msg.remetenteId), dados.data_declarada, dados.projeto_texto,
                projeto?.chave || null, dados.pagamento ? json(dados.pagamento) : null,
                json({ refeicoes_e_tipos: dados.quantidades, itens: dados.itens_citados, pessoas: dados.pessoas, tipos: dados.tipos }),
                json(dados.observacoes), Number(mensagemRef), enviadaEm));
            loteId = Number(loteId);
            if (projeto) evento("DEFINICAO_PROJETO", { projetoTexto: dados.projeto_texto, projetoChave: projeto.chave });
        } else if (interpretacao.intencao === INTENCOES.DEFINICAO_PROJETO) {
            const projeto = chaveProjeto(cad, dados.projeto_texto);
            evento("DEFINICAO_PROJETO", { projetoTexto: dados.projeto_texto, projetoChave: projeto.chave });
        } else if (interpretacao.intencao === INTENCOES.DEFINICAO_CARTAO_POR_PROJETO) {
            const projeto = chaveProjeto(cad, dados.projeto_texto);
            evento("DEFINICAO_CARTAO_POR_PROJETO", {
                projetoTexto: dados.projeto_texto, projetoChave: projeto.chave, cartao: dados.pagamento.cartao,
                // Instrucao de cartao de quem nao tem autoridade fica registrada, mas nao vale.
                status: interpretacao.autorizada ? "VALIDO" : "SEM_AUTORIDADE",
                dados: { resolucao_projeto: projeto.resolucao.status },
            });
        } else if (msg.temMidia && dados.projeto_texto) {
            // Projeto escrito na legenda de uma foto tambem passa a ser o projeto atual do operador.
            const projeto = chaveProjeto(cad, dados.projeto_texto);
            evento("DEFINICAO_PROJETO", { projetoTexto: dados.projeto_texto, projetoChave: projeto.chave });
        }
        return { mensagemRef: Number(mensagemRef), interpretacao, pessoa: identificacao, loteId, nova: true };
    });
}

/**
 * Contexto vigente para uma foto (ou despesa sem foto) de um operador.
 *
 * @param {object} db
 * @param {object} cad
 * @param {object} alvo — { grupoId, remetenteId, momento (ISO ou ms) }
 * @param {object} [opcoes]
 * @param {number} [opcoes.horasLote=36] — por quanto tempo um cabecalho de lote
 *   ainda se aplica as fotos seguintes do mesmo operador.
 */
function contextoPara(db, cad, { grupoId, remetenteId, momento }, { horasLote = 36 } = {}) {
    const ate = new Date(momento || Date.now()).toISOString();
    const desde = new Date(new Date(ate).getTime() - horasLote * 3600 * 1000).toISOString();

    const loteLinha = db.prepare(`
        SELECT * FROM lotes WHERE grupo_id = ? AND remetente_id = ? AND criado_em <= ? AND criado_em >= ?
        ORDER BY criado_em DESC, id DESC LIMIT 1`).get(String(grupoId), String(remetenteId), ate, desde);
    const lote = loteLinha ? {
        id: loteLinha.id,
        data_declarada: loteLinha.data_declarada,
        projeto_texto: loteLinha.projeto_texto,
        pagamento: lerJson(loteLinha.cartao, null),
        quantidades: lerJson(loteLinha.quantidades, {}),
        observacoes: lerJson(loteLinha.observacoes, []),
        criado_em: loteLinha.criado_em,
    } : null;

    // Projeto: ultimo definido pelo operador neste grupo, sem limite de dias.
    const projetoEvento = db.prepare(`
        SELECT * FROM eventos_contexto WHERE tipo = 'DEFINICAO_PROJETO' AND status = 'VALIDO'
          AND grupo_id = ? AND remetente_id = ? AND valido_desde <= ?
        ORDER BY valido_desde DESC, id DESC LIMIT 1`).get(String(grupoId), String(remetenteId), ate);
    const projeto = projetoEvento ? {
        texto: projetoEvento.projeto_texto,
        chave: projetoEvento.projeto_chave,
        desde: projetoEvento.valido_desde,
        resolucao: cadastros.resolverProjeto(cad, projetoEvento.projeto_texto),
        origem: lote && lote.projeto_texto === projetoEvento.projeto_texto ? "cabecalho_do_lote" : "mensagem_anterior_do_operador",
    } : null;

    return { lote, projeto, momento: ate };
}

/** Politica de cartao da gerencia valida para o projeto naquele momento (ultima instrucao vence). */
function politicaCartao(db, projetoChave, momento) {
    if (!projetoChave) return null;
    const linha = db.prepare(`
        SELECT * FROM eventos_contexto WHERE tipo = 'DEFINICAO_CARTAO_POR_PROJETO' AND status = 'VALIDO'
          AND projeto_chave = ? AND valido_desde <= ?
        ORDER BY valido_desde DESC, id DESC LIMIT 1`).get(projetoChave, new Date(momento || Date.now()).toISOString());
    return linha ? { cartao: linha.cartao, autor: linha.autor_pessoa_id, desde: linha.valido_desde, evento_id: linha.id } : null;
}

/** Confirma (pela Central) que um id do WhatsApp pertence a uma pessoa do cadastro. */
function vincularRemetente(db, whatsappId, pessoaId, origem = "confirmacao_humana") {
    db.prepare(`INSERT INTO remetentes_vinculados (whatsapp_id, pessoa_id, origem, vinculado_em) VALUES (?, ?, ?, ?)
        ON CONFLICT(whatsapp_id) DO UPDATE SET pessoa_id = excluded.pessoa_id, origem = excluded.origem, vinculado_em = excluded.vinculado_em`)
        .run(String(whatsappId), String(pessoaId), origem, agora());
    db.prepare("UPDATE mensagens SET pessoa_id = ? WHERE remetente_id = ?").run(String(pessoaId), String(whatsappId));
}

module.exports = { registrarMensagem, contextoPara, politicaCartao, vincularRemetente, chaveProjeto, identificar };
