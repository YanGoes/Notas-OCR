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
const { habitosDoOperador } = require("./habitos");
const { INTENCOES, interpretar } = require("./interpretador");

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
        INSERT INTO despesas (documento_id, midia_id, mensagem_ref, lote_id, estado, campos, campos_originais, pendencias, avisos,
            duplicada_de, criado_em, atualizado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        documentoId, midiaId, mensagemRef, loteId, estadoFinal, json(previa.campos), json(previa.campos), json(previa.pendencias),
        json(previa.avisos), duplicadaDe, agora(), agora());
    const id = Number(lastInsertRowid);
    registrarHistorico(db, id, null, estadoFinal, "previa_gerada");
    return id;
}

/** Legenda da foto interpretada, com o texto bruto (usado em regras especiais). */
function legendaInterpretada(registro, textoLegenda) {
    return { ...(registro?.interpretacao?.dados || {}), texto: textoLegenda || "" };
}

// Campos que uma "Correção: ..." respondendo a foto substitui na legenda.
const CAMPOS_CORRIGIVEIS = ["tipos", "pessoas", "pagamento", "projeto_texto", "valor_declarado", "data_declarada", "material", "observacoes"];

/**
 * Aplica sobre a legenda as correcoes que o PROPRIO operador mandou
 * respondendo a foto ("Correção: Janta 2"), na ordem em que chegaram.
 */
function aplicarCorrecoes(db, cad, legenda, { grupoId, mensagemId, remetenteId, pessoa = null }) {
    if (!mensagemId) return legenda;
    const correcoes = db.prepare(`
        SELECT texto, enviada_em FROM mensagens WHERE grupo_id = ? AND citado_id = ? AND remetente_id = ? AND intencao = ?
        ORDER BY enviada_em, id`).all(String(grupoId), String(mensagemId), String(remetenteId), INTENCOES.CORRECAO_DESPESA);
    let resultado = legenda;
    for (const correcao of correcoes) {
        const dados = interpretar(cad, { texto: correcao.texto || "", temMidia: true, pessoa, referencia: correcao.enviada_em }).dados || {};
        const novo = { ...resultado };
        for (const campo of CAMPOS_CORRIGIVEIS) {
            const valor = dados[campo];
            if (valor === null || valor === undefined || valor === false || (Array.isArray(valor) && !valor.length)) continue;
            novo[campo] = valor;
        }
        // Trocou o tipo sem dizer pessoas: as pessoas antigas eram do outro tipo.
        if (dados.tipos?.length && !dados.pessoas && resultado.pessoas?.tipo && !dados.tipos.includes(resultado.pessoas.tipo)) novo.pessoas = null;
        novo.corrigida_pelo_operador = true;
        resultado = novo;
    }
    return resultado;
}

/** Refaz as previas ainda sem revisao humana (ignora as que nao podem ser refeitas). */
function regenerarVarias(db, cad, ids, opcoes) {
    const refeitas = [];
    for (const id of ids) {
        try { regenerarPrevia(db, cad, id, opcoes); refeitas.push(id); } catch (_) { /* revisada por pessoa ou fora de revisao */ }
    }
    return refeitas;
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
function processarFoto(db, cad, { arquivo, sha256, meta = {}, brutoAzure = null, modelId = "prebuilt-receipt", erroLeitura = null, regras = {}, hoje = new Date(), obterHabitos = null }) {
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

        const legenda = aplicarCorrecoes(db, cad, legendaInterpretada(registro, meta.legenda),
            { grupoId, mensagemId: meta.id_mensagem, remetenteId, pessoa: registro.pessoa?.pessoa });
        const politica = (texto) => contexto.politicaCartao(db, texto ? contexto.chaveProjeto(cad, texto).chave : null, momento);
        const politicaVigente = politica(legenda.projeto_texto || ctx.projeto?.texto);
        // obterHabitos: a medicao passa os habitos de OUTRO banco (sem a propria nota).
        const habitos = obterHabitos ? obterHabitos(registro.pessoa?.pessoa?.id) : habitosDoOperador(db, registro.pessoa?.pessoa?.id);
        const base = { legenda, contexto: ctx, politica: politicaVigente, identificacao: registro.pessoa, cad, regras, hoje, habitos };

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
    const intencao = registro.interpretacao?.intencao;
    if (registro.nova && intencao === INTENCOES.ORIENTACAO_GERENCIA) {
        // Vale tambem para as notas do periodo que ja chegaram.
        const ids = db.prepare(`
            SELECT d.id FROM despesas d JOIN mensagens m ON m.id = d.mensagem_ref
            WHERE m.grupo_id = ? AND d.estado IN ('AGUARDANDO_REVISAO', 'CLASSIFICADO')`).all(String(msg.grupoId)).map((linha) => linha.id);
        return { ...registro, despesa: null, refeitas: regenerarVarias(db, cad, ids, { regras, hoje }) };
    }
    if (registro.nova && intencao === INTENCOES.CORRECAO_DESPESA && msg.citadoId) {
        const ids = db.prepare(`
            SELECT d.id FROM despesas d JOIN midias md ON md.id = d.midia_id
            WHERE md.grupo_id = ? AND md.mensagem_id = ? AND md.remetente_id = ?`).all(String(msg.grupoId), String(msg.citadoId), String(msg.remetenteId))
            .map((linha) => linha.id);
        return { ...registro, despesa: null, refeitas: regenerarVarias(db, cad, ids, { regras, hoje }) };
    }
    if (!registro.nova || intencao !== INTENCOES.INFORMACAO_DESPESA || !dados.sem_comprovante) {
        return { ...registro, despesa: null };
    }
    const ctx = contexto.contextoPara(db, cad, { grupoId: msg.grupoId, remetenteId: msg.remetenteId, momento: msg.enviadaEm });
    const legenda = { ...dados, texto: msg.texto || "" };
    const projetoTexto = legenda.projeto_texto || ctx.projeto?.texto;
    const politica = contexto.politicaCartao(db, projetoTexto ? contexto.chaveProjeto(cad, projetoTexto).chave : null, msg.enviadaEm);
    const previa = montarPrevia({ ocr: null, legenda, contexto: ctx, politica, identificacao: registro.pessoa, cad, regras, hoje,
        habitos: habitosDoOperador(db, registro.pessoa?.pessoa?.id) });
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
        campos_originais: lerJson(linha.campos_originais, null),
        pendencias: lerJson(linha.pendencias, []),
        avisos: lerJson(linha.avisos, []),
    };
}

