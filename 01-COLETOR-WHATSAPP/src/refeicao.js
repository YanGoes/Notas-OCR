"use strict";

const { normalizar } = require("./legenda");

// Ordem importa: "cafe da manha" precisa ser testado antes de "cafe".
const APELIDOS = [
    ["CAFÉ DA MANHÃ", ["cafe da manha", "cafe manha", "desjejum", "cafe"]],
    ["ALMOÇO", ["almoco"]],
    ["JANTAR", ["jantar", "janta"]],
    ["LANCHE", ["lanche"]],
];

function minutos(hora) {
    const achado = String(hora || "").match(/^\s*(\d{1,2}):(\d{2})/);
    if (!achado) return null;
    const h = Number(achado[1]);
    const m = Number(achado[2]);
    return h <= 23 && m <= 59 ? h * 60 + m : null;
}

function horaNormalizada(hora) {
    const total = minutos(hora);
    return total === null ? null : `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function periodoDaHora(hora, faixas = []) {
    const agora = minutos(hora);
    if (agora === null) return null;
    for (const faixa of faixas) {
        const de = minutos(faixa.de);
        const ate = minutos(faixa.ate);
        if (de === null || ate === null) continue;
        // Faixas que viram a meia-noite (18:00 as 03:59) tem "de" maior que "ate".
        const dentro = de <= ate ? agora >= de && agora <= ate : agora >= de || agora <= ate;
        if (dentro) return { periodo: faixa.periodo, categoria: faixa.categoria || null, faixa: `${faixa.de}-${faixa.ate}` };
    }
    return null;
}

function periodoDoTexto(texto) {
    const alvo = normalizar(texto);
    if (!alvo) return null;
    for (const [periodo, apelidos] of APELIDOS) {
        if (apelidos.some((apelido) => alvo.includes(apelido))) return periodo;
    }
    return null;
}

function categoriaDoPeriodo(periodo, faixas = []) {
    return faixas.find((faixa) => faixa.periodo === periodo)?.categoria || null;
}

function descricaoRefeicao(periodo, pessoas) {
    if (!periodo) return null;
    const total = Number(pessoas);
    if (!Number.isInteger(total) || total < 1) return periodo;
    return `${periodo} - ${total} ${total === 1 ? "PESSOA" : "PESSOAS"}`;
}

// A hora do comprovante manda; a legenda so entra quando o OCR nao achou hora nenhuma.
function resolverRefeicao({ hora, legenda, pessoas, faixas = [] } = {}) {
    const porHora = periodoDaHora(hora, faixas);
    const porLegenda = periodoDoTexto(legenda);
    const periodo = porHora?.periodo || porLegenda || null;
    const pessoasValidas = Number.isInteger(Number(pessoas)) && Number(pessoas) > 0 ? Number(pessoas) : null;
    return {
        periodo,
        categoria: porHora?.categoria || categoriaDoPeriodo(porLegenda, faixas),
        origem: porHora ? "hora_do_comprovante" : porLegenda ? "legenda" : null,
        hora: horaNormalizada(hora),
        faixa: porHora?.faixa || null,
        periodo_legenda: porLegenda,
        divergente: Boolean(porHora && porLegenda && porHora.periodo !== porLegenda),
        pessoas: pessoasValidas,
        descricao: descricaoRefeicao(periodo, pessoasValidas),
    };
}

module.exports = { resolverRefeicao, periodoDaHora, periodoDoTexto, descricaoRefeicao, horaNormalizada, categoriaDoPeriodo };
