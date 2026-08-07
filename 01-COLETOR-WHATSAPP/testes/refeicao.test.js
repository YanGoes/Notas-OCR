"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolverRefeicao, periodoDaHora, descricaoRefeicao } = require("../src/refeicao");
const { horaDoTexto } = require("../src/azure-ocr");
const { interpretarLegenda } = require("../src/legenda");
const { classificar } = require("../src/classificador");
const { validar } = require("../src/validador");
const { descricaoContaAzul } = require("../src/detalhes-despesa");
const regras = require("../configuracao/regras.json");

const faixas = regras.refeicao.faixas;
const ocrOk = { valor: 80, data: "2026-08-07", confianca: 0.99 };

test("cada faixa de horario cai no periodo certo", () => {
    const casos = [
        ["04:00", "CAFÉ DA MANHÃ"], ["07:15", "CAFÉ DA MANHÃ"], ["10:29", "CAFÉ DA MANHÃ"],
        ["10:30", "ALMOÇO"], ["12:47", "ALMOÇO"], ["15:29", "ALMOÇO"],
        ["15:30", "LANCHE"], ["17:59", "LANCHE"],
        ["18:00", "JANTAR"], ["21:03", "JANTAR"],
    ];
    for (const [hora, esperado] of casos) assert.equal(periodoDaHora(hora, faixas)?.periodo, esperado, `falhou em ${hora}`);
});

test("faixa do jantar atravessa a meia-noite", () => {
    assert.equal(periodoDaHora("23:59", faixas)?.periodo, "JANTAR");
    assert.equal(periodoDaHora("00:30", faixas)?.periodo, "JANTAR");
    assert.equal(periodoDaHora("03:59", faixas)?.periodo, "JANTAR");
    assert.equal(periodoDaHora("04:00", faixas)?.periodo, "CAFÉ DA MANHÃ");
});

test("hora invalida nao vira periodo", () => {
    for (const hora of [null, "", "25:00", "12:70", "abc", "1230"]) assert.equal(periodoDaHora(hora, faixas), null, `aceitou ${hora}`);
});

test("descricao usa o formato aprovado, com singular em 1 pessoa", () => {
    assert.equal(descricaoRefeicao("ALMOÇO", 2), "ALMOÇO - 2 PESSOAS");
    assert.equal(descricaoRefeicao("JANTAR", 1), "JANTAR - 1 PESSOA");
    assert.equal(descricaoRefeicao("CAFÉ DA MANHÃ", 3), "CAFÉ DA MANHÃ - 3 PESSOAS");
});

test("sem numero de pessoas a descricao sai so com o periodo", () => {
    for (const pessoas of [null, 0, "", "duas"]) assert.equal(descricaoRefeicao("ALMOÇO", pessoas), "ALMOÇO", `falhou em ${pessoas}`);
});

test("horario do comprovante prevalece sobre a legenda", () => {
    const resultado = resolverRefeicao({ hora: "12:30", legenda: "Jantar", pessoas: 2, faixas });
    assert.equal(resultado.periodo, "ALMOÇO");
    assert.equal(resultado.origem, "hora_do_comprovante");
    assert.equal(resultado.divergente, true);
    assert.equal(resultado.descricao, "ALMOÇO - 2 PESSOAS");
});

test("sem hora legivel a legenda ainda preenche a sugestao", () => {
    const resultado = resolverRefeicao({ hora: null, legenda: "Tipo: Jantar", pessoas: 3, faixas });
    assert.equal(resultado.periodo, "JANTAR");
    assert.equal(resultado.origem, "legenda");
    assert.equal(resultado.categoria, "Refeição - jantar");
    assert.equal(resultado.divergente, false);
});

