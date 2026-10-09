"use strict";

// Criterios de aceitacao do dossie VMac (secao 17.1 e adendo 22) aplicados ao
// novo motor da Central. Banco sempre em memoria: nunca toca dados reais.

const test = require("node:test");
const assert = require("node:assert/strict");

const banco = require("../src/central/banco");
const cadastros = require("../src/central/cadastros");
const { interpretar, INTENCOES } = require("../src/central/interpretador");
const contexto = require("../src/central/contexto");
const orquestrador = require("../src/central/orquestrador");
const { dividirDocumentos, impressaoDigital } = require("../src/central/documentos");
const regras = require("../src/central/regras-vmac");
const { odometroDoTexto } = require("../src/azure-ocr");

const GRUPO = "grupo-teste@g.us";
const ALMIR = "5511900000001@s.whatsapp.net";
const VITOR = "5512900000002@s.whatsapp.net";
const VANESSA = "5561900000003@s.whatsapp.net";
const ID_PROJETO = "11111111-1111-4111-8111-111111111111";

function cadastrosDeTeste() {
    return {
        pessoas: [
            { id: "vanessa", nome: "Vanessa", telefone: "5561900000003", papel: "ADMINISTRATIVO", autoridade_financeira: true, pasta_drive: null },
            { id: "almir", nome: "Almir", telefone: "5511900000001", papel: "OPERADOR", pasta_drive: "Almir" },
            { id: "vitor", nome: "Vitor", telefone: "5512900000002", papel: "OPERADOR", pasta_drive: "Vitor" },
            { id: "lorran", nome: "Lorran", telefone: "5561900000004", papel: "OPERADOR", pasta_drive: "Lorran" },
        ],
        projetos: [
            { nome_oficial: "GOINFRA FWD", id_conta_azul: ID_PROJETO, ativo: true, apelidos: ["goinfra g.o"] },
            { nome_oficial: "GOINFRA VDROD", id_conta_azul: "22222222-2222-4222-8222-222222222222", ativo: true, apelidos: [] },
            { nome_oficial: "PROJETO ANTIGO", id_conta_azul: null, ativo: false, apelidos: [] },
        ],
        centros: [],
        veiculos: [{ nome: "FIAT SCUDO - SGR4B54", placa: "SGR4B54", categoria_id: "33333333-3333-4333-8333-333333333333", categoria_nome_conta_azul: "FIAT SCUDO - SGR4B54" },
            { nome: "ETIOS - JKM0196", placa: "JKM0196", categoria_id: null, categoria_nome_conta_azul: "ETIOS - JKM0I96" }],
        cartoes: [
            { codigo: "INTER", rotulo: "CRÉDITO INTER", forma_pagamento: "CARTAO_CREDITO", apelidos: ["credito inter", "inter"] },
            { codigo: "C6", rotulo: "CRÉDITO C6", forma_pagamento: "CARTAO_CREDITO", apelidos: ["credito c6", "c6"] },
        ],
        categorias: [
            { nome: "JANTAR", nome_conta_azul: "Refeição - Jantar", id: "44444444-4444-4444-8444-444444444444" },
            { nome: "ALMOCO", nome_conta_azul: "Refeição - Almoço", id: "55555555-5555-4555-8555-555555555555" },
            { nome: "CAFE DA MANHA", nome_conta_azul: "Refeição - Café da Manhã", id: "66666666-6666-4666-8666-666666666666" },
        ],
        fornecedores: { fornecedor_generico_mercado: "MERCADO", recorrentes: [{ nome: "BELLAVIA SUPERMERCADO", apelidos: ["bellavia"] }] },
    };
}

const cad = cadastrosDeTeste();
const pessoa = (id) => cad.pessoas.find((item) => item.id === id);

// --- Resposta do Azure montada para os testes --------------------------------

function documentoAzure(conteudo, inicio, fim, { fornecedor, total, data, hora }) {
    const campos = {
        MerchantName: { valueString: fornecedor, confidence: 0.99 },
        Total: { type: "currency", valueCurrency: { amount: total }, confidence: 0.99 },
        TransactionDate: { type: "date", valueDate: data, confidence: 0.99 },
    };
    if (hora) campos.TransactionTime = { type: "time", valueTime: hora };
    return { docType: "receipt", confidence: 0.99, spans: [{ offset: inicio, length: fim - inicio }], fields: campos };
}

