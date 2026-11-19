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

test("litros impossiveis com o preco da linha: divide valor pelo preco sozinho", () => {
    const r = conferirLitros({ litros: 350, valor: 214.8, precoItem: 6.64, texto: "GASOLINA\nR$ 214,80" });
    assert.equal(r.litros, 32.349);
    assert.equal(r.como, "valor_dividido_pelo_preco_da_linha");
    assert.equal(r.confirmar, undefined);
});

test("#512: 1,451 L numa nota de R$ 227,03 a R$ 6,59/L sao 34,451 L (media 8.45 km/l no rodape nao atrapalha)", () => {
    const texto = "GASOLINA C COMUM\n1,451\nL\n6,59\n227,03\nVALOR PAGO R$\n227,03\n-Placa: FHH3G21 -km : 54734 -media : 8.45 k/1";
    const r = conferirLitros({ litros: 1.451, valores: [227.03, 227.03], precoItem: 6.59, texto });
    assert.deepEqual({ litros: r.litros, mudou: r.mudou, confirmar: r.confirmar }, { litros: 34.451, mudou: true, confirmar: undefined });
});

test("litros plausiveis com preco que nao fecha: nao troca sozinho, pede confirmacao", () => {
    // 34,451 L em R$ 227,03 da R$ 6,59/L (plausivel); o preco lido (6,95) e que esta errado.
    const r = conferirLitros({ litros: 34.451, valor: 227.03, precoItem: 6.95, texto: "GASOLINA\n6,95" });
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
