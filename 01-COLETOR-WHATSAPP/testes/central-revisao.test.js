"use strict";

// Central de revisao: correcao humana, aprovacao, treino e metricas.
// Banco sempre em memoria e telefones ficticios.

const test = require("node:test");
const assert = require("node:assert/strict");

const banco = require("../src/central/banco");
const orquestrador = require("../src/central/orquestrador");
const revisao = require("../src/central/revisao");

const GRUPO = "grupo-teste@g.us";
const ALMIR = "5511900000001@s.whatsapp.net";
const DESCONHECIDO = "99999@lid";
const ID_CENTRO = "11111111-1111-4111-8111-111111111111";

function cadastros() {
    return {
        pessoas: [
            { id: "almir", nome: "Almir", telefone: "5511900000001", papel: "OPERADOR", pasta_drive: "Almir" },
            { id: "vitor", nome: "Vitor", telefone: "5512900000002", papel: "OPERADOR", pasta_drive: "Vitor" },
        ],
        projetos: [
            { nome_oficial: "CTVM-VDRod. DYNA BR020 e 242", centro_conta_azul: "DYNA BR 020 e BR 242", id_conta_azul: ID_CENTRO, ativo: true, apelidos: ["BR020"] },
            { nome_oficial: "PROJETO ANTIGO", ativo: false, apelidos: [] },
        ],
        centros: [],
        veiculos: [{ nome: "FIAT SCUDO - SGR4B54", placa: "SGR4B54", categoria_id: "33333333-3333-4333-8333-333333333333", categoria_nome_conta_azul: "FIAT SCUDO - SGR4B54" }],
        cartoes: [{ codigo: "INTER", rotulo: "CRÉDITO INTER", forma_pagamento: "CARTAO_CREDITO", apelidos: ["inter"] }],
        categorias: [{ nome: "JANTAR", nome_conta_azul: "Refeição - Jantar", id: "44444444-4444-4444-8444-444444444444" }],
        fornecedores: { recorrentes: [] },
    };
}

function azure({ texto, fornecedor, total, data, hora }) {
    return { analyzeResult: { content: `${texto}\n`, documents: [{ docType: "receipt", confidence: 0.99, spans: [{ offset: 0, length: texto.length + 1 }],
        fields: { MerchantName: { valueString: fornecedor, confidence: 0.99 }, Total: { type: "currency", valueCurrency: { amount: total }, confidence: 0.99 },
            TransactionDate: { type: "date", valueDate: data, confidence: 0.99 }, TransactionTime: { type: "time", valueTime: hora } } }] } };
}

const JANTAR = azure({ texto: "RESTAURANTE SABOR LTDA\n30/09/2026 20:15\nTOTAL R$ 85,50", fornecedor: "RESTAURANTE SABOR LTDA", total: 85.5, data: "2026-09-30", hora: "20:15:00" });
const POSTO = azure({ texto: "AUTO POSTO BOA VIAGEM\n30/09/2026 07:10\nGASOLINA COMUM 35,43 L\nPLACA: SGR4B54\nKM: 145225", fornecedor: "AUTO POSTO BOA VIAGEM", total: 210, data: "2026-09-30", hora: "07:10:00" });

function cenario({ remetente = ALMIR, legenda = "Jantar 2 pessoas\nBR020\nCrédito Inter", bruto = JANTAR } = {}) {
    const db = banco.abrir(":memory:");
    const cad = cadastros();
    const { despesas } = orquestrador.processarFoto(db, cad, {
        arquivo: `f-${Math.random()}.jpg`, sha256: `h-${Math.random()}`, brutoAzure: bruto, hoje: new Date("2026-10-02T12:00:00Z"),
        meta: { id_mensagem: `m-${Math.random()}`, id_grupo: GRUPO, remetente, legenda, recebido_em_ms: Date.parse("2026-10-01T08:00:00-03:00") },
    });
    return { db, cad, id: despesas[0] };
}

test("previa nasce com a copia original da IA guardada", () => {
    const { db, id } = cenario();
    const despesa = orquestrador.lerDespesa(db, id);
    assert.deepEqual(despesa.campos_originais, despesa.campos);
});