function azure(partes) {
    let conteudo = "";
    const documentos = partes.map((parte) => {
        const inicio = conteudo.length;
        conteudo += `${parte.texto}\n`;
        return documentoAzure(conteudo, inicio, conteudo.length, parte);
    });
    return { analyzeResult: { content: conteudo, documents: documentos } };
}

const JANTAR = { texto: "RESTAURANTE SABOR LTDA\n30/09/2026 20:15\nTOTAL R$ 85,50", fornecedor: "RESTAURANTE SABOR LTDA", total: 85.5, data: "2026-09-30", hora: "20:15:00" };
const POSTO = { texto: "AUTO POSTO BOA VIAGEM\n30/09/2026 07:10\nGASOLINA COMUM 35,43 L\nPLACA: SGR4B54\nKM: 145225\nFORMA DE PAGAMENTO\nDinheiro", fornecedor: "AUTO POSTO BOA VIAGEM", total: 210, data: "2026-09-30", hora: "07:10:00" };

function novoBanco() { return banco.abrir(":memory:"); }

function lote(db, remetente, texto, enviadaEm = "2026-09-30T22:00:00-03:00", id = `l-${Math.random()}`) {
    return contexto.registrarMensagem(db, cad, { grupoId: GRUPO, mensagemId: id, remetenteId: remetente, remetenteNome: "", enviadaEm, texto });
}

function foto(db, { remetente = ALMIR, arquivo = `f-${Math.random()}.jpg`, sha = `h-${Math.random()}`, legenda = "", bruto, recebida = "2026-10-01T08:00:00-03:00" }) {
    const resultado = orquestrador.processarFoto(db, cad, {
        arquivo, sha256: sha, brutoAzure: bruto, regras: { confianca_minima: 0.9 }, hoje: new Date("2026-10-02T12:00:00Z"),
        meta: { id_mensagem: `m-${arquivo}`, id_grupo: GRUPO, remetente, legenda, recebido_em_ms: Date.parse(recebida) },
    });
    return { ...resultado, lidas: resultado.despesas.map((id) => orquestrador.lerDespesa(db, id)) };
}

// --- Interpretacao de mensagens -------------------------------------------------

test("cabecalho de lote do Almir e entendido sem rotulos padronizados", () => {
    const resultado = interpretar(cad, { pessoa: pessoa("almir"), texto: "Despesas 29/09/2026\nCentro de custo\nGoinfra G.O\nQtd 3 almoço\nQtd 3 janta\nQtd 2 hospedagem\nQtd 4 abastecimento\nQtd 1 Coca-Cola\n1 café" });
    assert.equal(resultado.intencao, INTENCOES.INICIO_LOTE_DIARIO);
    assert.equal(resultado.dados.data_declarada, "2026-09-29");
    assert.equal(resultado.dados.projeto_texto, "Goinfra G.O");
    assert.deepEqual(resultado.dados.quantidades.map((item) => [item.tipo, item.quantidade, item.semantica]), [
        ["ALMOCO", 3, "INDETERMINADA"], ["JANTAR", 3, "INDETERMINADA"], ["HOSPEDAGEM", 2, "INDETERMINADA"],
        ["ABASTECIMENTO", 4, "INDETERMINADA"], ["CAFE_DA_MANHA", 1, "INDETERMINADA"],
    ]);
    assert.deepEqual(resultado.dados.itens_citados.map((item) => item.descricao), ["Coca-Cola"]);
});

test("projeto escrito numa linha solta depois de 'Despesas <data>' vira o projeto do lote", () => {
    const resultado = interpretar(cad, { pessoa: pessoa("almir"), texto: "Despesas 06/10/2026\nGOINFRA FWD\nCRÉDITO C6\nAbastecimento" });
    assert.equal(resultado.intencao, INTENCOES.INICIO_LOTE_DIARIO);
    assert.equal(resultado.dados.projeto_texto, "GOINFRA FWD");
    assert.equal(resultado.dados.pagamento.cartao, "C6");
});

