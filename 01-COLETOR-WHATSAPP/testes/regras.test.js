"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { interpretarLegenda } = require("../src/legenda");
const { classificar } = require("../src/classificador");
const { validar, idValido } = require("../src/validador");
const { dadosAbastecimento, descricaoContaAzul } = require("../src/detalhes-despesa");
const regras = require("../configuracao/regras.json");

test("interpreta legenda padronizada", () => {
    const resultado = interpretarLegenda([
        "Tipo: Abastecimento", "Centro de custo: CONSOL MG-050",
        "Veiculo: FIAT SCUDO - SGR4B54", "Conta/cartao: Inter",
        "Pessoas: 2", "Valor: R$ 251,14", "Observacao: Vistoria",
    ].join("\n"));
    assert.equal(resultado.tipo_despesa, "Abastecimento");
    assert.equal(resultado.veiculo_informado, "FIAT SCUDO - SGR4B54");
    assert.equal(resultado.valor_informado, 251.14);
    assert.equal(resultado.pessoas, 2);
});

test("interpreta comentario simples separado como tipo de despesa", () => {
    const operador = interpretarLegenda("Restaurante");
    const classificacao = classificar(operador);
    assert.equal(operador.tipo_despesa, "Restaurante");
    assert.equal(classificacao.tipo_reconhecido.nome, "alimentacao");
});

test("bloqueia categoria proibida", () => {
    const operador = interpretarLegenda("Tipo: Salario\nCentro de custo: Exemplo");
    const classificacao = classificar(operador);
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr: { valor: 100, data: "2026-08-04", confianca: 0.99 } });
    assert.equal(resultado.bloqueado, true);
    assert.equal(resultado.escopo_permitido, false);
});

test("manda combustivel sem veiculo para revisao", () => {
    const operador = interpretarLegenda("Tipo: Abastecimento\nCentro de custo: Exemplo");
    const classificacao = classificar(operador);
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr: { valor: 100, data: "2026-08-04", confianca: 0.99 } });
    assert.equal(resultado.revisao_necessaria, true);
    assert.match(resultado.motivos.join(" "), /Placa do veiculo/);
    assert.match(resultado.motivos.join(" "), /Litragem/);
});

test("reconhece combustivel e placa diretamente do OCR Azure", () => {
    const operador = interpretarLegenda("");
    const classificacao = classificar(operador, { produto_principal: "DIESEL S10 ADITIVADO", placa: "REP-7B39", texto_bruto: "POSTO ALVORADA" });
    assert.equal(classificacao.tipo_reconhecido.nome, "combustivel");
    assert.equal(classificacao.tipo_origem, "ocr_azure");
    assert.equal(classificacao.veiculo.placa, "REP-7B39");
});

test("preserva placa e litragem na descricao preparada para o Conta Azul", () => {
    const ocr = { placa: "REP-7B39", quilometragem: 213624, itens: [{ descricao: "DIESEL S10 ADITIVADO", quantidade: 38.401, unidade: "LT", valor_unitario: 6.54 }] };
    const classificacao = { tipo_reconhecido: { nome: "combustivel" }, veiculo: { placa: "REP-7B39" } };
    assert.deepEqual(dadosAbastecimento(ocr, classificacao), { placa: "REP-7B39", litragem: 38.401, unidade: "LT", combustivel: "DIESEL S10 ADITIVADO", valor_unitario: 6.54, quilometragem: 213624 });
    const descricao = descricaoContaAzul({ legenda: "Abastecimento", ocr, classificacao });
    assert.match(descricao, /Placa: REP-7B39/);
    assert.match(descricao, /Litragem: 38,401 LT/);
});

test("detecta divergencia de valor", () => {
    const operador = interpretarLegenda("Tipo: Almoco\nCentro de custo: Exemplo\nValor: 50,00");
    const classificacao = classificar(operador);
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr: { valor: 51, data: "2026-08-04", confianca: 0.99 } });
    assert.equal(resultado.valor_confere, false);
    assert.match(resultado.motivos.join(" "), /diverge/);
});

test("IDs de exemplo nunca sao considerados validos", () => {
    assert.equal(idValido("PREENCHER_UUID_CONTA_AZUL"), false);
    assert.equal(idValido("3fa85f64-5717-4562-b3fc-2c963f66afa6"), true);
});

test("reconhece farmacia e oficina como excecoes de campo", () => {
    assert.equal(classificar(interpretarLegenda("Farmacia")).tipo_reconhecido.nome, "farmacia");
    assert.equal(classificar(interpretarLegenda("Oficina")).tipo_reconhecido.nome, "manutencao");
});

test("tipo outros sempre exige revisao", () => {
    const operador = interpretarLegenda("Outros");
    const classificacao = classificar(operador);
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr: { valor: 10, data: "2026-08-05", confianca: 0.99 } });
    assert.equal(resultado.revisao_necessaria, true);
    assert.match(resultado.motivos.join(" "), /revisao humana obrigatoria/);
});
