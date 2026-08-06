"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { criarModelo, prever, tokens, hashGrupo } = require("../src/aprendizado");

test("modelo local aprende padrões simples sem serviço externo", () => {
    const exemplos = [];
    for (let i = 0; i < 6; i += 1) {
        exemplos.push({ rotulo: "ALIMENTACAO", texto: `restaurante almoço refeição ${i}` });
        exemplos.push({ rotulo: "HOSPEDAGEM", texto: `hotel pousada diária quarto ${i}` });
    }
    const modelo = criarModelo(exemplos, "rotulo", "texto", 5);
    assert.equal(prever(modelo, "cupom restaurante refeição almoço").rotulo, "ALIMENTACAO");
    assert.equal(prever(modelo, "nota hotel diária hospedagem").rotulo, "HOSPEDAGEM");
});

test("tokenização e separação histórica são determinísticas", () => {
    assert.deepEqual(tokens("Pagamento de Hotel Hotel"), tokens("Pagamento de Hotel Hotel"));
    assert.equal(hashGrupo("Fornecedor|Despesa"), hashGrupo("Fornecedor|Despesa"));
});