test("mensagens rotineiras da Vanessa nao mudam cartao nem projeto", () => {
    assert.equal(interpretar(cad, { pessoa: pessoa("vanessa"), texto: "Obrigada, Almir." }).intencao, INTENCOES.CONVERSA_IRRELEVANTE);
    assert.equal(interpretar(cad, { pessoa: pessoa("vanessa"), texto: "Faltam as notas de ontem." }).intencao, INTENCOES.COBRANCA_COMPROVANTE);
    assert.equal(interpretar(cad, { pessoa: pessoa("vanessa"), texto: "A despesa de ontem do Vitor era HOUER e não GOINFRA." }).intencao, INTENCOES.CORRECAO_DESPESA);
    const regra = interpretar(cad, { pessoa: pessoa("vanessa"), texto: "Para o projeto GOINFRA FWD a partir de agora utilizar C6." });
    assert.equal(regra.intencao, INTENCOES.DEFINICAO_CARTAO_POR_PROJETO);
    assert.equal(regra.autorizada, true);
    assert.equal(regra.dados.projeto_texto, "GOINFRA FWD");
});

test("nota perdida do Lorran vira despesa SEM COMPROVANTE em revisao", () => {
    const db = novoBanco();
    const resultado = orquestrador.processarMensagemTexto(db, cad, {
        grupoId: GRUPO, mensagemId: "lorran-1", remetenteId: "5561900000004@s.whatsapp.net", enviadaEm: "2026-10-02T09:00:00-03:00",
        texto: "Data 01/10/2026\nJanta\nLorran\nValor R$ 37\nObservações: perdi a notinha, foi último pagamento do dia 1",
    });
    const despesa = orquestrador.lerDespesa(db, resultado.despesa);
    assert.equal(despesa.estado, "AGUARDANDO_REVISAO");
    assert.equal(despesa.campos.sem_comprovante.valor, true);
    assert.equal(despesa.campos.valor.valor, null, "valor sem nota nunca vira valor comprovado");
    assert.equal(despesa.campos.valor.sugestao.valor, 37);
    assert.ok(despesa.pendencias.some((texto) => texto.startsWith("SEM COMPROVANTE")));
});

// --- Leitura e regras de campo ---------------------------------------------------

test("uma foto com duas notas de compras diferentes gera duas despesas com a mesma foto", () => {
    const db = novoBanco();
    lote(db, ALMIR, "Despesas 30/09/2026\nCentro de custo\nGoinfra G.O\nCRÉDITO C6\nQtd 3 janta\nQtd 3 abastecimento");
    const resultado = foto(db, { bruto: azure([JANTAR, POSTO]) });
    assert.equal(resultado.lidas.length, 2);
    assert.ok(resultado.lidas.every((despesa) => despesa.midia_id === resultado.midiaId));
    assert.deepEqual(resultado.lidas.map((despesa) => despesa.campos.tipo.valor).sort(), ["ABASTECIMENTO", "JANTAR"]);
});

test("abastecimento: descricao literal, anexo Documento fiscal e cartao do contexto vence o 'Dinheiro' do cupom", () => {
    const db = novoBanco();
    lote(db, ALMIR, "Despesas 30/09/2026\nCentro de custo\nGoinfra G.O\nCRÉDITO C6\nAbastecimento");
    const [despesa] = foto(db, { bruto: azure([POSTO]) }).lidas;
    assert.equal(despesa.campos.descricao.valor, "35,43L od 145.225 - SGR4B54");
    assert.equal(despesa.campos.anexo.tipo, "Documento fiscal");
    assert.equal(despesa.campos.pagamento.cartao, "C6");
    assert.equal(despesa.campos.pagamento.forma, "CARTAO_CREDITO");
    assert.equal(despesa.campos.categoria.nome, "FIAT SCUDO - SGR4B54");
    assert.equal(despesa.campos.centro_custo.id, ID_PROJETO);
    assert.deepEqual(despesa.pendencias, []);
    assert.equal(despesa.estado, "CLASSIFICADO");
});

