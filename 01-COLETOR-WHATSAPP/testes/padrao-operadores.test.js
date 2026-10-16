"use strict";

// Padrao de envio combinado com os operadores (14/10/2026), orientacao da
// gerencia (Vanessa) com periodo e correcao respondendo a foto.
// Banco em memoria e telefones ficticios.

const test = require("node:test");
const assert = require("node:assert/strict");

const banco = require("../src/central/banco");
const orquestrador = require("../src/central/orquestrador");
const regrasVmac = require("../src/central/regras-vmac");
const { interpretar, INTENCOES } = require("../src/central/interpretador");

const GRUPO = "grupo-lorran@g.us";
const LORRAN = "5511900000011@s.whatsapp.net";
const VANESSA = "5511900000012@s.whatsapp.net";
const ID_IMTRAFF = "22222222-2222-4222-8222-222222222222";

function cadastros() {
    return {
        pessoas: [
            { id: "lorran", nome: "Lorran", telefone: "5511900000011", papel: "OPERADOR", pasta_drive: "Lorran" },
            { id: "vanessa", nome: "Vanessa", telefone: "5511900000012", papel: "ADMINISTRATIVO", autoridade_financeira: true },
        ],
        projetos: [
            { nome_oficial: "IMTRAFF CICLO II MT", centro_conta_azul: "IMTRAFF CICLO II MT", id_conta_azul: ID_IMTRAFF, ativo: true, apelidos: [] },
            { nome_oficial: "CTVM-FWD-ADE-IMTRAFF_MT", centro_conta_azul: "CTVM-FWD-ADE-IMTRAFF_MT", id_conta_azul: "55555555-5555-4555-8555-555555555555", ativo: true, apelidos: [] },
            { nome_oficial: "GOINFRA GO", centro_conta_azul: "GOINFRA GO", id_conta_azul: "33333333-3333-4333-8333-333333333333", ativo: true, apelidos: ["Goinfra G.O"] },
        ],
        centros: [],
        veiculos: [],
        cartoes: [
            { codigo: "INTER", rotulo: "CRÉDITO INTER", forma_pagamento: "CARTAO_CREDITO", apelidos: ["inter"] },
            { codigo: "C6", rotulo: "CRÉDITO C6", forma_pagamento: "CARTAO_CREDITO", apelidos: ["c6"] },
        ],
        categorias: [{ nome: "JANTAR", nome_conta_azul: "Refeição - Jantar", id: "44444444-4444-4444-8444-444444444444" }],
        fornecedores: { recorrentes: [] },
    };
}

const legenda = (texto, opcoes = {}) => interpretar(cadastros(), { texto, temMidia: true, ...opcoes });
const mensagem = (texto, opcoes = {}) => interpretar(cadastros(), { texto, temMidia: false, ...opcoes });

// --- Legenda da foto ---------------------------------------------------------

test("'Almoço 3' na foto: tipo almoco e 3 pessoas", () => {
    const { dados } = legenda("Almoço 3");
    assert.deepEqual(dados.tipos, ["ALMOCO"]);
    assert.equal(dados.pessoas.quantidade, 3);
    assert.equal(dados.pessoas.semantica, "PESSOAS");
});

test("'Hospedagem 3' e 'Café 2' tambem sao pessoas", () => {
    assert.equal(legenda("Hospedagem 3").dados.pessoas.quantidade, 3);
    assert.equal(legenda("Café 2").dados.pessoas.quantidade, 2);
    assert.deepEqual(legenda("Café 2").dados.tipos, ["CAFE_DA_MANHA"]);
});

test("'Abastecimento' sozinho: so o tipo, sem pessoas", () => {
    const { dados } = legenda("Abastecimento");
    assert.deepEqual(dados.tipos, ["ABASTECIMENTO"]);
    assert.equal(dados.pessoas, null);
});

test("'Almoço 3 - Pix Murilo': tipo, pessoas e Pix com o nome de quem pagou", () => {
    const { dados } = legenda("Almoço 3 - Pix Murilo");
    assert.deepEqual(dados.tipos, ["ALMOCO"]);
    assert.equal(dados.pessoas.quantidade, 3);
    assert.equal(dados.pagamento.forma, "PIX");
    assert.equal(dados.pagamento.pagador, "Murilo");
});

