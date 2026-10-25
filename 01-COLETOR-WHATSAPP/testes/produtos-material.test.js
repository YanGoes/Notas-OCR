"use strict";

// Base de produtos (configuracao/produtos.json): notas de material que viravam
// "restaurante" pelo horario ou pelo palpite do Azure (#278, #281, #286, #191).

const test = require("node:test");
const assert = require("node:assert/strict");

const cadastros = require("../src/central/cadastros");
const { montarPrevia } = require("../src/central/regras-vmac");
const avisos = require("../src/central/avisos-gerencia");

const cad = cadastros.carregar();
const nota = (fornecedor, itens, hora = "12:10") => ({ data: "2026-10-20", hora, valor: 30, fornecedor, confianca: 0.99, tipo_recibo_azure: "Meal",
    itens: itens.map((descricao) => ({ descricao, quantidade: 1, valor_total: 10 })) });
const tipo = (ocr, legenda = {}) => montarPrevia({ ocr, legenda, contexto: {}, identificacao: {}, cad }).campos;

test("itens de material viram Material de Campo, mesmo no horario de almoco e com o Azure dizendo refeicao", () => {
    for (const itens of [["Refil Cola Quente Grosso"], ["Fio Cabo PP 2x2,5M/M", "FITA DUPLA FACE 24X2MTS"], ["CHAVE ALAVANCA ON/OFF/ON 10A"]]) {
        const c = tipo(nota("ERCI APARECIDA XAVIER", itens));
        assert.equal(c.tipo.valor, "OUTROS", itens.join());
        assert.equal(c.categoria.nome, "MATERIAL DE CAMPO", itens.join());
    }
});

test("legenda 'Pano de chão' sem tipo tambem e material", () => {
    assert.equal(tipo({ data: "2026-10-20", valor: 12, fornecedor: "REDEFLEX", confianca: 0.99, tipo_recibo_azure: "Meal" }, { texto: "Pano de chão", tipos: [] }).tipo.valor, "OUTROS");
});

test("comida continua comida: Coca-Cola nao e cola, e um pano no meio do mercado nao vira material", () => {
    assert.notEqual(tipo(nota("TELES DE SOUZA", ["MARMITEX MEDIA", "MARMITEX MEDIA", "COCA COLA 2 LITROS"])).tipo.valor, "OUTROS");
    assert.notEqual(tipo(nota("BOM DIA SUPERMERCADOS", ["PAO FRANCES KG", "LEITE INTEGRAL 1LT", "MAIONESE 500GR", "PANO MULTIUSO"])).tipo.valor, "OUTROS");
});

test("gerencia: o horario do dia e contado no fuso de Brasilia", () => {
    assert.deepEqual(avisos.hojeEmBrasilia(new Date("2026-10-25T21:30:00Z")), { dia: "2026-10-25", minutos: 18 * 60 + 30 });
    assert.equal(avisos.hojeEmBrasilia(new Date("2026-10-26T01:00:00Z")).dia, "2026-10-25");
});