test("abastecimento sem hodometro fica pendente e nao inventa descricao", () => {
    const db = novoBanco();
    lote(db, ALMIR, "Despesas 30/09/2026\nCentro de custo\nGoinfra G.O\nCRÉDITO C6");
    const semKm = { ...POSTO, texto: POSTO.texto.replace("KM: 145225\n", "") };
    const [despesa] = foto(db, { bruto: azure([semKm]) }).lidas;
    assert.equal(despesa.campos.descricao.valor, null);
    assert.equal(despesa.estado, "AGUARDANDO_REVISAO");
    assert.ok(despesa.pendencias.some((texto) => /hodômetro/.test(texto)));
});

test("formatador de abastecimento segue exatamente o padrao VMac", () => {
    assert.equal(regras.descricaoAbastecimento({ litros: 35.43, odometro: 145225, placa: "jkn-2876" }), "35,43L od 145.225 - JKN2876");
    assert.equal(regras.descricaoAbastecimento({ litros: 35.43, odometro: null, placa: "JKN2876" }), null);
    assert.equal(regras.descricaoRefeicao("JANTAR", 3), "JANTAR - 3 PESSOAS");
    assert.equal(regras.descricaoRefeicao("ALMOCO", 1), "ALMOÇO - 1 PESSOA");
});

test("hodometro ignora o km da rodovia no endereco do posto", () => {
    assert.equal(odometroDoTexto("POSTO X\nROD BR-116 KM 245\nKM: 145.225"), 145225);
    assert.equal(odometroDoTexto("ROD BR-116 KM 245"), null);
    assert.equal(odometroDoTexto("ODOMETRO 98765\nKM 12345"), null, "dois hodometros diferentes: nao escolhe");
});

test("data da nota vale mesmo quando a foto chega no dia seguinte, e valor da nota vence o digitado", () => {
    const db = novoBanco();
    lote(db, ALMIR, "Despesas 30/09/2026\nCentro de custo\nGoinfra G.O\nCRÉDITO C6");
    const [despesa] = foto(db, { bruto: azure([JANTAR]), legenda: "janta 3 pessoas\nValor 80", recebida: "2026-10-01T09:30:00-03:00" }).lidas;
    assert.equal(despesa.campos.data_competencia.valor, "2026-09-30");
    assert.equal(despesa.campos.valor.valor, 85.5);
    assert.ok(despesa.avisos.some((texto) => /vale o da nota/.test(texto)));
    assert.equal(despesa.campos.descricao.valor, "JANTAR - 3 PESSOAS");
    assert.equal(despesa.campos.pessoas.confirmado, true);
});

test("'Qtd 3 janta' no lote nao vira 3 pessoas sem confirmacao", () => {
    const db = novoBanco();
    lote(db, ALMIR, "Despesas 30/09/2026\nCentro de custo\nGoinfra G.O\nCRÉDITO C6\nQtd 3 janta");
    const [despesa] = foto(db, { bruto: azure([JANTAR]) }).lidas;
    assert.equal(despesa.campos.pessoas.confirmado, false);
    assert.equal(despesa.campos.descricao.estimada, true);
    assert.equal(despesa.estado, "AGUARDANDO_REVISAO");
});

test("horario da nota so e pista: refeicao sem lote que confirme vai para revisao", () => {
    const db = novoBanco();
    lote(db, ALMIR, "Despesas 30/09/2026\nCentro de custo\nGoinfra G.O\nCRÉDITO C6\n3 pessoas");
    const [despesa] = foto(db, { bruto: azure([JANTAR]) }).lidas;
    assert.equal(despesa.campos.tipo.valor, "JANTAR");
    assert.equal(despesa.campos.tipo.origem, "horario_da_nota_pista");
    assert.ok(despesa.pendencias.some((texto) => /horário/.test(texto)));
    assert.equal(despesa.campos.data_competencia.valor, "2026-09-30", "a hora nunca entra na data");
});

// --- Contexto -------------------------------------------------------------------

test("cartao do operador divergente da orientacao da Vanessa vai para revisao", () => {
    const db = novoBanco();
    lote(db, VANESSA, "Para o projeto GOINFRA FWD a partir de agora utilizar C6.", "2026-09-29T10:00:00-03:00");
    lote(db, ALMIR, "Despesas 30/09/2026\nCentro de custo\nGOINFRA FWD\nCRÉDITO INTER\n3 pessoas no jantar");
    const [despesa] = foto(db, { bruto: azure([JANTAR]) }).lidas;
    assert.ok(despesa.pendencias.some((texto) => /diverge da orientação da gerência/.test(texto)));
});

