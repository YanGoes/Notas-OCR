"use strict";

// =============================================================================
// ORQUESTRADOR DA CENTRAL — da foto lida as despesas em PREVIA
// =============================================================================
//
// Foto -> (repetida?) -> 1..N comprovantes -> duplicidade por documento ->
// contexto do operador -> regras VMac -> despesa no banco.
//
// Este modulo NAO lanca nada no Conta Azul e nao copia nada para o Drive:
// produz previas para revisao na Central. A publicacao sera uma acao separada,
// com aprovacao explicita.
// =============================================================================

const { agora, json, lerJson, transacao } = require("./banco");
const contexto = require("./contexto");
const { dividirDocumentos, chaveNfce, impressaoDigital } = require("./documentos");
const { montarPrevia } = require("./regras-vmac");
const { INTENCOES } = require("./interpretador");

function momentoDaMeta(meta = {}) {
    if (Number(meta.recebido_em_ms)) return new Date(Number(meta.recebido_em_ms)).toISOString();
    if (Number(meta.timestamp)) return new Date(Number(meta.timestamp) * 1000).toISOString();
    return new Date().toISOString();
}

function registrarHistorico(db, despesaId, de, para, motivo) {
    db.prepare("INSERT INTO historico_estados (despesa_id, de, para, motivo, em) VALUES (?, ?, ?, ?, ?)")
        .run(despesaId, de, para, motivo || null, agora());
}

function inserirDespesa(db, { documentoId = null, midiaId = null, mensagemRef = null, loteId = null, previa, duplicadaDe = null, estado = null }) {
    const estadoFinal = estado || previa.estado;
    const { lastInsertRowid } = db.prepare(`
        INSERT INTO despesas (documento_id, midia_id, mensagem_ref, lote_id, estado, campos, pendencias, avisos,
            duplicada_de, criado_em, atualizado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        documentoId, midiaId, mensagemRef, loteId, estadoFinal, json(previa.campos), json(previa.pendencias),
        json(previa.avisos), duplicadaDe, agora(), agora());
    const id = Number(lastInsertRowid);
    registrarHistorico(db, id, null, estadoFinal, "previa_gerada");
    return id;
}

/** Legenda da foto interpretada, com o texto bruto (usado em regras especiais). */
function legendaInterpretada(registro, textoLegenda) {
    return { ...(registro?.interpretacao?.dados || {}), texto: textoLegenda || "" };
}

/**
 * Processa uma foto ja lida pelo OCR.
 *
 * @param {object} db
 * @param {object} cad
 * @param {object} entrada
 * @param {string} entrada.arquivo — nome do arquivo da foto (identidade da midia)
 * @param {string} entrada.sha256 — hash do arquivo
 * @param {object} entrada.meta — metadados gravados pelo coletor
 * @param {object|null} entrada.brutoAzure — resposta bruta do Azure (null se a leitura falhou)
 * @param {string} [entrada.erroLeitura]
 * @param {object} [entrada.regras]
 * @returns {{midiaId:number, repetida:boolean, despesas:number[]}}
 */
function processarFoto(db, cad, { arquivo, sha256, meta = {}, brutoAzure = null, modelId = "prebuilt-receipt", erroLeitura = null, regras = {}, hoje = new Date() }) {
    const existente = db.prepare("SELECT id FROM midias WHERE arquivo = ?").get(String(arquivo));
    if (existente) {
        const despesas = db.prepare("SELECT id FROM despesas WHERE midia_id = ?").all(existente.id).map((linha) => linha.id);
        return { midiaId: existente.id, repetida: false, ja_processada: true, despesas };
    }

    const grupoId = String(meta.id_grupo || "manual");
    const remetenteId = String(meta.remetente || "desconhecido");
    const momento = momentoDaMeta(meta);
    const registro = contexto.registrarMensagem(db, cad, {
        grupoId, mensagemId: String(meta.id_mensagem || `arquivo:${arquivo}`), remetenteId,
        remetenteNome: meta.remetente_nome || null, enviadaEm: momento, texto: meta.legenda || "", temMidia: true,
    });
    const ctx = contexto.contextoPara(db, cad, { grupoId, remetenteId, momento });

    return transacao(db, () => {
        // A mesma imagem (byte a byte) ja chegou antes: nenhuma despesa nova.
        const anterior = db.prepare("SELECT id FROM midias WHERE sha256 = ? ORDER BY id LIMIT 1").get(String(sha256));
        const { lastInsertRowid } = db.prepare(`
            INSERT INTO midias (sha256, arquivo, grupo_id, remetente_id, mensagem_id, recebida_em, legenda, lote_id,
                repete_midia_id, registrada_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            String(sha256), String(arquivo), grupoId, remetenteId, meta.id_mensagem || null, momento,
            meta.legenda || null, ctx.lote?.id || null, anterior?.id || null, agora());
        const midiaId = Number(lastInsertRowid);
        if (anterior) return { midiaId, repetida: true, repete_midia_id: anterior.id, despesas: [] };

        const legenda = legendaInterpretada(registro, meta.legenda);
        const politica = (texto) => contexto.politicaCartao(db, texto ? contexto.chaveProjeto(cad, texto).chave : null, momento);
        const politicaVigente = politica(legenda.projeto_texto || ctx.projeto?.texto);
        const base = { legenda, contexto: ctx, politica: politicaVigente, identificacao: registro.pessoa, cad, regras, hoje };

        if (!brutoAzure) {
            const previa = montarPrevia({ ...base, ocr: { erro_leitura: erroLeitura } });
            previa.pendencias.unshift(`Leitura automática falhou${erroLeitura ? `: ${erroLeitura}` : ""}. Leia a imagem manualmente.`);
            const id = inserirDespesa(db, { midiaId, mensagemRef: registro.mensagemRef, loteId: ctx.lote?.id, previa, estado: "AGUARDANDO_REVISAO" });
            return { midiaId, repetida: false, despesas: [id] };
        }

        const documentos = dividirDocumentos(brutoAzure, modelId);
        const idPorIndice = new Map();
        const despesas = [];
        // Principais primeiro, para os complementares apontarem para eles.
        for (const documento of [...documentos].sort((a, b) => (a.papel === "PRINCIPAL" ? -1 : 1) - (b.papel === "PRINCIPAL" ? -1 : 1))) {
            const chave = chaveNfce(documento.ocr);
            const digital = impressaoDigital(documento.ocr);
            const { lastInsertRowid: documentoId } = db.prepare(`
                INSERT INTO documentos (midia_id, indice, ocr, chave_nfce, impressao_digital, papel, principal_id, criado_em)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
                midiaId, documento.indice, json(documento.ocr), chave, digital, documento.papel,
                documento.principal_indice != null ? idPorIndice.get(documento.principal_indice) ?? null : null, agora());
            idPorIndice.set(documento.indice, Number(documentoId));
            if (documento.papel !== "PRINCIPAL") continue;

            const previa = montarPrevia({ ...base, ocr: documento.ocr });

            // Mesma nota fiscal (chave NFC-e) ja registrada em outra foto: nao gera despesa nova.
            const mesmaNota = chave ? db.prepare(`
                SELECT d.id AS despesa_id FROM documentos doc JOIN despesas d ON d.documento_id = doc.id
                WHERE doc.chave_nfce = ? AND doc.midia_id <> ? AND d.estado <> 'BLOQUEADO_DUPLICADO' ORDER BY d.id LIMIT 1`).get(chave, midiaId) : null;
            if (mesmaNota) {
                previa.pendencias = [`Mesma nota fiscal (chave NFC-e) já registrada na despesa #${mesmaNota.despesa_id}.`];
                despesas.push(inserirDespesa(db, { documentoId: Number(documentoId), midiaId, mensagemRef: registro.mensagemRef,
                    loteId: ctx.lote?.id, previa, duplicadaDe: mesmaNota.despesa_id, estado: "BLOQUEADO_DUPLICADO" }));
                continue;
            }

            // Mesmo emissor, data, valor e hora em outra foto: so suspeita, vai para revisao.
            const parecida = digital ? db.prepare(`
                SELECT d.id AS despesa_id FROM documentos doc JOIN despesas d ON d.documento_id = doc.id
                WHERE doc.impressao_digital = ? AND doc.midia_id <> ? ORDER BY d.id LIMIT 1`).get(digital, midiaId) : null;
            if (parecida) {
                previa.pendencias.push(`Possível duplicidade com a despesa #${parecida.despesa_id} (mesmo emissor, data, valor e hora). Confirme se são compras diferentes.`);
                previa.estado = "AGUARDANDO_REVISAO";
            }
            despesas.push(inserirDespesa(db, { documentoId: Number(documentoId), midiaId, mensagemRef: registro.mensagemRef,
                loteId: ctx.lote?.id, previa, duplicadaDe: parecida?.despesa_id || null }));
        }
        return { midiaId, repetida: false, despesas, documentos: documentos.length };
    });
}

