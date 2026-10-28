"use strict";

// Regras tiradas dos comentarios e correcoes do Yan (21-24/10/2026).

const test = require("node:test");
const assert = require("node:assert/strict");

const cadastros = require("../src/central/cadastros");
const { montarPrevia } = require("../src/central/regras-vmac");
const interpretador = require("../src/central/interpretador");

const cad = cadastros.carregar();
const previa = (ocr, legenda = {}, extra = {}) => montarPrevia({ ocr: { data: "2026-10-20", confianca: 0.99, ...ocr }, legenda, contexto: {}, identificacao: {}, cad, ...extra });
const item = (descricao, quantidade = 1, valor_total = 10) => ({ descricao, quantidade, valor_total });

test("almoco no administrativo fica em Refeição - Almoço; jantar em Refeição - Jantar", () => {
    const almoco = previa({ valor: 138, hora: "12:20", fornecedor: "RESTAURANTE SABOR", itens: [item("SELF SERVICE")] }, { tipos: ["ALMOCO"], projeto_texto: "DESPESAS ADMINISTRATIVAS" });
    assert.equal(almoco.campos.categoria.nome, "Refeição - Almoço");
    const jantar = previa({ valor: 80, hora: "20:10", fornecedor: "RESTAURANTE SABOR", itens: [item("PRATO")] }, { tipos: ["JANTAR"], projeto_texto: "DESPESAS ADMINISTRATIVAS" });
    assert.equal(jantar.campos.categoria.nome, "Refeição - Jantar");
});

test("pessoas pelo valor: R$ 33 e 1 pessoa; R$ 138 de almoco nao e 1", () => {
    const barato = previa({ valor: 33, hora: "12:00", fornecedor: "RESTAURANTE", itens: [item("REFEICAO KG BALANCA")] }, { tipos: ["ALMOCO"] });
    assert.equal(barato.campos.pessoas.valor, 1);
    const caro = previa({ valor: 138, hora: "12:00", fornecedor: "RESTAURANTE", itens: [item("SELF SERVICE")] }, { tipos: ["ALMOCO"] });
    assert.equal(caro.campos.pessoas.valor, 3);
    assert.ok(caro.pendencias.some((p) => /pelo valor/.test(p)));
    // Dito pelo operador: fica, so avisa.
    const dito = previa({ valor: 33, hora: "12:00", fornecedor: "RESTAURANTE", itens: [item("REFEICAO")] }, interpretador.interpretar(cad, { texto: "Almoço 4 pessoas", temMidia: true }).dados);
    assert.equal(dito.campos.pessoas.valor, 4);
    assert.ok(dito.avisos.some((a) => /fora do comum/.test(a)));
});

test("so bebida nao e lanche: OUTROS, Lanches e Refeições, 'COCA COLA - 5'", () => {
    const r = previa({ valor: 45, hora: "15:00", fornecedor: "AAGC COMERCIO VAREJISTA DE ALIMENTOS", itens: [item("REFRIGERANTE COCA COLA 2L", 5, 45)] });
    assert.equal(r.campos.tipo.valor, "OUTROS");
    assert.equal(r.campos.categoria.nome, "Lanches e Refeições");
    assert.equal(r.campos.descricao.valor, "COCA COLA - 5");
});

test("uber vira Transporte Urbano", () => {
    const r = previa({ valor: 23.4, fornecedor: "UBER DO BRASIL TECNOLOGIA" });
    assert.equal(r.campos.tipo.valor, "TRANSPORTE");
    assert.equal(r.campos.categoria.nome, "Transporte Urbano (táxi, Uber)");
    assert.equal(r.campos.descricao.valor, "UBER");
});

test("oficina: autopecas -> AUTO PEÇAS; MECAN/autocenter/pneu -> Oficina Mecanica", () => {
    const pecas = previa({ valor: 300, fornecedor: "CIELO", texto_bruto: "AUTOPEÇAS SANTA BRANCA\nCNPJ 00", itens: [item("PASTILHA DE FREIO")] });
    assert.equal(pecas.campos.tipo.valor, "MANUTENCAO");
    assert.equal(pecas.campos.fornecedor.valor, "AUTO PEÇAS");
    const pneu = previa({ valor: 80, fornecedor: "AUTOCENTER BOA VIAGEM", itens: [item("MONTAGEM PNEU")] });
    assert.equal(pneu.campos.tipo.valor, "MANUTENCAO");
    assert.equal(pneu.campos.fornecedor.valor, "Oficina Mecanica");
});