test("'Janta 2 - Cartão C6': cartao diferente do dia", () => {
    const { dados } = legenda("Janta 2 - Cartão C6");
    assert.equal(dados.pagamento.cartao, "C6");
    assert.equal(dados.pessoas.quantidade, 2);
});

test("Pix no meio da frase (jeito do Almir) tambem e reconhecido", () => {
    const { dados } = legenda("Água desterelizada/ foi pago no Pix que o Murilo fez na minha conta");
    assert.equal(dados.pagamento.forma, "PIX");
    assert.ok(dados.observacoes.length, "a frase fica como observacao");
});

test("'Material - parafusos': material de campo com a descricao", () => {
    const { dados } = legenda("Material - parafusos e fita isolante");
    assert.equal(dados.material, true);
    assert.deepEqual(dados.observacoes, ["parafusos e fita isolante"]);
});

test("descricao livre na foto vira observacao, nao 'linha nao entendida'", () => {
    const { dados } = legenda("Água e gelo para o trecho");
    assert.deepEqual(dados.observacoes, ["Água e gelo para o trecho"]);
    assert.deepEqual(dados.linhas_nao_entendidas, []);
});

test("'Sem nota - exame médico - R$ 90,00 - Pix': despesa sem comprovante completa", () => {
    const resultado = mensagem("Sem nota - exame médico - R$ 90,00 - Pix");
    assert.equal(resultado.intencao, INTENCOES.INFORMACAO_DESPESA);
    assert.equal(resultado.dados.sem_comprovante, true);
    assert.equal(resultado.dados.valor_declarado, 90);
    assert.equal(resultado.dados.pagamento.forma, "PIX");
    assert.deepEqual(resultado.dados.observacoes, ["exame médico"]);
});

// --- Resumo do dia -----------------------------------------------------------

test("resumo do dia no padrao novo continua sendo cabecalho do lote", () => {
    const { intencao, dados } = mensagem("Despesas 14/10/2026\nCentro de custo: Goinfra GO\nCartão: Inter");
    assert.equal(intencao, INTENCOES.INICIO_LOTE_DIARIO);
    assert.equal(dados.data_declarada, "2026-10-14");
    assert.equal(dados.projeto_texto, "Goinfra GO");
    assert.equal(dados.pagamento.cartao, "INTER");
});

test("'Qtd 3 almoço' no resumo (jeito do Almir) e quantidade de PESSOAS", () => {
    const { dados } = mensagem("Despesas 26/09/2026\nCentro de custo\nGoinfra G.O\nQtd 3 almoço\nQtd 2 janta\nQtd 5 abastecimento\nQtd 3 hospedagens");
    const porTipo = Object.fromEntries(dados.quantidades.map((item) => [item.tipo, item]));
    assert.equal(porTipo.ALMOCO.semantica, "PESSOAS");
    assert.equal(porTipo.JANTAR.quantidade, 2);
    assert.equal(porTipo.HOSPEDAGEM.semantica, "PESSOAS", "plural 'hospedagens' reconhecido");
    assert.notEqual(porTipo.ABASTECIMENTO.semantica, "PESSOAS", "abastecimento nao tem pessoas");
});

test("pessoas do resumo do dia valem como informadas (nao 'a confirmar')", () => {
    const lote = { quantidades: { refeicoes_e_tipos: [{ tipo: "ALMOCO", quantidade: 3, semantica: "PESSOAS" }] } };
    const pessoas = regrasVmac.decidirPessoas({ tipo: "ALMOCO", legenda: {}, lote });
    assert.equal(pessoas.valor, 3);
    assert.equal(pessoas.confirmado, true);
    assert.equal(pessoas.origem, "cabecalho_do_lote");
});

// --- Vanessa: acerto de contas e orientacao do periodo ------------------------

const ACERTO = "Pix Murillo:\n22/09 - R$200,00\n25/09 - R$700,00\n\nDespesas:\n31,90 - 28/09\n125,50 - 25/09\n\nTotal das despesas enviadas: 157,40 - 900 = 742,60\n\nSaldo: R$742,60";
const ORIENTACAO = "Despesas do dia 08/10 ao dia 15/10:\nCentro de Custo:\nIMTRAFF CICLO II MT\nCartão de Crédito: Inter";
const VANESSA_PESSOA = { id: "vanessa", nome: "Vanessa", autoridade_financeira: true };