/**
 * Registra uma mensagem de texto do grupo. Quando ela informa uma despesa SEM
 * comprovante ("perdi a notinha"), ja cria a despesa pendente de revisao.
 */
function processarMensagemTexto(db, cad, msg, { regras = {}, hoje = new Date() } = {}) {
    const registro = contexto.registrarMensagem(db, cad, { ...msg, temMidia: false });
    const dados = registro.interpretacao?.dados || {};
    if (!registro.nova || registro.interpretacao?.intencao !== INTENCOES.INFORMACAO_DESPESA || !dados.sem_comprovante) {
        return { ...registro, despesa: null };
    }
    const ctx = contexto.contextoPara(db, cad, { grupoId: msg.grupoId, remetenteId: msg.remetenteId, momento: msg.enviadaEm });
    const legenda = { ...dados, texto: msg.texto || "" };
    const projetoTexto = legenda.projeto_texto || ctx.projeto?.texto;
    const politica = contexto.politicaCartao(db, projetoTexto ? contexto.chaveProjeto(cad, projetoTexto).chave : null, msg.enviadaEm);
    const previa = montarPrevia({ ocr: null, legenda, contexto: ctx, politica, identificacao: registro.pessoa, cad, regras, hoje });
    const id = transacao(db, () => inserirDespesa(db, { mensagemRef: registro.mensagemRef, loteId: ctx.lote?.id, previa, estado: "AGUARDANDO_REVISAO" }));
    return { ...registro, despesa: id };
}

/** Despesa completa para exibir/auditar (campos ja desserializados). */
function lerDespesa(db, id) {
    const linha = db.prepare("SELECT * FROM despesas WHERE id = ?").get(id);
    if (!linha) return null;
    return {
        ...linha,
        campos: lerJson(linha.campos, {}),
        pendencias: lerJson(linha.pendencias, []),
        avisos: lerJson(linha.avisos, []),
    };
}

module.exports = { processarFoto, processarMensagemTexto, lerDespesa, momentoDaMeta };
