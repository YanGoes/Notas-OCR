"use strict";

// Litros do abastecimento conferidos pela conta litros × preco = valor da nota,
// procurando o numero colado ao "L" / "LT" quando a leitura erra (nota #251).

const test = require("node:test");
const assert = require("node:assert/strict");

const { conferirLitros, litrosJuntoDoL } = require("../src/central/regras-vmac");

const NOTA_251 = "GASOLINA C COMUM\n32 350\nL X R$ 6.64\nR$ 214.80\nVALOR TOTAL R$\nR$ 214.80";

test("acha o numero junto do L, mesmo com a virgula lida como espaco ou a unidade na linha de baixo", () => {
    assert.ok(litrosJuntoDoL(NOTA_251).includes(32.35));
    assert.ok(litrosJuntoDoL("QTD 45,340 LT").includes(45.34));
    assert.ok(litrosJuntoDoL("20.524L x 5,89").includes(20.524));
    assert.ok(litrosJuntoDoL("LITROS: 61,618").includes(61.618));
    assert.ok(litrosJuntoDoL("12 LTS").includes(12));
    assert.deepEqual(litrosJuntoDoL("LAVAGEM COMPLETA 1 UN"), []);
});

test("nota #251: 350 L lidos viram 32,350 L porque 32,350 × 6,64 = 214,80", () => {
    const r = conferirLitros({ litros: 350, valor: 214.8, precoItem: 6.64, texto: NOTA_251 });
    assert.deepEqual({ litros: r.litros, mudou: r.mudou, como: r.como }, { litros: 32.35, mudou: true, como: "numero_junto_do_L" });
});

test("litros que ja fecham a conta nao mudam", () => {
    const r = conferirLitros({ litros: 45.34, valor: 285.64, precoItem: 6.3, texto: "45,340 L X 6,30" });
    assert.equal(r.mudou, false);
    assert.equal(r.litros, 45.34);
});

test("sem numero que feche, divide valor pelo preco e pede confirmacao", () => {
    const r = conferirLitros({ litros: 350, valor: 214.8, precoItem: 6.64, texto: "GASOLINA\nR$ 214,80" });
    assert.equal(r.litros, 32.349);
    assert.equal(r.confirmar, true);
});

test("sem preco nenhum nao inventa", () => {
    assert.deepEqual(conferirLitros({ litros: 350, valor: 214.8, texto: "GASOLINA" }), { litros: 350, mudou: false });
});

test("aceita a conta pelo total da nota quando o valor da linha veio mal lido (#90)", () => {
    const r = conferirLitros({ litros: 56.7, valores: [356.33, 396.33], precoItem: 6.99, texto: "56,7000 LT x 6.99" });
    assert.equal(r.mudou, false);
});

test("divisao nunca da mais de 300 litros (#17, valor da linha ilegivel)", () => {
    const r = conferirLitros({ litros: 135, valores: [558160], precoItem: 9.13, texto: "GASOLINA" });
    assert.equal(r.litros, 135);
    assert.equal(r.mudou, false);
});