test("le a hora do texto do cupom quando o campo estruturado falta", () => {
    assert.equal(horaDoTexto("CUPOM FISCAL\nHora: 19:42:07\nTOTAL 84,00"), "19:42");
    assert.equal(horaDoTexto("07/08/2026 12:05:33 CCF:000123"), "12:05");
    assert.equal(horaDoTexto("EMISSAO 08/08/2026 09h07"), "09:07");
    assert.equal(horaDoTexto("VENDA 7:05 CAIXA 02"), "07:05");
});

test("nao inventa hora a partir de numeros do cupom", () => {
    for (const texto of ["CNPJ 12.345.678/0001-90", "TOTAL R$ 123,45", "COO 123456", "SERIE 12:345", ""]) {
        assert.equal(horaDoTexto(texto), null, `inventou hora em "${texto}"`);
    }
});

test("almoco pelo horario vira categoria e descricao do Conta Azul", () => {
    const operador = interpretarLegenda("Tipo: Refeicao\nCentro de custo: CONSOL MG-050\nPessoas: 2");
    const ocr = { ...ocrOk, hora: "12:47", texto_bruto: "RESTAURANTE SABOR CASEIRO" };
    const classificacao = classificar(operador, ocr);
    assert.equal(classificacao.tipo_reconhecido.nome, "alimentacao");
    assert.equal(classificacao.refeicao.periodo, "ALMOÇO");
    assert.equal(classificacao.categoria_nome, "Refeição - Almoço");
    assert.equal(descricaoContaAzul({ legenda: "Refeicao", ocr, classificacao }), "ALMOÇO - 2 PESSOAS");
});

test("jantar pelo horario usa a categoria com j minusculo do Conta Azul", () => {
    const operador = interpretarLegenda("Tipo: Refeicao\nPessoas: 3");
    const classificacao = classificar(operador, { ...ocrOk, hora: "20:15" });
    assert.equal(classificacao.categoria_nome, "Refeição - jantar");
    assert.equal(classificacao.refeicao.descricao, "JANTAR - 3 PESSOAS");
});

test("cafe da manha pelo horario", () => {
    const classificacao = classificar(interpretarLegenda("Tipo: Refeicao\nPessoas: 2"), { ...ocrOk, hora: "07:20" });
    assert.equal(classificacao.categoria_nome, "Café da Manhã");
    assert.equal(classificacao.refeicao.descricao, "CAFÉ DA MANHÃ - 2 PESSOAS");
});

test("refeicao sem hora vai para revisao", () => {
    const operador = interpretarLegenda("Tipo: Almoco\nCentro de custo: CONSOL MG-050\nPessoas: 2");
    const classificacao = classificar(operador, ocrOk);
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr: ocrOk });
    assert.equal(resultado.revisao_necessaria, true);
    assert.match(resultado.motivos.join(" "), /Horario nao identificado/);
});

test("refeicao sem numero de pessoas nao gera motivo de revisao", () => {
    const operador = interpretarLegenda("Tipo: Almoco\nCentro de custo: CONSOL MG-050");
    const classificacao = classificar(operador, { ...ocrOk, hora: "12:10" });
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr: { ...ocrOk, hora: "12:10" } });
    assert.equal(classificacao.refeicao.descricao, "ALMOÇO");
    assert.equal(resultado.motivos.some((m) => /pessoa/i.test(m)), false);
    assert.equal(resultado.motivos.some((m) => /Horario nao identificado/.test(m)), false);
});

test("divergencia entre horario e legenda vai para revisao", () => {
    const operador = interpretarLegenda("Tipo: Jantar\nCentro de custo: CONSOL MG-050\nPessoas: 2");
    const ocr = { ...ocrOk, hora: "12:30" };
    const classificacao = classificar(operador, ocr);
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr });
    assert.match(resultado.motivos.join(" "), /diverge do informado na legenda/);
});

test("combustivel nao ganha bloco de refeicao", () => {
    const classificacao = classificar(interpretarLegenda("Tipo: Abastecimento"), { ...ocrOk, hora: "12:30" });
    assert.equal(classificacao.refeicao, null);
});