test("correcao exige autor, registra o tipo de erro e marca a origem como humana", () => {
    const { db, cad, id } = cenario();
    assert.throws(() => revisao.corrigir(db, cad, id, [{ campo: "valor", valor: "85,00" }], ""), /quem está revisando/);
    const { despesa, alteradas } = revisao.corrigir(db, cad, id, [{ campo: "valor", valor: "85,00" }], "Yan");
    assert.equal(alteradas, 1);
    assert.equal(despesa.campos.valor.valor, 85);
    assert.equal(despesa.campos.valor.origem, "correcao_humana");
    const [correcao] = db.prepare("SELECT * FROM correcoes WHERE despesa_id = ?").all(id);
    assert.equal(correcao.tipo_erro, "LEITURA");
    assert.equal(correcao.autor, "Yan");
    assert.equal(JSON.parse(correcao.valor_anterior), 85.5);
    // A previa original continua intacta para medir o acerto.
    assert.equal(despesa.campos_originais.valor.valor, 85.5);
});

test("valor igual ao atual nao gera correcao; valor invalido e recusado", () => {
    const { db, cad, id } = cenario();
    assert.equal(revisao.corrigir(db, cad, id, [{ campo: "valor", valor: "85,50" }], "Yan").alteradas, 0);
    assert.throws(() => revisao.corrigir(db, cad, id, [{ campo: "data_competencia", valor: "31/02/20x6" }], "Yan"), /data inválida/);
    assert.throws(() => revisao.corrigir(db, cad, id, [{ campo: "campo_inventado", valor: 1 }], "Yan"), /não editável/);
});

test("corrigir pessoas confirma a quantidade e refaz a descricao do template", () => {
    const { db, cad, id } = cenario();
    const { despesa } = revisao.corrigir(db, cad, id, [{ campo: "pessoas", valor: "3" }], "Yan");
    assert.equal(despesa.campos.pessoas.valor, 3);
    assert.equal(despesa.campos.pessoas.confirmado, true);
    assert.equal(despesa.campos.descricao.valor, "JANTAR - 3 PESSOAS");
});

test("placa corrigida refaz a descricao do abastecimento", () => {
    const { db, cad, id } = cenario({ bruto: POSTO, legenda: "Abastecimento\nBR020\nCrédito Inter" });
    const { despesa } = revisao.corrigir(db, cad, id, [{ campo: "placa", valor: "sgr-4b54" }, { campo: "odometro", valor: "145.230" }], "Yan");
    assert.equal(despesa.campos.abastecimento.placa.valor, "SGR4B54");
    assert.match(despesa.campos.descricao.valor, /od 145\.230 - SGR4B54$/);
});

test("categoria e centro escolhidos na revisao trazem o ID do cadastro", () => {
    const { db, cad, id } = cenario({ legenda: "Jantar 2 pessoas" });
    const { despesa } = revisao.corrigir(db, cad, id, [
        { campo: "centro_custo", valor: "DYNA BR 020 e BR 242" }, { campo: "categoria", valor: "Refeição - Jantar" },
    ], "Yan");
    assert.equal(despesa.campos.centro_custo.id, ID_CENTRO);
    assert.equal(despesa.campos.centro_custo.projeto, "CTVM-VDRod. DYNA BR020 e 242");
    assert.equal(despesa.campos.categoria.id, "44444444-4444-4444-8444-444444444444");
});

test("aprovar cria exemplo de treino validado e nao deixa editar depois", () => {
    const { db, cad, id } = cenario();
    revisao.corrigir(db, cad, id, [{ campo: "pessoas", valor: "2" }], "Yan");
    const aprovada = revisao.aprovar(db, id, "Yan");
    assert.equal(aprovada.estado, "APROVADO");
    const exemplo = db.prepare("SELECT * FROM exemplos_treino WHERE despesa_id = ?").get(id);
    assert.equal(exemplo.aprovado_por, "Yan");
    const rotulos = JSON.parse(exemplo.rotulos);
    assert.equal(rotulos.valor, 85.5);
    assert.equal(rotulos.centro_custo, "DYNA BR 020 e BR 242");
    const entrada = JSON.parse(exemplo.entrada);
    assert.equal(entrada.ocr.fornecedor, "RESTAURANTE SABOR LTDA");
    assert.ok(entrada.previa_da_ia, "entrada guarda a previa da IA, nao so a resposta");
    assert.throws(() => revisao.corrigir(db, cad, id, [{ campo: "valor", valor: "1" }], "Yan"), /reabra/);
});