test("sem cartao declarado, vale a orientacao da Vanessa para o projeto", () => {
    const db = novoBanco();
    lote(db, VANESSA, "Para o projeto GOINFRA FWD a partir de agora utilizar C6.", "2026-09-29T10:00:00-03:00");
    lote(db, ALMIR, "Despesas 30/09/2026\nGOINFRA FWD\n3 pessoas no jantar");
    const [despesa] = foto(db, { bruto: azure([JANTAR]) }).lidas;
    assert.equal(despesa.campos.pagamento.cartao, "C6");
    assert.equal(despesa.campos.pagamento.origem, "orientacao_da_gerencia");
});

test("instrucao de cartao de quem nao tem autoridade fica registrada mas nao vale", () => {
    const db = novoBanco();
    lote(db, VITOR, "Para o projeto GOINFRA FWD a partir de agora utilizar C6.", "2026-09-29T10:00:00-03:00");
    const evento = db.prepare("SELECT status FROM eventos_contexto WHERE tipo = 'DEFINICAO_CARTAO_POR_PROJETO'").get();
    assert.equal(evento.status, "SEM_AUTORIDADE");
    assert.equal(contexto.politicaCartao(db, "goinfra fwd", "2026-10-01T00:00:00Z"), null);
});

test("cabecalho de um operador nunca vale para as fotos de outro", () => {
    const db = novoBanco();
    lote(db, ALMIR, "Despesas 30/09/2026\nCentro de custo\nGoinfra G.O\nCRÉDITO C6");
    const [despesa] = foto(db, { remetente: VITOR, bruto: azure([JANTAR]) }).lidas;
    assert.equal(despesa.campos.centro_custo.texto_informado, null);
    assert.equal(despesa.campos.pagamento.cartao, null);
});

test("projeto continua valendo nos dias seguintes ate o operador trocar", () => {
    const db = novoBanco();
    lote(db, ALMIR, "Despesas 28/09/2026\nCentro de custo\nGoinfra G.O\nCRÉDITO C6", "2026-09-28T07:00:00-03:00");
    const [despesa] = foto(db, { bruto: azure([JANTAR]), recebida: "2026-10-01T08:00:00-03:00" }).lidas;
    assert.equal(despesa.campos.centro_custo.nome, "GOINFRA FWD");
});

test("abreviacao parcial nao escolhe entre projetos parecidos (FWD x VDROD)", () => {
    const resolucao = cadastros.resolverProjeto(cad, "Goinfra");
    assert.equal(resolucao.status, "AMBIGUO");
    assert.deepEqual(resolucao.candidatos.map((projeto) => projeto.nome_oficial).sort(), ["GOINFRA FWD", "GOINFRA VDROD"]);
    assert.equal(cadastros.resolverProjeto(cad, "projeto antigo").status, "INATIVO");
});

// --- Duplicidade ----------------------------------------------------------------

test("a mesma foto enviada de novo nao gera despesa nova", () => {
    const db = novoBanco();
    foto(db, { sha: "igual", bruto: azure([JANTAR]) });
    const repetida = foto(db, { sha: "igual", bruto: azure([JANTAR]) });
    assert.equal(repetida.repetida, true);
    assert.deepEqual(repetida.despesas, []);
});

test("mesmo comprovante em outra foto (outro angulo) vira suspeita de duplicidade, sem bloquear sozinho", () => {
    const db = novoBanco();
    foto(db, { sha: "a", bruto: azure([JANTAR]) });
    const [segunda] = foto(db, { sha: "b", bruto: azure([JANTAR]) }).lidas;
    assert.equal(segunda.estado, "AGUARDANDO_REVISAO");
    assert.ok(segunda.duplicada_de);
    assert.ok(segunda.pendencias.some((texto) => /Possível duplicidade/.test(texto)));
});

