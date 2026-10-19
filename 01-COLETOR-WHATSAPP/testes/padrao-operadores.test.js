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
    const id = fotoDoLorran(db, cad, { legendaFoto: "Janta 1\nIMTRAFF CICLO II MT", idMensagem: "foto-2" });
    assert.equal(orquestrador.lerDespesa(db, id).campos.pessoas.valor, 1);

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

test("nome de centro com ' - ' nao e cortado (rotulado, na linha seguinte ou sozinho)", () => {
    const cad = { ...cadastros(), projetos: [...cadastros().projetos, { nome_oficial: "IMTRAFF - MT FWD", ativo: true, apelidos: [] }] };
    const ler = (texto, temMidia = false) => interpretar(cad, { texto, temMidia }).dados;
    assert.equal(ler("Despesas 10/09/2026\nCentro de custo: IMTRAFF - MT FWD\nCartão: Inter").projeto_texto, "IMTRAFF - MT FWD");
    assert.equal(ler("Despesas 10/09/2026\nCentro de custo\nHOUER / YVY - ROTA DO PEQUI").projeto_texto, "HOUER / YVY - ROTA DO PEQUI");
    const foto = ler("Almoço 2\nIMTRAFF - MT FWD", true);
    assert.equal(foto.projeto_texto, "IMTRAFF - MT FWD");
    assert.equal(foto.pessoas.quantidade, 2);
});

// --- Manutencao e pedagio (achados do treino com historico, 16/10/2026) ---------