test("nao aprova sem centro de custo nem categoria", () => {
    const { db, id } = cenario({ legenda: "" });
    assert.throws(() => revisao.aprovar(db, id, "Yan"), /Preencha antes de aprovar: .*Centro de custo/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM exemplos_treino").get().n, 0);
});

test("reabrir ou descartar tira o exemplo do treino", () => {
    const { db, id } = cenario();
    revisao.aprovar(db, id, "Yan");
    revisao.reabrir(db, id, "faltou conferir", "Yan");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM exemplos_treino").get().n, 0);
    revisao.aprovar(db, id, "Yan");
    assert.throws(() => revisao.descartar(db, id, "", "Yan"), /motivo/);
    assert.equal(revisao.descartar(db, id, "não é despesa", "Yan").estado, "DESCARTADO");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM exemplos_treino").get().n, 0);
    const historico = db.prepare("SELECT para FROM historico_estados WHERE despesa_id = ? ORDER BY id").all(id).map((linha) => linha.para);
    assert.deepEqual(historico.slice(-4), ["APROVADO", "AGUARDANDO_REVISAO", "APROVADO", "DESCARTADO"]);
});

test("metricas por campo separam acerto, erro de leitura e de classificacao", () => {
    const { db, cad, id } = cenario();
    revisao.corrigir(db, cad, id, [{ campo: "valor", valor: "80" }, { campo: "fornecedor", valor: "Sabor", tipo_erro: "CLASSIFICACAO" }], "Yan");
    revisao.aprovar(db, id, "Yan");
    const m = revisao.metricas(db);
    assert.equal(m.aprovadas, 1);
    assert.equal(m.aprovadas_sem_correcao, 0);
    assert.equal(m.por_campo.valor.erros_leitura, 1);
    assert.equal(m.por_campo.fornecedor.erros_classificacao, 1);
    assert.equal(m.por_campo.data_competencia.acertos, 1);
    assert.equal(m.por_campo.data_competencia.acuracia, 1);
});

test("vincular remetente desconhecido regera so as previas sem correcao", () => {
    const { db, cad, id } = cenario({ remetente: DESCONHECIDO });
    assert.ok(orquestrador.lerDespesa(db, id).pendencias.some((p) => p.includes("não vinculado")));
    assert.equal(revisao.remetentesNaoVinculados(db).length, 1);
    const { regeradas } = revisao.vincularRemetente(db, cad, DESCONHECIDO, "almir");
    assert.equal(regeradas, 1);
    const depois = orquestrador.lerDespesa(db, id);
    assert.equal(depois.campos.remetente.pessoa_id, "almir");
    assert.ok(!depois.pendencias.some((p) => p.includes("não vinculado")));
    assert.equal(revisao.remetentesNaoVinculados(db).length, 0);
    assert.throws(() => revisao.vincularRemetente(db, cad, DESCONHECIDO, "inventada"), /não cadastrada/);
});

test("previa com correcao humana nao e regerada", () => {
    const { db, cad, id } = cenario();
    revisao.corrigir(db, cad, id, [{ campo: "valor", valor: "80" }], "Yan");
    assert.throws(() => revisao.regenerar(db, cad, id), /correções humanas/);
});

test("listar separa as abas e conta cada uma", () => {
    const { db, id } = cenario();
    // Legenda completa: a previa nasce sem pendencia, na aba "classificadas".
    assert.equal(revisao.listar(db, { aba: "classificadas" }).itens[0].id, id);
    assert.equal(revisao.listar(db, { aba: "revisar" }).itens.length, 0);
    revisao.aprovar(db, id, "Yan");
    const lista = revisao.listar(db, { aba: "aprovadas" });
    assert.equal(lista.itens.length, 1);
    assert.equal(lista.contagem.aprovadas, 1);
    assert.equal(lista.contagem.revisar, 0);
});

test("banco antigo (so migracao 1) ganha as colunas novas sem perder dados", () => {
    const fsTeste = require("fs");
    const os = require("os");
    const path = require("path");
    const { DatabaseSync } = require("node:sqlite");
    const arquivo = path.join(os.tmpdir(), `central-migracao-${process.pid}-${Date.now()}.db`);
    try {
        const antigo = new DatabaseSync(arquivo);
        antigo.exec("CREATE TABLE schema_versao (versao INTEGER NOT NULL); INSERT INTO schema_versao VALUES (1);");
        antigo.exec(banco.MIGRACOES[0]);
        antigo.prepare(`INSERT INTO despesas (estado, campos, pendencias, avisos, criado_em, atualizado_em)
            VALUES ('AGUARDANDO_REVISAO', '{"valor":{"valor":10}}', '[]', '[]', 'x', 'x')`).run();
        antigo.close();
        const db = banco.abrir(arquivo);
        assert.equal(db.prepare("SELECT versao FROM schema_versao").get().versao, banco.MIGRACOES.length);
        assert.equal(orquestrador.lerDespesa(db, 1).campos_originais.valor.valor, 10);
        db.close();
    } finally {
        for (const sufixo of ["", "-wal", "-shm"]) fsTeste.rmSync(arquivo + sufixo, { force: true });
    }
});

test("descricao refeita por causa de outro campo nao conta como erro da descricao", () => {
    const { db, cad, id } = cenario({ bruto: POSTO, legenda: "Abastecimento\nBR020\nCrédito Inter" });
    revisao.corrigir(db, cad, id, [{ campo: "odometro", valor: "145.230" }], "Yan");
    revisao.aprovar(db, id, "Yan");
    const m = revisao.metricas(db);
    assert.equal(m.por_campo.odometro.erros_leitura, 1);
    assert.equal(m.por_campo.descricao, undefined);
});

// --- Sugestao de categoria pelo modelo da planilha ----------------------------

const { criarModelo } = require("../src/aprendizado");
const regrasVmac = require("../src/central/regras-vmac");

function modeloPequeno() {
    const exemplos = [
        ...Array.from({ length: 6 }, () => ({ categoria: "Farmácia", texto: "DROGARIA SAO PAULO dipirona" })),
        ...Array.from({ length: 6 }, () => ({ categoria: "MATERIAL DE CAMPO", texto: "FERRAGENS CENTRAL pilhas capacete" })),
    ];
    return { treinado_em: "2026-10-09", texto_categoria: criarModelo(exemplos, "categoria", "texto", 3) };
}

test("sem regra para a categoria, o modelo so sugere e a despesa continua em revisao", () => {
    const previa = regrasVmac.montarPrevia({
        ocr: { data: "2026-09-30", valor: 20, fornecedor: "DROGARIA SAO PAULO", itens: [{ descricao: "DIPIRONA" }], confianca: 0.99 },
        legenda: { tipos: ["OUTROS"], projeto_texto: "BR020" }, identificacao: { pessoa: { id: "almir", nome: "Almir", pasta_drive: "Almir" }, origem: "telefone" },
        cad: cadastros(), hoje: new Date("2026-10-02T12:00:00Z"), modelo: modeloPequeno(),
    });
    assert.equal(previa.campos.categoria.nome, null, "a sugestao nao vira a categoria sozinha");
    assert.equal(previa.campos.categoria.sugestao.nome, "Farmácia");
    assert.equal(previa.estado, "AGUARDANDO_REVISAO");
    assert.ok(previa.pendencias.some((p) => p.includes('Sugestão: "Farmácia"')));
});

test("sem modelo treinado, nao ha sugestao e nada quebra", () => {
    const previa = regrasVmac.montarPrevia({
        ocr: { data: "2026-09-30", valor: 20, fornecedor: "DROGARIA SAO PAULO", confianca: 0.99 },
        legenda: { tipos: ["OUTROS"] }, identificacao: {}, cad: cadastros(), hoje: new Date("2026-10-02T12:00:00Z"), modelo: null,
    });
    assert.equal(previa.campos.categoria.sugestao, undefined);
});

test("placa fora da frota sugere VEICULO - ALUGADO", () => {
    const previa = regrasVmac.montarPrevia({
        ocr: { data: "2026-09-30", valor: 200, fornecedor: "AUTO POSTO", placa: "ABC1D23", litragem: 30, odometro: 17153, confianca: 0.99 },
        legenda: { tipos: ["ABASTECIMENTO"] }, identificacao: {}, cad: cadastros(), hoje: new Date("2026-10-02T12:00:00Z"), modelo: null,
    });
    assert.equal(previa.campos.categoria.sugestao.nome, "VEICULO - ALUGADO");
    assert.equal(previa.campos.categoria.nome, null);
});

// --- Motivo da correcao: nao informado, outro e explicacao livre --------------

test("campo que so o operador informa e estava vazio: motivo sugerido e 'nao informado'", () => {
    assert.equal(revisao.erroSugerido("pagamento", null), "NAO_INFORMADO");
    assert.equal(revisao.erroSugerido("centro_custo", null), "NAO_INFORMADO");
    assert.equal(revisao.erroSugerido("pagamento", "INTER"), "CLASSIFICACAO", "trocar o cartao informado e outra coisa");
    assert.equal(revisao.erroSugerido("valor", null), "LEITURA");
});

test("correcao guarda o motivo e a explicacao; 'outro' exige explicacao", () => {
    const { db, cad, id } = cenario({ legenda: "Jantar 2 pessoas\nBR020" });
    assert.throws(() => revisao.corrigir(db, cad, id, [{ campo: "pagamento", valor: "INTER", tipo_erro: "OUTRO" }], "Yan"), /escreva qual foi o erro/);
    revisao.corrigir(db, cad, id, [{ campo: "pagamento", valor: "INTER", observacao: "  operador não disse   o cartão " }], "Yan");
    const linha = db.prepare("SELECT tipo_erro, observacao FROM correcoes WHERE despesa_id = ?").get(id);
    assert.equal(linha.tipo_erro, "NAO_INFORMADO");
    assert.equal(linha.observacao, "operador não disse o cartão");
    assert.equal(revisao.detalhar(db, id).correcoes[0].observacao, "operador não disse o cartão");
});

test("'nao informado' nao conta como erro da IA no acerto, e vai para o exemplo de treino", () => {
    const { db, cad, id } = cenario({ legenda: "Jantar 2 pessoas\nBR020" });
    revisao.corrigir(db, cad, id, [{ campo: "pagamento", valor: "INTER", tipo_erro: "NAO_INFORMADO", observacao: "faltou o cartão na mensagem" }], "Yan");
    revisao.aprovar(db, id, "Yan");
    const m = revisao.metricas(db);
    assert.equal(m.por_campo.pagamento.nao_informado, 1);
    assert.equal(m.por_campo.pagamento.erros_classificacao, 0);
    assert.equal(m.por_campo.pagamento.acuracia, null, "sem casos em que a IA podia acertar");
    const entrada = JSON.parse(db.prepare("SELECT entrada FROM exemplos_treino").get().entrada);
    assert.deepEqual(entrada.correcoes_da_revisao, [{ campo: "pagamento", motivo: "NAO_INFORMADO", explicacao: "faltou o cartão na mensagem" }]);
});

// --- Separacao por operador ---------------------------------------------------

function duasPessoas() {
    const db = banco.abrir(":memory:");
    const cad = { ...cadastros(), pessoas: [
        { id: "almir", nome: "Almir", telefone: "5511900000001", papel: "OPERADOR", pasta_drive: "Almir" },
        { id: "vitor", nome: "Vitor", telefone: "5512900000002", papel: "OPERADOR", pasta_drive: "Vitor" },
        { id: "vanessa", nome: "Vanessa", telefone: "5561900000003", papel: "ADMINISTRATIVO", pasta_drive: null },
    ] };
    const foto = (remetente, legenda) => orquestrador.processarFoto(db, cad, {
        arquivo: `f-${Math.random()}.jpg`, sha256: `h-${Math.random()}`, brutoAzure: JANTAR, hoje: new Date("2026-10-02T12:00:00Z"),
        meta: { id_mensagem: `m-${Math.random()}`, id_grupo: GRUPO, remetente, legenda, recebido_em_ms: Date.parse("2026-10-01T08:00:00-03:00") },
    }).despesas[0];
    return { db, cad, almir1: foto(ALMIR, "Jantar 2 pessoas"), almir2: foto(ALMIR, "Jantar 3 pessoas"), desconhecido: foto(DESCONHECIDO, "Jantar") };
}

test("lista filtra pelo operador (a pessoa), com contagem por operador na aba", () => {
    const { db, cad, almir1, almir2, desconhecido } = duasPessoas();
    const todos = revisao.listar(db, { aba: "revisar", cad });
    const contagem = Object.fromEntries(todos.operadores.map((item) => [item.id, item.total]));
    assert.equal(contagem.almir, 2);
    assert.equal(contagem.vitor, 0, "operador do cadastro aparece mesmo sem notas");
    assert.equal(contagem[revisao.SEM_OPERADOR], 1);
    assert.equal(contagem.vanessa, undefined, "quem nao e operador nao vira botao vazio");
    assert.equal(todos.operadores.at(-1).id, revisao.SEM_OPERADOR, "nao identificado fica por ultimo");
    assert.deepEqual(revisao.listar(db, { aba: "revisar", cad, operador: "almir" }).itens.map((i) => i.id).sort(), [almir1, almir2].sort());
    assert.deepEqual(revisao.listar(db, { aba: "revisar", cad, operador: revisao.SEM_OPERADOR }).itens.map((i) => i.id), [desconhecido]);
    // Vinculou o remetente: a nota passa para o operador certo.
    revisao.vincularRemetente(db, cad, DESCONHECIDO, "vitor");
    assert.deepEqual(revisao.listar(db, { aba: "revisar", cad, operador: "vitor" }).itens.map((i) => i.id), [desconhecido]);
});

test("metricas por operador: notas, situacao, acerto e o que faltou informar", () => {
    const { db, cad, almir1, almir2 } = duasPessoas();
    revisao.corrigir(db, cad, almir1, [
        { campo: "pagamento", valor: "INTER", tipo_erro: "NAO_INFORMADO" },
        { campo: "centro_custo", valor: "DYNA BR 020 e BR 242", tipo_erro: "NAO_INFORMADO" },
    ], "Yan");
    revisao.aprovar(db, almir1, "Yan");
    revisao.descartar(db, almir2, "teste", "Yan");
    const almir = revisao.metricas(db, { nomes: revisao.nomesDasPessoas(cad) }).por_operador.find((item) => item.operador === "almir");
    assert.equal(almir.nome, "Almir");
    assert.equal(almir.aprovadas, 1);
    assert.equal(almir.descartadas, 1);
    assert.equal(almir.para_revisar, 0);
    assert.equal(almir.faltou.pagamento, 1);
    assert.equal(almir.faltou.centro_custo, 1);
    assert.ok(almir.acuracia > 0);
});

test("notas do treino com historico ficam na aba Simuladas, fora de Para revisar", () => {
    const real = cenario({ legenda: "Jantar 2 pessoas" });
    const simulada = orquestrador.processarFoto(real.db, real.cad, {
        arquivo: "f-hist.jpg", sha256: "h-hist", brutoAzure: JANTAR, hoje: new Date("2026-10-02T12:00:00Z"),
        meta: { id_mensagem: "historico-1", id_grupo: GRUPO, remetente: "historico:almir", legenda: "Janta 2", recebido_em_ms: Date.parse("2026-10-01T09:00:00-03:00") },
    }).despesas[0];
    const revisar = revisao.listar(real.db, { aba: "revisar", cad: real.cad });
    const simuladas = revisao.listar(real.db, { aba: "simuladas", cad: real.cad });
    assert.ok(!revisar.itens.some((item) => item.id === simulada));
    assert.ok(simuladas.itens.some((item) => item.id === simulada));
    assert.ok(!simuladas.itens.some((item) => item.id === real.id));
    assert.equal(revisar.contagem.simuladas, 1);
});

test("comentario para a IA: salva em qualquer estado e entra no exemplo de treino", () => {
    const { db, cad, id } = cenario();
    revisao.aprovar(db, id, "Yan");
    revisao.comentarParaIa(db, id, "Foto com duas notas: separar uma despesa para cada nota.", "Yan");
    const [comentario] = revisao.comentariosParaIa(db);
    assert.equal(comentario.id, id);
    assert.match(comentario.comentario, /duas notas/);
    const entrada = JSON.parse(db.prepare("SELECT entrada FROM exemplos_treino WHERE despesa_id = ?").get(id).entrada);
    assert.match(entrada.comentario_da_revisao, /duas notas/);
    assert.throws(() => revisao.comentarParaIa(db, id, "x", ""), /quem está comentando/);
});

test("centro digitado na revisao resolve pelo nome, pelo projeto ou por apelido exato", () => {
    const { db, cad, id } = cenario({ legenda: "Jantar 2 pessoas" });
    const { despesa } = revisao.corrigir(db, cad, id, [{ campo: "centro_custo", valor: "br020" }], "Yan");
    assert.equal(despesa.campos.centro_custo.id, ID_CENTRO);
    assert.equal(despesa.campos.centro_custo.projeto, "CTVM-VDRod. DYNA BR020 e 242");
});
