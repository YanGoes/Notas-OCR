"use strict";

const { normalizar } = require("./legenda");

// Pagamento de mao de obra tambem se chama "diaria" e cai na mesma palavra-chave da hospedagem.
// No historico (07/08/2026) este padrao separou 42 dos 46 freelancers com 1 falso positivo em 934.
const PADRAO_FREELANCER = /\b(freelancer|free\s*lance|freela|batedor|mao de obra|servicos? de digitacao)\b/;

function eFreelancer(texto) {
    return PADRAO_FREELANCER.test(normalizar(texto));
}

function inteiroPositivo(valor) {
    const n = Number(valor);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function dataUtc(dia, mes, ano) {
    let a = Number(ano);
    if (a < 100) a += a < 70 ? 2000 : 1900;
    const d = new Date(Date.UTC(a, Number(mes) - 1, Number(dia)));
    return Number.isNaN(d.getTime()) ? null : d;
}

function diferencaEmDias(entrada, saida) {
    if (!entrada || !saida) return null;
    const dias = Math.round((saida - entrada) / 86400000);
    // Acima de 60 e quase certo erro de leitura; 0 ou negativo tambem nao serve.
    return dias > 0 && dias <= 60 ? dias : null;
}

// Ordem: rotulo explicito > check-in/check-out > periodo "de X a Y" > item com unidade diaria.
function diariasDoTexto(texto, anoPadrao) {
    const conteudo = String(texto || "");
    const alvo = normalizar(conteudo);

    const explicito = alvo.match(/(?:(\d{1,3})\s*(?:diarias?|noites?|pernoites?)\b|(?:diarias?|noites?)\s*:?\s*(\d{1,3})\b)/);
    if (explicito) {
        const n = inteiroPositivo(explicito[1] || explicito[2]);
        if (n && n <= 60) return { diarias: n, origem: "quantidade_no_texto" };
    }

    const dataSolta = "(\\d{1,2})[\\/.-](\\d{1,2})(?:[\\/.-](\\d{2,4}))?";
    const entradaM = alvo.match(new RegExp(`(?:check\\s*-?\\s*in|entrada|chegada)\\D{0,25}${dataSolta}`));
    const saidaM = alvo.match(new RegExp(`(?:check\\s*-?\\s*out|saida|partida)\\D{0,25}${dataSolta}`));
    if (entradaM && saidaM) {
        const dias = diferencaEmDias(
            dataUtc(entradaM[1], entradaM[2], entradaM[3] || anoPadrao),
            dataUtc(saidaM[1], saidaM[2], saidaM[3] || anoPadrao));
        if (dias) return { diarias: dias, origem: "check_in_check_out" };
    }

    const periodo = alvo.match(new RegExp(`${dataSolta}\\s*(?:a|ate|as)\\s*${dataSolta}`));
    if (periodo) {
        const dias = diferencaEmDias(
            dataUtc(periodo[1], periodo[2], periodo[3] || anoPadrao),
            dataUtc(periodo[4], periodo[5], periodo[6] || periodo[3] || anoPadrao));
        if (dias) return { diarias: dias, origem: "periodo_no_texto" };
    }

    return null;
}

function diariasDosItens(itens = []) {
    const item = itens.find((x) => /^(diaria|diarias|pernoite|noite|noites|hospedagem)$/.test(normalizar(x.unidade))
        || (/diaria|pernoite|hospedagem/.test(normalizar(x.descricao)) && Number(x.quantidade) > 0));
    const n = item ? inteiroPositivo(item.quantidade) : null;
    return n ? { diarias: n, origem: "item_do_documento" } : null;
}

function plural(n, singular, plural_) {
    return `${n} ${n === 1 ? singular : plural_}`;
}

function descricaoHospedagem(pessoas, diarias) {
    const p = inteiroPositivo(pessoas);
    const d = inteiroPositivo(diarias);
    const partes = [];
    if (p) partes.push(plural(p, "PESSOA", "PESSOAS"));
    if (d) partes.push(plural(d, "DIÁRIA", "DIÁRIAS"));
    return partes.length ? `HOSPEDAGEM - ${partes.join("/")}` : "HOSPEDAGEM";
}

// Confere se o valor fecha com pessoas x diarias x preco de referencia (~R$110 no historico).
function conferirValor({ valor, pessoas, diarias, referencia, tolerancia = 0.6 }) {
    const p = inteiroPositivo(pessoas);
    const d = inteiroPositivo(diarias);
    const ref = Number(referencia);
    if (!p || !d || !(Number(valor) > 0) || !(ref > 0)) return null;
    const esperado = p * d * ref;
    const razao = Number(valor) / esperado;
    return { esperado: Number(esperado.toFixed(2)), razao: Number(razao.toFixed(2)), coerente: razao >= 1 - tolerancia && razao <= 1 + tolerancia };
}

function resolverHospedagem({ pessoas, diarias, ocr = {}, legenda, config = {} } = {}) {
    const anoPadrao = String(ocr.data || "").slice(0, 4) || String(new Date().getFullYear());
    const daLegenda = inteiroPositivo(diarias);
    const achado = daLegenda
        ? { diarias: daLegenda, origem: "legenda" }
        : diariasDoTexto(legenda, anoPadrao)
            || diariasDosItens(ocr.itens)
            || diariasDoTexto(ocr.texto_bruto, anoPadrao);
    const p = inteiroPositivo(pessoas);
    const d = achado?.diarias || null;
    return {
        pessoas: p,
        diarias: d,
        diarias_origem: achado?.origem || null,
        freelancer: eFreelancer([legenda, ocr.produto_principal, ocr.nome_fantasia].filter(Boolean).join(" ")),
        valor: conferirValor({ valor: ocr.valor, pessoas: p, diarias: d, referencia: config.valor_referencia_diaria }),
        descricao: descricaoHospedagem(p, d),
    };
}

module.exports = { resolverHospedagem, descricaoHospedagem, diariasDoTexto, diariasDosItens, eFreelancer, conferirValor };