test("acerto de contas (Pix, despesas, saldo) nao vira definicao de projeto", () => {
    const resultado = mensagem(ACERTO, { pessoa: VANESSA_PESSOA });
    assert.equal(resultado.intencao, INTENCOES.ACERTO_FINANCEIRO);
});

test("orientacao da Vanessa: periodo, centro de custo e cartao", () => {
    const resultado = mensagem(ORIENTACAO, { pessoa: VANESSA_PESSOA, referencia: "2026-10-14T01:22:00Z" });
    assert.equal(resultado.intencao, INTENCOES.ORIENTACAO_GERENCIA);
    assert.equal(resultado.dados.projeto_texto, "IMTRAFF CICLO II MT");
    assert.equal(resultado.dados.pagamento.cartao, "INTER");
    assert.deepEqual(resultado.dados.periodo, { de: "2026-10-08", ate: "2026-10-15" });
});

test("a mesma orientacao vinda de quem nao tem autoridade nao vale", () => {
    const resultado = mensagem(ORIENTACAO, { pessoa: { id: "lorran", nome: "Lorran" }, referencia: "2026-10-14T01:22:00Z" });
    assert.notEqual(resultado.intencao, INTENCOES.ORIENTACAO_GERENCIA);
});

const JANTA_10_10 = {
    analyzeResult: { content: "RESTAURANTE SABOR LTDA\n10/10/2026 20:15\nTOTAL R$ 81,88\n", documents: [{ docType: "receipt", confidence: 0.99,
        spans: [{ offset: 0, length: 60 }], fields: { MerchantName: { valueString: "RESTAURANTE SABOR LTDA", confidence: 0.99 },
            Total: { type: "currency", valueCurrency: { amount: 81.88 }, confidence: 0.99 },
            TransactionDate: { type: "date", valueDate: "2026-10-10", confidence: 0.99 }, TransactionTime: { type: "time", valueTime: "20:15:00" } } }] },
};

function fotoDoLorran(db, cad, { legendaFoto = "Janta 1\nIMTRAFF", idMensagem = "foto-1" } = {}) {
    return orquestrador.processarFoto(db, cad, {
        arquivo: `f-${idMensagem}.jpg`, sha256: `h-${idMensagem}`, brutoAzure: JANTA_10_10, hoje: new Date("2026-10-14T12:00:00Z"),
        meta: { id_mensagem: idMensagem, id_grupo: GRUPO, remetente: LORRAN, legenda: legendaFoto, recebido_em_ms: Date.parse("2026-10-10T21:00:00-03:00") },
    }).despesas[0];
}

test("orientacao da Vanessa enviada DEPOIS da nota corrige centro e cartao das notas do periodo", () => {
    const db = banco.abrir(":memory:");
    const cad = cadastros();
    const id = fotoDoLorran(db, cad);
    assert.equal(orquestrador.lerDespesa(db, id).campos.centro_custo.id, null, "'IMTRAFF' sozinho e ambiguo");

    orquestrador.processarMensagemTexto(db, cad, { grupoId: GRUPO, mensagemId: "v-1", remetenteId: VANESSA, remetenteNome: "Vanessa",
        enviadaEm: "2026-10-14T01:22:00Z", texto: ORIENTACAO }, { hoje: new Date("2026-10-14T12:00:00Z") });

    const despesa = orquestrador.lerDespesa(db, id);
    assert.equal(despesa.campos.centro_custo.id, ID_IMTRAFF);
    assert.equal(despesa.campos.centro_custo.origem, "orientacao_da_gerencia");
    assert.equal(despesa.campos.pagamento.cartao, "INTER");
    assert.equal(despesa.campos.pagamento.origem, "orientacao_da_gerencia");
});

test("orientacao nao vale para nota fora do periodo", () => {
    const resultado = regrasVmac.montarPrevia({
        ocr: { data: "2026-10-20", valor: 50, fornecedor: "RESTAURANTE SABOR", confianca: 0.99 },
        legenda: { tipos: ["JANTAR"] }, cad: cadastros(), hoje: new Date("2026-10-21T12:00:00Z"), modelo: null,
        contexto: { orientacoes: [{ projeto_texto: "IMTRAFF CICLO II MT", cartao: "INTER", periodo: { de: "2026-10-08", ate: "2026-10-15" } }] },
    });
    assert.notEqual(resultado.campos.centro_custo.origem, "orientacao_da_gerencia");
});

