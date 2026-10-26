"use strict";

// Despesa administrativa, material de campo (loja de ferragens) e cartao de
// credito sem banco. Cadastros reais da configuracao; pessoas ficticias.

const test = require("node:test");
const assert = require("node:assert/strict");

const cadastros = require("../src/central/cadastros");
const regrasVmac = require("../src/central/regras-vmac");
const interpretador = require("../src/central/interpretador");
const azure = require("../src/azure-ocr");

const HOJE = new Date("2026-10-13T12:00:00Z");
const GESTOR = { id: "gestor", nome: "Gestor", papel: "GESTOR", centro_custo_sugerido: "VMAC - LP - DESPESAS ADMINISTRATIVAS" };

function cad() {
    return { ...cadastros.carregar(), pessoas: [GESTOR, { id: "op", nome: "Operador", papel: "OPERADOR" }] };
}

function previa(ocr, legenda = {}, pessoa = GESTOR) {
    return regrasVmac.montarPrevia({ ocr: { data: "2026-10-10", valor: 50, confianca: 0.99, ...ocr }, legenda,
        identificacao: { pessoa, origem: "telefone" }, cad: cad(), hoje: HOJE, modelo: null });
}

test("loja de ferragens vira material de campo, nao restaurante", () => {
    const resultado = previa({ fornecedor: "CASA DAS FERRAGENS LTDA", itens: [{ descricao: "PARAFUSO SEXTAVADO" }], tipo_despesa_sugerido: null });
    assert.equal(resultado.campos.tipo.valor, "OUTROS");
    assert.equal(resultado.campos.fornecedor.valor, "Materiais de Campo");
    assert.equal(resultado.campos.categoria.nome_interno, "MATERIAL DE CAMPO");
});

test("Coca-Cola nao e material de campo", () => {
    const resultado = previa({ fornecedor: "LANCHONETE DO ZE", itens: [{ descricao: "COCA COLA LATA" }, { descricao: "X-BURGUER" }] });
    assert.notEqual(resultado.campos.tipo.valor, "OUTROS");
});

// Regra mudada pelo Yan (21-24/10/2026): almoco/jantar/cafe ficam na categoria do proprio
// tipo mesmo no administrativo; lanche e mercado continuam em Lanches e Refeicoes.
test("centro administrativo: almoco fica em Refeição - Almoço; lanche vai para Lanches e Refeições", () => {
    const almoco = previa({ fornecedor: "RESTAURANTE SABOR", itens: [{ descricao: "PRATO FEITO" }] },
        { tipos: ["ALMOCO"], projeto_texto: "VMAC - LP - DESPESAS ADMINISTRATIVAS" });
    assert.equal(almoco.campos.centro_custo.projeto, "VMAC - LP - DESPESAS ADMINISTRATIVAS");
    assert.match(almoco.campos.categoria.nome, /Refeição - Almoço/i);
    const lanche = previa({ fornecedor: "RESTAURANTE SABOR", itens: [{ descricao: "SALGADO" }] },
        { tipos: ["LANCHE"], projeto_texto: "VMAC - LP - DESPESAS ADMINISTRATIVAS" });
    assert.match(lanche.campos.categoria.nome, /Lanches e Refei/i);
});

test("sem projeto informado, o costume do gestor vira SUGESTAO de centro e de categoria", () => {
    const resultado = previa({ fornecedor: "RESTAURANTE SABOR", itens: [{ descricao: "PRATO FEITO" }] }, { tipos: ["ALMOCO"] });
    assert.equal(resultado.campos.centro_custo.nome ?? null, null, "nunca decide sozinho");
    assert.equal(resultado.campos.centro_custo.sugestao.projeto, "VMAC - LP - DESPESAS ADMINISTRATIVAS");
    assert.equal(resultado.campos.centro_custo.sugestao.origem, "costume_cadastrado");
    assert.ok(resultado.pendencias.some((p) => /Projeto não informado/.test(p)));
    assert.match(resultado.campos.categoria.nome || "", /Refeição - Almoço/i);
});

test("'Cartão de crédito' sem banco vira CARTAO_CREDITO e pede o cartao", () => {
    assert.equal(interpretador.pagamentoDaLinha(cad(), "Cartão de crédito")?.forma, "CARTAO_CREDITO");
    const resultado = previa({ fornecedor: "RESTAURANTE SABOR" }, { tipos: ["ALMOCO"], pagamento: { forma: "CARTAO_CREDITO", cartao: null, rotulo: "Cartão de crédito" } });
    assert.equal(resultado.campos.pagamento.forma, "CARTAO_CREDITO");
    assert.ok(resultado.pendencias.some((p) => /Cartão de crédito sem o banco/.test(p)));
});

test("Azure: docType retailMeal sozinho nao diz que e refeicao", () => {
    assert.equal(azure.tipoSugeridoAzure({ docType: "receipt.retailMeal" }, {}), null);
    assert.equal(azure.tipoSugeridoAzure({ docType: "receipt.retailMeal" }, { ReceiptType: { valueString: "Meal" } }), "alimentacao");
});

test("centro administrativo nao inventa categoria OUTROS (nao existe no Conta Azul)", () => {
    const resultado = previa({ fornecedor: "PAPELARIA CENTRAL", itens: [{ descricao: "CANETA" }] },
        { tipos: ["OUTROS"], projeto_texto: "VMAC - LP - DESPESAS ADMINISTRATIVAS" });
    assert.doesNotMatch(String(resultado.campos.categoria.nome || ""), /OUTROS/i);
});