test("cupom fiscal + via da maquininha da mesma compra = uma despesa", () => {
    const via = { texto: "COMPROVANTE DE PAGAMENTO\nVIA CLIENTE\nCREDITO\nVALOR R$ 85,50\nNSU: 123456", fornecedor: "REDE", total: 85.5, data: "2026-09-30" };
    const documentos = dividirDocumentos(azure([JANTAR, via]));
    assert.deepEqual(documentos.map((item) => item.papel), ["PRINCIPAL", "COMPLEMENTAR"]);
    const db = novoBanco();
    assert.equal(foto(db, { bruto: azure([JANTAR, via]) }).lidas.length, 1);
});

test("dois almocos de mesmo valor no mesmo dia sem hora nao sao tratados como certeza de duplicidade", () => {
    const a = impressaoDigital({ cnpj: "11222333000181", data: "2026-09-30", valor: 35, hora: "12:10:00" });
    const b = impressaoDigital({ cnpj: "11222333000181", data: "2026-09-30", valor: 35, hora: "12:40:00" });
    assert.notEqual(a, b);
});

// --- Cadastros ------------------------------------------------------------------

test("pessoa e identificada pelo telefone (com ou sem o 9), nunca so pelo nome exibido", () => {
    assert.equal(cadastros.identificarPessoa(cad, "5511900000001@s.whatsapp.net").pessoa.id, "almir");
    assert.equal(cadastros.identificarPessoa(cad, "551100000001@s.whatsapp.net").pessoa.id, "almir");
    const porNome = cadastros.identificarPessoa(cad, "98765@lid", { nomeExibido: "Almir" });
    assert.equal(porNome.status, "NAO_VINCULADA");
    assert.equal(porNome.sugestao.id, "almir");
});

test("placa lida com I/1 trocado ainda encontra o veiculo da frota", () => {
    assert.equal(cadastros.resolverVeiculo(cad, "JKM-0I96").placa, "JKM0196");
});

test("mercado recorrente usa o nome oficial; nao recorrente usa MERCADO; outros usam o nome lido", () => {
    assert.equal(cadastros.resolverFornecedor(cad, "BELLAVIA SUPERMERCADO LTDA").nome, "BELLAVIA SUPERMERCADO");
    assert.equal(cadastros.resolverFornecedor(cad, "SUPERMERCADO DO ZE").nome, "MERCADO");
    assert.equal(cadastros.resolverFornecedor(cad, "Churrascaria Gaucha").nome, "CHURRASCARIA GAUCHA");
});

// --- Projetos x centros de custo do Conta Azul (respostas de 08/10/2026) -------

function cadComProjetosReais() {
    return {
        ...cadastrosDeTeste(),
        projetos: [
            { nome_oficial: "CTVM-VDRod. DYNA BR020 e 242", centro_conta_azul: "DYNA BR 020 e BR 242", ativo: true, apelidos: [] },
            { nome_oficial: "DESPESAS ADMINISTRATIVAS", centro_conta_azul: "DESPESAS ADMINISTRATIVAS", ativo: true, apelidos: ["Escritório Santa Branca"] },
            { nome_oficial: "DYNA GOINFRA CICLO III - FWD", centro_conta_azul: "DYNA GOINFRA CICLO III - FWD", ativo: false, apelidos: ["GOINFRA FWD"] },
            { nome_oficial: "DYNA GOINFRA CICLO III - VDROD", centro_conta_azul: "DYNA GOINFRA CICLO III - VDROD", ativo: false, apelidos: ["GOINFRA VDROD"] },
        ],
        centros: [
            { nome: "DYNA BR 020 e BR 242", id: "77777777-7777-4777-8777-777777777777" },
            { nome: "DESPESAS ADMINISTRATIVAS", id: "88888888-8888-4888-8888-888888888888" },
        ],
    };
}