test("material: descricao curta com o que foi comprado", () => {
    const r = previa({ valor: 40, fornecedor: "MIFER FERRAGEM", itens: [item("CHAVE ALAVANCA ON/OFF/ON 10A 12 6A 250V"), item("CHAVE MG L/D CS301D MB1P1")] });
    assert.equal(r.campos.descricao.valor, "CHAVE ALAVANCA E CHAVE MG");
});

test("material do Everson vai para 'Material p/ depósito' pela regra confirmada", () => {
    const everson = cad.pessoas.find((p) => p.id === "everson");
    const regrasOperador = [{ id: 1, pessoa_id: "everson", campo: "categoria_material", valor: "Material p/ depósito", desde: "2026-10-01", ate: null, ativa: 1 }];
    const r = montarPrevia({ ocr: { data: "2026-10-20", valor: 25, confianca: 0.99, fornecedor: "LOJA X", itens: [item("CAIXA PASSAGEM 4X2"), item("FITA ISOLANTE")] },
        legenda: {}, contexto: {}, identificacao: { pessoa: everson }, cad, regrasOperador });
    assert.equal(r.campos.categoria.nome, "Material p/ depósito");
});

test("nota sem data usa a do cabecalho do dia ou a do envio, pedindo conferencia", () => {
    const r = montarPrevia({ ocr: { data: null, valor: 50, confianca: 0.99, fornecedor: "RESTAURANTE" }, legenda: { tipos: ["ALMOCO"] },
        contexto: { momento: "2026-10-24T15:00:00Z" }, identificacao: {}, cad });
    assert.equal(r.campos.data_competencia.valor, "2026-10-24");
    assert.ok(r.pendencias.some((p) => /Data não lida na nota/.test(p)));
});

test("madrugada (00:07) e lanche, nao jantar", () => {
    const r = previa({ valor: 30, hora: "00:07", fornecedor: "LANCHONETE", itens: [item("X BURGUER")] });
    assert.equal(r.campos.tipo.valor, "LANCHE");
});

test("agua comprada em posto (nome no plural) vai para POSTOS DE COMBUSTÍVEL", () => {
    const r = previa({ valor: 16, fornecedor: "POSTOS QUALIS", itens: [item("AGUA MINERAL 500ML", 8, 16)] }, { tipos: ["AGUA"] });
    assert.equal(r.campos.fornecedor.valor, "POSTOS DE COMBUSTÍVEL");
});

test("cupom com duas placas parecidas usa a que esta na frota", () => {
    const naFrota = cad.veiculos[0].placa;
    const parecida = naFrota.replace(/[A-Z](?=\d\d$)/, (c) => ({ B: "8", G: "6", I: "1", O: "0", S: "5", Z: "2" })[c] || c);
    if (parecida === naFrota) return; // frota sem placa Mercosul com letra trocavel
    const r = previa({ valor: 200, fornecedor: "AUTO POSTO X", placa: null, placa_candidatas: [parecida, naFrota], litragem: 30, odometro: 1000, itens: [item("GASOLINA COMUM", 30, 200)] });
    assert.equal(r.campos.abastecimento.placa.valor.replace("-", ""), naFrota.replace("-", ""));
});

test("litros sem unidade ('36.650 4'): unica quantidade com 3 casas que da preco plausivel", () => {
    const r = previa({ valor: 241.52, fornecedor: "AUTO POSTO ROGEPEL", placa: "ABC1D23", odometro: 45657, texto_bruto: "GASOLINA ORIGINAL COMUM\n36.650 4\n5,59\n241.52", itens: [item("GASOLINA ORIGINAL COMUM", 1, 241.52)] });
    assert.equal(r.campos.abastecimento.litros.valor, 36.65);
    assert.ok(r.pendencias.some((p) => /sem a unidade/.test(p)));
});

// Decisoes de 28/10/2026 (ex-notas #79, #112, #125, #249).

test("pedagio vai sempre para o fornecedor DIVERSOS (decisao de 28/10, nota #249)", () => {
    const r = previa({ valor: 21.8, fornecedor: "Conc. ECOVIAS" }, { tipos: ["PEDAGIO"] });
    assert.equal(r.campos.tipo.valor, "PEDAGIO");
    assert.equal(r.campos.fornecedor.valor, "DIVERSOS");
});

