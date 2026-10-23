"use strict";

// =============================================================================
// REGRAS DO OPERADOR (aprendidas das observacoes do revisor e da gerencia)
// =============================================================================
//
// "Almir esta no IMTRAFF - MOTIVA RIO/SP de agora em diante", "o Almir usa
// sempre o Inter": viram regras confirmadas por pessoa, com data de inicio.
// Valem quando a mensagem da foto e o cabecalho do dia nao dizem o centro ou o
// cartao. Uma regra nova do mesmo campo encerra a anterior (o operador muda de
// projeto: a regra acompanha).
//
// Aqui tambem fica a frota recente de cada operador (placas e km dos ultimos
// dias), para deduzir a placa de um abastecimento sem placa pelo km.
// =============================================================================

const { agora } = require("./banco");

const CAMPOS = ["centro", "cartao"];
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function listar(db, { pessoaId = null, todas = false } = {}) {
    return db.prepare(`SELECT * FROM regras_operador WHERE (? IS NULL OR pessoa_id = ?) ${todas ? "" : "AND ativa = 1"}
        ORDER BY pessoa_id, campo, desde DESC, id DESC`).all(pessoaId, pessoaId);
}

/** A regra do campo que vale na data (a de inicio mais recente ate a data). */
function regraPara(regras, campo, data) {
    const dia = DATA_ISO.test(String(data || "")) ? data : new Date().toISOString().slice(0, 10);
    return (regras || []).filter((r) => r.campo === campo && r.ativa !== 0 && r.desde <= dia && (!r.ate || r.ate >= dia))
        .sort((a, b) => b.desde.localeCompare(a.desde) || b.id - a.id)[0] || null;
}

/**
 * Grava regras confirmadas. A regra anterior do mesmo operador e campo,
 * comecada antes, passa a terminar no dia anterior a nova.
 */
function salvar(db, regras, autor) {
    const gravadas = [];
    for (const r of regras) {
        if (!r.pessoa_id || !CAMPOS.includes(r.campo) || !r.valor || !DATA_ISO.test(String(r.desde || ""))) throw new Error("Regra incompleta (pessoa, campo, valor e data de início).");
        const vespera = new Date(`${r.desde}T12:00:00Z`);
        vespera.setUTCDate(vespera.getUTCDate() - 1);
        db.prepare(`UPDATE regras_operador SET ate = ? WHERE pessoa_id = ? AND campo = ? AND ativa = 1 AND desde < ? AND (ate IS NULL OR ate >= ?)`)
            .run(vespera.toISOString().slice(0, 10), r.pessoa_id, r.campo, r.desde, r.desde);
        // Mesma regra repetida (mesmo valor e inicio): nao duplica.
        const igual = db.prepare("SELECT id FROM regras_operador WHERE pessoa_id = ? AND campo = ? AND valor = ? AND desde = ? AND ativa = 1").get(r.pessoa_id, r.campo, r.valor, r.desde);
        if (igual) { gravadas.push(igual.id); continue; }
        gravadas.push(Number(db.prepare(`INSERT INTO regras_operador (pessoa_id, campo, valor, desde, ate, fonte, criada_por, em, ativa)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(r.pessoa_id, r.campo, String(r.valor), r.desde, r.ate || null, String(r.fonte || "").slice(0, 500), autor || "?", agora()).lastInsertRowid));
    }
    return gravadas;
}

function desativar(db, id) {
    db.prepare("UPDATE regras_operador SET ativa = 0 WHERE id = ?").run(Number(id));
    return { id: Number(id), ativa: false };
}

// ---------------------------------------------------------------------------
// Frota recente do operador (para placa deduzida pelo km)
// ---------------------------------------------------------------------------

const OPERADOR_SQL = "COALESCE(msg.pessoa_id, json_extract(d.campos, '$.remetente.pessoa_id'))";

/**
 * Abastecimentos com placa e km do operador nos 10 dias ate a data da nota.
 * Devolve uma funcao (data) -> [{placa, leituras:[{data, odometro}]}].
 */
function frotaRecente(db, { pessoaId, excluir = [], dias = 10 } = {}) {
    return (data) => {
        if (!pessoaId || !DATA_ISO.test(String(data || ""))) return [];
        const inicio = new Date(`${data}T12:00:00Z`);
        inicio.setUTCDate(inicio.getUTCDate() - dias);
        const linhas = db.prepare(`SELECT d.id, json_extract(d.campos, '$.abastecimento.placa.valor') AS placa,
                json_extract(d.campos, '$.abastecimento.odometro.valor') AS odometro, json_extract(d.campos, '$.data_competencia.valor') AS data
            FROM despesas d LEFT JOIN mensagens msg ON msg.id = d.mensagem_ref
            WHERE ${OPERADOR_SQL} = ? AND d.estado NOT IN ('DESCARTADO', 'BLOQUEADO_DUPLICADO')
              AND json_extract(d.campos, '$.tipo.valor') = 'ABASTECIMENTO'
              AND json_extract(d.campos, '$.abastecimento.placa.valor') IS NOT NULL
              AND json_extract(d.campos, '$.data_competencia.valor') BETWEEN ? AND ?`)
            .all(pessoaId, inicio.toISOString().slice(0, 10), data)
            .filter((l) => !excluir.includes(l.id));
        const porPlaca = new Map();
        for (const l of linhas) {
            const item = porPlaca.get(l.placa) || { placa: l.placa, leituras: [] };
            if (Number(l.odometro) > 0) item.leituras.push({ data: l.data, odometro: Number(l.odometro) });
            porPlaca.set(l.placa, item);
        }
        return [...porPlaca.values()];
    };
}

/**
 * Qual veiculo da frota recente tem o km compativel: o km so aumenta, entao
 * serve o veiculo cuja ultima leitura ate esse km esta logo abaixo (ate 3.000
 * km) e que nao tem leitura MAIOR em data anterior. So decide se houver um so
 * candidato, ou um muito mais perto que os outros.
 */
function veiculoPeloKm(frota, odometro, data) {
    const km = Number(odometro);
    if (!(km > 0)) return null;
    const candidatos = [];
    for (const v of frota) {
        const abaixo = v.leituras.filter((l) => l.odometro <= km).sort((a, b) => b.odometro - a.odometro)[0];
        if (!abaixo || km - abaixo.odometro > 3000) continue;
        const contradiz = v.leituras.some((l) => l.odometro > km && l.data < data);
        if (!contradiz) candidatos.push({ placa: v.placa, distancia: km - abaixo.odometro, referencia: abaixo });
    }
    candidatos.sort((a, b) => a.distancia - b.distancia);
    if (!candidatos.length) return null;
    if (candidatos.length === 1 || candidatos[1].distancia > Math.max(500, candidatos[0].distancia * 3)) return candidatos[0];
    return { ambiguo: candidatos };
}

module.exports = { listar, regraPara, salvar, desativar, frotaRecente, veiculoPeloKm, CAMPOS };