// --- Correcao respondendo a foto ----------------------------------------------

test("'Correção: Janta 2' respondendo a foto refaz a previa com o que foi corrigido", () => {
    const db = banco.abrir(":memory:");
    const cad = cadastros();
    const id = fotoDoLorran(db, cad, { legendaFoto: "Almoço 1\nIMTRAFF CICLO II MT", idMensagem: "foto-2" });
    assert.equal(orquestrador.lerDespesa(db, id).campos.tipo.valor, "ALMOCO");

    orquestrador.processarMensagemTexto(db, cad, { grupoId: GRUPO, mensagemId: "c-1", remetenteId: LORRAN, remetenteNome: "Lorran",
        enviadaEm: "2026-10-10T21:05:00-03:00", texto: "Correção: Janta 2", citadoId: "foto-2" }, { hoje: new Date("2026-10-14T12:00:00Z") });

    const despesa = orquestrador.lerDespesa(db, id);
    assert.equal(despesa.campos.tipo.valor, "JANTAR");
    assert.equal(despesa.campos.pessoas.valor, 2);
    assert.equal(despesa.campos.centro_custo.id, ID_IMTRAFF, "o resto da legenda original continua valendo");
});

// --- Cadastro de pessoa para conversa no privado ------------------------------

test("cadastrar pessoa grava em pessoas.json, recusa telefone repetido e so devolve o final", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const cadastrosMod = require("../src/central/cadastros");
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "pessoas-"));
    const pessoa = cadastrosMod.adicionarPessoa({ nome: "Gabriel  Lorran", telefone: "(11) 90000-0021" }, pasta);
    assert.deepEqual(pessoa, { id: "gabriel_lorran", nome: "Gabriel Lorran", papel: "OPERADOR", telefone_final: "0021" });
    assert.equal(cadastrosMod.carregar(pasta).pessoas[0].telefone, "5511900000021");
    assert.throws(() => cadastrosMod.adicionarPessoa({ nome: "Outro", telefone: "5511900000021" }, pasta), /já é de Gabriel Lorran/);
    assert.throws(() => cadastrosMod.adicionarPessoa({ nome: "Sem telefone", telefone: "123" }, pasta), /Telefone inválido/);
    fs.rmSync(pasta, { recursive: true, force: true });
});