test("projeto do sistema acha o ID pelo nome do centro de custo no Conta Azul", () => {
    const c = cadComProjetosReais();
    const porProjeto = cadastros.resolverProjeto(c, "CTVM-VDRod. DYNA BR020 e 242");
    assert.equal(porProjeto.status, "RESOLVIDO");
    assert.equal(porProjeto.projeto.id_conta_azul, "77777777-7777-4777-8777-777777777777");
    assert.equal(cadastros.resolverProjeto(c, "DYNA BR 020 e BR 242").status, "RESOLVIDO");
    // O centro sincronizado nao aparece duplicado como projeto "nao confirmado".
    assert.equal(cadastros.projetosComId(c).filter((p) => p.id_conta_azul === "77777777-7777-4777-8777-777777777777").length, 1);
    assert.equal(cadastros.resolverProjeto(c, "Escritório Santa Branca").projeto.nome_oficial, "DESPESAS ADMINISTRATIVAS");
});

test("'Goinfra G.O' do Almir e o GOINFRA FWD; de outra pessoa nao decide sozinho", () => {
    const c = cadComProjetosReais();
    const almir = { ...pessoa("almir"), apelidos_projeto: { "Goinfra G.O": "DYNA GOINFRA CICLO III - FWD" } };
    const doAlmir = cadastros.resolverProjeto(c, "Goinfra G.O", almir);
    assert.equal(doAlmir.status, "INATIVO");
    assert.equal(doAlmir.projeto.nome_oficial, "DYNA GOINFRA CICLO III - FWD");
    assert.equal(cadastros.resolverProjeto(c, "Goinfra G.O", pessoa("vitor")).projeto, null);
    // Linha solta com projeto inativo continua sendo reconhecida como projeto.
    assert.equal(cadastros.pareceProjeto(c, "Goinfra G.O", pessoa("vitor")), true);
    assert.equal(cadastros.pareceProjeto(c, "Goinfra G.O", almir), true);
});

test("projeto inativo nunca vira centro de custo com ID: vai para revisao", () => {
    const c = cadComProjetosReais();
    const almir = { ...pessoa("almir"), apelidos_projeto: { "Goinfra G.O": "DYNA GOINFRA CICLO III - FWD" } };
    const previa = regras.montarPrevia({
        ocr: { data: "2026-09-30", valor: 85.5, fornecedor: "RESTAURANTE SABOR LTDA", hora: "20:15", confianca: 0.99 },
        legenda: { projeto_texto: "Goinfra G.O", tipos: ["JANTAR"] }, identificacao: { pessoa: almir, origem: "telefone" },
        cad: c, hoje: new Date("2026-10-02T12:00:00Z"),
    });
    assert.equal(previa.campos.centro_custo.nome, "DYNA GOINFRA CICLO III - FWD");
    assert.equal(previa.campos.centro_custo.id, null);
    assert.equal(previa.estado, "AGUARDANDO_REVISAO");
    assert.ok(previa.pendencias.some((p) => p.includes("projeto inativo")));
});

test("abastecimento da moto do Lorran vai para Combustiveis em DESPESAS ADMINISTRATIVAS", () => {
    const c = cadComProjetosReais();
    const lorran = { ...pessoa("lorran"), regras_especiais: [{ tipo: "ABASTECIMENTO_MOTO_PARTICULAR", categoria_nome: "Combustíveis",
        categoria_id: "b2e64f41-0b9c-4608-8e3e-0e0a0080e0a0", centro_custo: "DESPESAS ADMINISTRATIVAS", descricao_anexo: "Abastecimento moto Lorran" }] };
    const previa = regras.montarPrevia({
        ocr: { data: "2026-09-30", valor: 50, fornecedor: "AUTO POSTO BOA VIAGEM", litragem: 8.2, confianca: 0.99, produto_principal: "GASOLINA" },
        legenda: { tipos: ["ABASTECIMENTO"], observacoes: ["moto"], projeto_texto: "CTVM-VDRod. DYNA BR020 e 242" },
        identificacao: { pessoa: lorran, origem: "telefone" }, cad: c, hoje: new Date("2026-10-02T12:00:00Z"),
    });
    assert.equal(previa.campos.categoria.nome, "Combustíveis");
    assert.equal(previa.campos.categoria.id, "b2e64f41-0b9c-4608-8e3e-0e0a0080e0a0");
    assert.equal(previa.campos.centro_custo.nome, "DESPESAS ADMINISTRATIVAS");
    assert.equal(previa.campos.centro_custo.origem, "regra_especial");
    assert.ok(previa.avisos.some((a) => a.includes("prevaleceu sobre o projeto do operador")));
});
