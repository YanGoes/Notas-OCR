"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    normalizar, idConfigurado,
    itensDaResposta,
    correspondenciaExata,
    correspondenciaVeiculo,
} = require("../ferramentas/configurar_ids_conta_azul");

test("considera configurado somente UUID real", () => {
    assert.equal(idConfigurado("PREENCHER_UUID_CONTA_AZUL"), false);
    assert.equal(idConfigurado("qualquer-texto"), false);
    assert.equal(idConfigurado("3fa85f64-5717-4562-b3fc-2c963f66afa6"), true);
});

test("aceita os formatos itens e items documentados pelo Conta Azul", () => {
    assert.deepEqual(itensDaResposta({ itens: [{ id: "categoria" }] }), [{ id: "categoria" }]);
    assert.deepEqual(itensDaResposta({ items: [{ id: "centro" }] }), [{ id: "centro" }]);
});

test("correspondencia exata ignora acentos e caixa", () => {
    const catalogo = [{ id: "1", nome: "Farmácia" }, { id: "2", nome: "Hospedagem" }];
    assert.equal(correspondenciaExata({ nome: "FARMACIA", apelidos: [] }, catalogo)?.id, "1");
    assert.equal(normalizar("Lanches e Refeições"), "lanches e refeicoes");
});

test("nome_conta_azul permite equivalencia explicita sem adivinhar", () => {
    const catalogo = [
        { id: "alimentacao", nome: "Lanches e Refeições" },
        { id: "material", nome: "Materiais Aplicados na Prestação de Serviços" },
    ];
    assert.equal(correspondenciaExata({ nome: "ALIMENTACAO EM CAMPO", nome_conta_azul: "Lanches e Refeições" }, catalogo)?.id, "alimentacao");
    assert.equal(correspondenciaExata({ nome: "MATERIAL DE CAMPO", nome_conta_azul: "Materiais Aplicados na Prestação de Serviços" }, catalogo)?.id, "material");
    assert.equal(correspondenciaExata({ nome: "HOSPEDAGEM" }, catalogo), null);
});

test("categoria do veiculo exige nome exato ou placa sem ambiguidade", () => {
    const veiculo = { nome: "FIAT SCUDO - SGR4B54", placa: "SGR-4B54" };
    const exata = [{ id: "combustivel", nome: "FIAT SCUDO - SGR4B54" }, { id: "manutencao", nome: "MANUTENCAO FIAT SCUDO SGR4B54" }];
    assert.equal(correspondenciaVeiculo(veiculo, exata)?.id, "combustivel");
    const ambigua = [{ id: "a", nome: "SCUDO SGR4B54" }, { id: "b", nome: "MANUTENCAO SGR4B54" }];
    assert.equal(correspondenciaVeiculo({ nome: "SCUDO", placa: "SGR4B54" }, ambigua), null);
});