test("cartao cadastrado no centro de custo vale quando o operador nao informa outro", () => {
    const cad = cadastros();
    cad.projetos[0] = { ...cad.projetos[0], cartao: "C6" };
    const semCartao = regrasVmac.montarPrevia({ ocr: { data: "2026-10-10", valor: 50, fornecedor: "RESTAURANTE SABOR", confianca: 0.99 },
        legenda: { tipos: ["JANTAR"], projeto_texto: "IMTRAFF CICLO II MT" }, cad, hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(semCartao.campos.pagamento.cartao, "C6");
    assert.equal(semCartao.campos.pagamento.origem, "cartao_do_centro_de_custo");
    const outroCartao = regrasVmac.montarPrevia({ ocr: { data: "2026-10-10", valor: 50, fornecedor: "RESTAURANTE SABOR", confianca: 0.99 },
        legenda: { tipos: ["JANTAR"], projeto_texto: "IMTRAFF CICLO II MT", pagamento: { forma: "CARTAO_CREDITO", cartao: "INTER", rotulo: "CRÉDITO INTER" } },
        cad, hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(outroCartao.campos.pagamento.cartao, "INTER");
    assert.ok(outroCartao.pendencias.some((p) => /diverge do cartão cadastrado no centro de custo/.test(p)));
});

// --- Padrao do dia: pessoas informadas antes valem para as notas seguintes ----

function refeicaoEm(data, hora, total) {
    return { analyzeResult: { content: `RESTAURANTE SABOR LTDA\n${data} ${hora}\nTOTAL R$ ${total}\n`, documents: [{ docType: "receipt", confidence: 0.99,
        spans: [{ offset: 0, length: 60 }], fields: { MerchantName: { valueString: "RESTAURANTE SABOR LTDA", confidence: 0.99 },
            Total: { type: "currency", valueCurrency: { amount: total }, confidence: 0.99 },
            TransactionDate: { type: "date", valueDate: data, confidence: 0.99 }, TransactionTime: { type: "time", valueTime: `${hora}:00` } } }] } };
}

function fotoEm(db, cad, { id, remetente = LORRAN, legendaFoto, data, hora, total = 60 }) {
    return orquestrador.processarFoto(db, cad, {
        arquivo: `f-${id}.jpg`, sha256: `h-${id}`, brutoAzure: refeicaoEm(data, hora, total), hoje: new Date("2026-10-16T12:00:00Z"),
        meta: { id_mensagem: id, id_grupo: GRUPO, remetente, legenda: legendaFoto, recebido_em_ms: Date.parse(`${data}T${hora}:00-03:00`) },
    }).despesas[0];
}

test("pessoas informadas mais cedo no MESMO dia valem para as refeicoes seguintes, sem pendencia", () => {
    const db = banco.abrir(":memory:");
    const cad = cadastros();
    fotoEm(db, cad, { id: "a1", legendaFoto: "Almoço 2\nIMTRAFF CICLO II MT", data: "2026-10-14", hora: "12:10" });
    const janta = orquestrador.lerDespesa(db, fotoEm(db, cad, { id: "a2", legendaFoto: "Janta", data: "2026-10-14", hora: "20:05" }));
    assert.equal(janta.campos.pessoas.valor, 2);
    assert.equal(janta.campos.pessoas.origem, "pessoas_do_mesmo_dia");
    assert.equal(janta.campos.descricao.valor, "JANTAR - 2 PESSOAS");
    assert.ok(!janta.pendencias.some((p) => /pessoas/i.test(p)), "nao vira pendencia");
});

test("pessoas de dias anteriores (ate 3) viram estimativa a confirmar", () => {
    const db = banco.abrir(":memory:");
    const cad = cadastros();
    fotoEm(db, cad, { id: "b1", legendaFoto: "Almoço 2", data: "2026-10-13", hora: "12:10" });
    const janta = orquestrador.lerDespesa(db, fotoEm(db, cad, { id: "b2", legendaFoto: "Janta", data: "2026-10-14", hora: "20:05" }));
    assert.equal(janta.campos.pessoas.valor, 2);
    assert.equal(janta.campos.pessoas.origem, "pessoas_de_dias_anteriores");
    assert.ok(janta.pendencias.some((p) => /13\/10/.test(p) && /confirme/i.test(p)));
});

test("o padrao de um operador nunca vale para outro", () => {
    const db = banco.abrir(":memory:");
    const cad = cadastros();
    fotoEm(db, cad, { id: "c1", legendaFoto: "Almoço 4", data: "2026-10-14", hora: "12:10" });
    const outro = orquestrador.lerDespesa(db, fotoEm(db, cad, { id: "c2", remetente: VANESSA, legendaFoto: "Janta", data: "2026-10-14", hora: "20:05" }));
    assert.notEqual(outro.campos.pessoas.origem, "pessoas_do_mesmo_dia");
});

// --- Observacao / reembolso -----------------------------------------------------

test("'paguei do bolso' marca reembolso e vira observacao da nota", () => {
    const { dados } = legenda("Almoço 2 - Paguei do meu bolso, reembolsar");
    assert.equal(dados.reembolso, true);
    const previa = regrasVmac.montarPrevia({ ocr: { data: "2026-10-10", valor: 50, fornecedor: "RESTAURANTE SABOR", confianca: 0.99 },
        legenda: dados, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.match(previa.campos.observacao.valor, /REEMBOLSO/);
    assert.match(previa.campos.observacao.valor, /bolso/i);
});

test("Pix com pagador vira observacao; nota no cartao do dia fica sem observacao", () => {
    const pix = regrasVmac.montarPrevia({ ocr: { data: "2026-10-10", valor: 50, fornecedor: "RESTAURANTE SABOR", confianca: 0.99 },
        legenda: legenda("Almoço 3 - Pix Murilo").dados, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.match(pix.campos.observacao.valor, /PIX.*Murilo/i);
    const cartao = regrasVmac.montarPrevia({ ocr: { data: "2026-10-10", valor: 50, fornecedor: "RESTAURANTE SABOR", confianca: 0.99 },
        legenda: legenda("Almoço 3 - Cartão C6").dados, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(cartao.campos.observacao.valor, null);
});