const ESTADOS_REGERAVEIS = ["AGUARDANDO_REVISAO", "CLASSIFICADO"];

/**
 * Gera de novo a previa de uma despesa com os cadastros ATUAIS (ex.: depois de
 * vincular o remetente ou confirmar um projeto). Usa a leitura ja guardada:
 * nao chama o Azure de novo. Despesa com correcao humana nao e regerada, para
 * nao apagar o trabalho de quem revisou.
 */
function regenerarPrevia(db, cad, despesaId, { regras = {}, hoje = new Date() } = {}) {
    const despesa = lerDespesa(db, despesaId);
    if (!despesa) throw new Error(`Despesa #${despesaId} não encontrada.`);
    if (!ESTADOS_REGERAVEIS.includes(despesa.estado)) throw new Error(`Despesa #${despesaId} está ${despesa.estado}; só prévias em revisão podem ser regeradas.`);
    if (db.prepare("SELECT 1 FROM correcoes WHERE despesa_id = ? LIMIT 1").get(despesaId)) {
        throw new Error(`Despesa #${despesaId} já tem correções humanas; não será regerada.`);
    }
    const mensagem = despesa.mensagem_ref ? db.prepare("SELECT * FROM mensagens WHERE id = ?").get(despesa.mensagem_ref) : null;
    if (!mensagem) throw new Error(`Despesa #${despesaId} sem mensagem de origem.`);
    const midia = despesa.midia_id ? db.prepare("SELECT * FROM midias WHERE id = ?").get(despesa.midia_id) : null;
    const documento = despesa.documento_id ? db.prepare("SELECT * FROM documentos WHERE id = ?").get(despesa.documento_id) : null;
    const momento = midia?.recebida_em || mensagem.enviada_em;

    const identificacao = contexto.identificar(db, cad, mensagem.remetente_id, mensagem.remetente_nome);
    const interpretacao = interpretar(cad, { texto: mensagem.texto || "", temMidia: Boolean(midia), pessoa: identificacao.pessoa,
        nomeRemetente: mensagem.remetente_nome, referencia: mensagem.enviada_em });
    const legenda = aplicarCorrecoes(db, cad, { ...(interpretacao.dados || {}), texto: mensagem.texto || "" },
        { grupoId: mensagem.grupo_id, mensagemId: midia?.mensagem_id, remetenteId: mensagem.remetente_id, pessoa: identificacao.pessoa });
    const ctx = contexto.contextoPara(db, cad, { grupoId: mensagem.grupo_id, remetenteId: mensagem.remetente_id, momento });
    const projetoTexto = legenda.projeto_texto || ctx.projeto?.texto;
    const politica = contexto.politicaCartao(db, projetoTexto ? contexto.chaveProjeto(cad, projetoTexto, identificacao.pessoa).chave : null, momento);
    const leituraFalhou = Boolean(midia) && !documento;
    const ocr = documento ? lerJson(documento.ocr, {}) : leituraFalhou ? { erro_leitura: true } : null;

    const previa = montarPrevia({ ocr, legenda, contexto: ctx, politica, identificacao, cad, regras, hoje,
        habitos: habitosDoOperador(db, identificacao.pessoa?.id) });
    if (leituraFalhou) previa.pendencias.unshift("Leitura automática falhou. Leia a imagem manualmente.");
    if (despesa.duplicada_de) previa.pendencias.push(`Possível duplicidade com a despesa #${despesa.duplicada_de} (mesmo emissor, data, valor e hora). Confirme se são compras diferentes.`);
    const estado = previa.pendencias.length ? "AGUARDANDO_REVISAO" : "CLASSIFICADO";

    transacao(db, () => {
        db.prepare(`UPDATE despesas SET campos = ?, campos_originais = ?, pendencias = ?, avisos = ?, estado = ?, atualizado_em = ?
            WHERE id = ?`).run(json(previa.campos), json(previa.campos), json(previa.pendencias), json(previa.avisos), estado, agora(), despesaId);
        registrarHistorico(db, despesaId, despesa.estado, estado, "previa_regerada_com_cadastros_atuais");
    });
    return lerDespesa(db, despesaId);
}

module.exports = { processarFoto, processarMensagemTexto, lerDespesa, regenerarPrevia, registrarHistorico, momentoDaMeta, ESTADOS_REGERAVEIS };
