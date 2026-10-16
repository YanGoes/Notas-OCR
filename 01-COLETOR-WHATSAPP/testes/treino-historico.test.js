"use strict";

// Treino com o historico: casar a foto com o lancamento do Conta Azul e montar
// a legenda no padrao. Sem Azure e sem banco real.

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("../ferramentas/treino-historico");

const LANCAMENTOS = [
    { data: "2026-09-10", valor: -85.5, fornecedor: "RESTAURANTES", categoria: "Refeição - Jantar", centro: "IMTRAFF - MT FWD", descricao: "JANTAR - 3 PESSOAS", conta: "Inter - Conta Corrente" },
    { data: "2026-09-10", valor: -210, fornecedor: "POSTOS DE COMBUSTÍVEL", categoria: "S10 - PRE3B59", centro: "IMTRAFF - MT FWD", descricao: "35,43L od 145.225 - PRE3B59", conta: "Banco do Brasil - Conta Corrente" },
    { data: "2026-09-11", valor: -40, fornecedor: "RESTAURANTES", descricao: "ALMOÇO", conta: "Nubank - Conta Corrente" },
    { data: "2026-09-11", valor: -40, fornecedor: "RESTAURANTES", descricao: "ALMOÇO", conta: "Nubank - Conta Corrente" },
];

test("acha o lancamento pelo valor e data proxima; dois iguais = ambiguo (nao chuta)", () => {
    const usados = new Set();
    assert.equal(h.acharLancamento(LANCAMENTOS, { valor: 85.5, data: "2026-09-11", usados }).descricao, "JANTAR - 3 PESSOAS");
    assert.equal(h.acharLancamento(LANCAMENTOS, { valor: 85.5, data: "2026-09-20", usados }), null, "mais de 3 dias: nao casa");
    assert.deepEqual(h.acharLancamento(LANCAMENTOS, { valor: 40, data: "2026-09-11", usados }), { ambiguo: true });
    assert.equal(h.acharLancamento(LANCAMENTOS, { valor: 85.5, data: "2026-09-10", usados: new Set([0]) }), null, "lancamento ja usado nao repete");
});

test("legenda e resumo no padrao combinado", () => {
    assert.equal(h.legendaDoLancamento(LANCAMENTOS[0]), "Janta 3");
    assert.equal(h.legendaDoLancamento(LANCAMENTOS[1]), "Abastecimento");
    assert.equal(h.legendaDoLancamento(LANCAMENTOS[2]), "Almoço");
    assert.equal(h.legendaDoLancamento({ fornecedor: "Loja de Ferragens", descricao: "Parafusos" }), "Material - Parafusos");
    assert.equal(h.resumoDoDia("2026-09-10", LANCAMENTOS[1]), "Despesas 10/09/2026\nCentro de custo: IMTRAFF - MT FWD\nCartão: BB - Crédito");
    assert.equal(h.cartaoDaConta("Nubank - Conta Corrente"), null, "conta sem cartao cadastrado: nao inventa");
});

test("legenda de gerador e agua; mesmo veiculo com nomes diferentes nao e divergencia", () => {
    assert.equal(h.legendaDoLancamento({ fornecedor: "POSTOS DE COMBUSTÍVEL", categoria: "GERADOR", descricao: "GERADOR - 10.19L" }), "Gerador");
    assert.equal(h.legendaDoLancamento({ fornecedor: "RESTAURANTES", categoria: "Água", descricao: "AGUA" }), "Água");
    const despesa = { campos: { valor: { valor: 10 }, data_competencia: { valor: "2026-09-01" }, categoria: { nome: "ETIOS - OVN1505" }, centro_custo: { nome: "X" }, fornecedor: { valor: "P" } } };
    assert.deepEqual(h.comparar(despesa, { valor: -10, data: "2026-09-01", categoria: "Combustivel OVN-1505", centro: "X", fornecedor: "P" }), []);
});