test("manutencao: legenda ou oficina na nota; categoria de manutencao do veiculo pela placa", () => {
    const cad = { ...cadastros(), veiculos: [{ nome: "HILUX - OVN5J98", placa: "OVN5J98", categoria_nome_conta_azul: "HILUX - OVN5J98", manutencao_categoria_nome: "MANUTENÇÃO HILUX OVN5J98" }],
        categorias: [...cadastros().categorias, { nome: "MANUTENCAO", nome_conta_azul: "Manutenção de Veículos", id: null }],
        fornecedores: { recorrentes: [], genericos_por_tipo: { MANUTENCAO: "MANUTENÇÃO VEÍCULOS" } } };
    assert.deepEqual(legenda("Manutenção - tambor de freio").dados.tipos, ["MANUTENCAO"]);
    const comPlaca = regrasVmac.montarPrevia({ ocr: { data: "2026-10-01", valor: 350, fornecedor: "AUTO CENTER SILVA", confianca: 0.99 },
        legenda: interpretar(cad, { texto: "Manutenção - tambor de freio\nOVN5J98", temMidia: true }).dados, cad, hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(comPlaca.campos.tipo.valor, "MANUTENCAO");
    assert.equal(comPlaca.campos.categoria.nome, "MANUTENÇÃO HILUX OVN5J98");
    assert.equal(comPlaca.campos.fornecedor.valor, "MANUTENÇÃO VEÍCULOS");
    const pelaNota = regrasVmac.montarPrevia({ ocr: { data: "2026-10-01", valor: 90, fornecedor: "OFICINA MECANICA DO ZE", confianca: 0.99 },
        legenda: {}, cad, hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(pelaNota.campos.tipo.valor, "MANUTENCAO");
    assert.equal(pelaNota.campos.categoria.nome, "Manutenção de Veículos");
});

test("concessionaria de rodovia na nota e pedagio, nao refeicao", () => {
    const previa = regrasVmac.montarPrevia({ ocr: { data: "2026-10-04", hora: "20:10", valor: 12.5, fornecedor: "Conc. ECOVIAS RAPOSO CASTELLO", confianca: 0.62, tipo_despesa_sugerido: "alimentacao" },
        legenda: legenda("PEDAGIOS").dados, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(previa.campos.tipo.valor, "PEDAGIO");
});

// --- Agua e gerador (orientacao do Yan, 16/10/2026) ------------------------------

const CAD_AGUA_GERADOR = () => ({ ...cadastros(), categorias: [...cadastros().categorias, { nome: "Água", nome_conta_azul: "Água", id: null }, { nome: "GERADOR", nome_conta_azul: "GERADOR", id: null }],
    fornecedores: { recorrentes: [], fornecedor_generico_mercado: "SUPERMERCADO", genericos_por_tipo: { ABASTECIMENTO: "POSTOS DE COMBUSTÍVEL", REFEICAO: "RESTAURANTES" } } });

test("agua: nota so de agua vira categoria Agua com a quantidade na descricao", () => {
    const previa = regrasVmac.montarPrevia({ ocr: { data: "2026-09-21", valor: 18, fornecedor: "SUPERMERCADO BOM PRECO", confianca: 0.99,
        itens: [{ descricao: "AGUA MINERAL 500ML", quantidade: 6 }] }, legenda: {}, cad: CAD_AGUA_GERADOR(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(previa.campos.tipo.valor, "AGUA");
    assert.equal(previa.campos.categoria.nome, "Água");
    assert.equal(previa.campos.descricao.valor, "ÁGUA - 6 UNIDADES");
    assert.equal(previa.campos.fornecedor.valor, "SUPERMERCADO");
    const legendaAgua = interpretar(CAD_AGUA_GERADOR(), { texto: "Água 12", temMidia: true }).dados;
    assert.deepEqual(legendaAgua.tipos, ["AGUA"]);
    assert.equal(legendaAgua.quantidade_agua, 12);
});

test("gerador: ate 12 L sem placa nem hodometro, ou quando a mensagem diz gerador", () => {
    const posto = (extra) => ({ data: "2026-09-26", valor: 62.96, fornecedor: "AUTO POSTO X", confianca: 0.99, litragem: 10.01, itens: [{ descricao: "GASOLINA COMUM" }], ...extra });
    const semPlaca = regrasVmac.montarPrevia({ ocr: posto({}), legenda: { tipos: ["ABASTECIMENTO"] }, cad: CAD_AGUA_GERADOR(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(semPlaca.campos.categoria.nome, "GERADOR");
    assert.equal(semPlaca.campos.descricao.valor, "GERADOR - 10,01L");
    assert.ok(!semPlaca.pendencias.some((p) => /placa|hodômetro/i.test(p)), "gerador nao tem placa nem hodometro");
    const dito = regrasVmac.montarPrevia({ ocr: posto({ litragem: 16.24, valor: 111.08 }), legenda: interpretar(CAD_AGUA_GERADOR(), { texto: "Gerador", temMidia: true }).dados,
        cad: CAD_AGUA_GERADOR(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(dito.campos.categoria.nome, "GERADOR");
    const carro = regrasVmac.montarPrevia({ ocr: posto({ placa: "SGR4B54", odometro: 145225 }), legenda: { tipos: ["ABASTECIMENTO"] }, cad: CAD_AGUA_GERADOR(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.notEqual(carro.campos.categoria.nome, "GERADOR", "com placa e hodometro e veiculo");
});

test("refeicao em padaria vai com fornecedor PADARIA; em mercado, SUPERMERCADO", () => {
    const cad = { ...cadastros(), fornecedores: { recorrentes: [], fornecedor_generico_mercado: "SUPERMERCADO", genericos_por_tipo: { CAFE_DA_MANHA: "RESTAURANTES", LANCHE: "RESTAURANTES", PADARIA: "PADARIA" } } };
    const padaria = regrasVmac.montarPrevia({ ocr: { data: "2026-09-21", hora: "07:30", valor: 18, fornecedor: "PANIFICADORA PAO QUENTE", confianca: 0.99 },
        legenda: legenda("Café 2").dados, cad, hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(padaria.campos.fornecedor.valor, "PADARIA");
    const mercado = regrasVmac.montarPrevia({ ocr: { data: "2026-09-21", hora: "16:30", valor: 22, fornecedor: "SUPERMERCADO BOM PRECO LTDA", confianca: 0.99 },
        legenda: legenda("Lanche 2").dados, cad, hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(mercado.campos.fornecedor.valor, "SUPERMERCADO");
});

test("palpite do Azure ('parece refeicao') nao vence a legenda do operador", () => {
    const previa = regrasVmac.montarPrevia({ ocr: { data: "2026-09-21", valor: 180, fornecedor: "COMERCIAL SILVA LTDA", confianca: 0.99, tipo_despesa_sugerido: "alimentacao" },
        legenda: legenda("Manutenção - filtro de combustível").dados, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(previa.campos.tipo.valor, "MANUTENCAO");
});

test("reembolso: descricao do anexo vira 'REEMBOLSO <OPERADOR>' (mesmo com so 'Reembolso' na legenda)", () => {
    const lorran = { pessoa: { id: "lorran", nome: "Lorran" }, origem: "telefone" };
    const so = legenda("Almoço 2 - Reembolso").dados;
    assert.equal(so.reembolso, true);
    const previa = regrasVmac.montarPrevia({ ocr: { data: "2026-10-10", valor: 58, fornecedor: "RESTAURANTE SABOR", confianca: 0.99 },
        legenda: so, identificacao: lorran, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(previa.campos.anexo.descricao, "REEMBOLSO LORRAN");
    const normal = regrasVmac.montarPrevia({ ocr: { data: "2026-10-10", valor: 58, fornecedor: "RESTAURANTE SABOR", confianca: 0.99 },
        legenda: legenda("Almoço 2").dados, identificacao: lorran, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(normal.campos.anexo.descricao, null);
});

// --- Nota analisada por inteiro (achado do Yan, 18/10/2026: #127) ----------------

test("posto com lanchonete: itens de comida (sem combustivel) = refeicao, mesmo com '1LT' do suco", () => {
    const ocr = { data: "2026-09-26", hora: "11:52", valor: 87, fornecedor: "POSTO DE SERVICOS BEIRA RIO", nome_fantasia: "POSTO BEIRA RIO", confianca: 0.99, litragem: 1, placa: "ATC0786",
        itens: [{ descricao: "PRATO FEITO NORMAL", quantidade: 1 }, { descricao: "PRATO FEITO NORMAL", quantidade: 1 }, { descricao: "PRATO FEITO NORMAL", quantidade: 1 }, { descricao: "SUCO LA FRUIT UVA 1LT", quantidade: 1 }] };
    const cad = { ...cadastros(), fornecedores: { recorrentes: [], genericos_por_tipo: { ALMOCO: "RESTAURANTES", ABASTECIMENTO: "POSTOS DE COMBUSTÍVEL" } } };
    const comLegenda = regrasVmac.montarPrevia({ ocr, legenda: legenda("Almoço").dados, cad, hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(comLegenda.campos.tipo.valor, "ALMOCO");
    assert.equal(comLegenda.campos.fornecedor.valor, "RESTAURANTES");
    assert.equal(comLegenda.campos.abastecimento, undefined, "nada de litros/placa em refeicao");
    const semLegenda = regrasVmac.montarPrevia({ ocr, legenda: {}, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.ok(regrasVmac.TIPOS[semLegenda.campos.tipo.valor]?.refeicao, "itens de comida = refeicao");
});

test("posto com item de combustivel continua abastecimento", () => {
    const previa = regrasVmac.montarPrevia({ ocr: { data: "2026-09-26", valor: 200, fornecedor: "AUTO POSTO X", confianca: 0.99, litragem: 35.4, placa: "SGR4B54", odometro: 145225,
        itens: [{ descricao: "GASOLINA COMUM", quantidade: 35.4 }, { descricao: "AGUA MINERAL", quantidade: 1 }] }, legenda: {}, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(previa.campos.tipo.valor, "ABASTECIMENTO");
});

test("pessoas: linhas iguais de prato somam (3 x 'PRATO FEITO' = 3) e valem mais que o padrao do dia", () => {
    const ocr = { itens: [{ descricao: "PRATO FEITO NORMAL", quantidade: 1 }, { descricao: "PRATO FEITO NORMAL", quantidade: 1 }, { descricao: "PRATO FEITO NORMAL", quantidade: 1 }, { descricao: "SUCO UVA 1LT", quantidade: 1 }] };
    const pessoas = regrasVmac.decidirPessoas({ tipo: "ALMOCO", legenda: {}, lote: null, ocr, recentes: { valor: 2, mesmo_dia: true, despesa_id: 1 } });
    assert.equal(pessoas.valor, 3);
    assert.equal(pessoas.origem, "pratos_da_nota");
    assert.equal(pessoas.confirmado, false);
});

// --- Achados dos comentarios do Yan (19/10/2026) ------------------------------

test("litros pela conta (litros x preco = valor) quando a unidade veio torta ('20,524 IT')", () => {
    const ocr = { data: "2026-09-20", valor: 133.20, fornecedor: "AUTO POSTO X", confianca: 0.99, placa: "OVN1505", odometro: 270872, litragem: null,
        itens: [{ descricao: "GASOLINA C COMUM" }], texto_bruto: "GASOLINA C COMUN\n6.490\n20,524 IT\nTOTAL 133,20" };
    const previa = regrasVmac.montarPrevia({ ocr, legenda: legenda("Abastecimento").dados, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(previa.campos.abastecimento.litros.valor, 20.524);
    assert.equal(previa.campos.descricao.valor, "20,524L od 270.872 - OVN1505");
    assert.ok(previa.avisos.some((a) => /Litros calculados/.test(a)));
});

test("legenda diz Jantar mas a nota e do meio-dia: vale a nota (almoco), com aviso", () => {
    const previa = regrasVmac.montarPrevia({ ocr: { data: "2026-09-25", hora: "12:40", valor: 90, fornecedor: "RESTAURANTE SABOR", confianca: 0.99 },
        legenda: legenda("Janta 3").dados, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(previa.campos.tipo.valor, "ALMOCO");
    assert.ok(previa.avisos.some((a) => /12:40/.test(a)));
});

test("descricao livre na legenda + so palpite do Azure: nao vira lanche", () => {
    const previa = regrasVmac.montarPrevia({ ocr: { data: "2026-09-25", hora: "16:00", valor: 30, fornecedor: "COMERCIAL SANTOS", confianca: 0.99, tipo_despesa_sugerido: "alimentacao" },
        legenda: legenda("Pano de chão").dados, cad: cadastros(), hoje: new Date("2026-10-14T12:00:00Z"), modelo: null });
    assert.equal(previa.campos.tipo.valor, "OUTROS");
});
