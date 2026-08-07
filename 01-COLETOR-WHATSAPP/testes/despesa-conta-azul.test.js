"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { montarDespesa, dataIso } = require("../src/despesa-conta-azul");

const base = { descricao: "ALMOÇO - 2 PESSOAS", valor: 84, data: "2026-08-07", idCategoria: "5bd50b47-4409-4157-b631-98a24f26148a" };

test("monta o corpo no formato aceito pela API", () => {
    const corpo = montarDespesa({ ...base, idCentroCusto: "af692fa0-8f85-11f1-a1fb-07d665f7a520" });
    assert.equal(corpo.descricao, "ALMOÇO - 2 PESSOAS");
    assert.equal(corpo.valor, 84);
    assert.equal(corpo.data_competencia, "2026-08-07");
    assert.equal(corpo.condicao_pagamento.tipo, "A_VISTA");
    assert.equal(corpo.condicao_pagamento.parcelas.length, 1);
    assert.equal(corpo.rateio[0].id_categoria, base.idCategoria);
});

test("usa detalhe_valor na escrita, nunca valor_composicao", () => {
    const parcela = montarDespesa(base).condicao_pagamento.parcelas[0];
    assert.deepEqual(parcela.detalhe_valor, { valor_bruto: 84, valor_liquido: 84, desconto: 0, taxa: 0, multa: 0, juros: 0 });
    assert.equal(parcela.valor_composicao, undefined);
    assert.equal(parcela.composicao_valor, undefined);
});

// A descricao do evento nao volta em nenhum endpoint; a listagem e o export mostram a da parcela.
test("repete a descricao na parcela, senao o lancamento sai como 'Parcela 1/1'", () => {
    const corpo = montarDespesa(base);
    assert.equal(corpo.condicao_pagamento.parcelas[0].descricao, "ALMOÇO - 2 PESSOAS");
    assert.equal(corpo.descricao, "ALMOÇO - 2 PESSOAS");
});

test("centro de custo vai como lista dentro do rateio, com id_centro_custo", () => {
    const corpo = montarDespesa({ ...base, idCentroCusto: "af692fa0-8f85-11f1-a1fb-07d665f7a520" });
    assert.deepEqual(corpo.rateio[0].rateio_centro_custo, [{ id_centro_custo: "af692fa0-8f85-11f1-a1fb-07d665f7a520", valor: 84 }]);
    assert.equal(corpo.rateio[0].id_centro_de_custo, undefined);
});

test("sem centro de custo o rateio sai sem a chave, nao com null", () => {
    assert.equal("rateio_centro_custo" in montarDespesa(base).rateio[0], false);
});

test("recusa placeholder de id que ainda nao foi preenchido", () => {
    assert.throws(() => montarDespesa({ ...base, idCategoria: "PREENCHER_UUID_CONTA_AZUL" }), /placeholder/);
    assert.throws(() => montarDespesa({ ...base, idCentroCusto: "PREENCHER_UUID_CONTA_AZUL" }), /placeholder/);
});

test("recusa entrada invalida antes de gastar chamada de API", () => {
    assert.throws(() => montarDespesa({ ...base, descricao: "  " }), /Descricao obrigatoria/);
    assert.throws(() => montarDespesa({ ...base, valor: 0 }), /Valor invalido/);
    assert.throws(() => montarDespesa({ ...base, valor: -5 }), /Valor invalido/);
    assert.throws(() => montarDespesa({ ...base, data: "07-08-2026" }), /Data invalida/);
    assert.throws(() => montarDespesa({ ...base, idCategoria: null }), /categoria ausente/);
});

test("aceita data em formato brasileiro e normaliza", () => {
    assert.equal(dataIso("07/08/2026"), "2026-08-07");
    assert.equal(dataIso("2026-08-07"), "2026-08-07");
    assert.equal(dataIso("qualquer coisa"), null);
    assert.equal(montarDespesa({ ...base, data: "07/08/2026" }).data_competencia, "2026-08-07");
});

test("arredonda o valor para centavos em todos os lugares", () => {
    const corpo = montarDespesa({ ...base, valor: 84.006, idCentroCusto: "af692fa0-8f85-11f1-a1fb-07d665f7a520" });
    assert.equal(corpo.valor, 84.01);
    assert.equal(corpo.rateio[0].valor, 84.01);
    assert.equal(corpo.rateio[0].rateio_centro_custo[0].valor, 84.01);
    assert.equal(corpo.condicao_pagamento.parcelas[0].detalhe_valor.valor_bruto, 84.01);
});
