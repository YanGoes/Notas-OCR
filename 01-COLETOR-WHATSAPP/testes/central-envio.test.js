"use strict";

// Envio da Central ao Conta Azul com um cliente FALSO: nada sai da maquina.

const test = require("node:test");
const assert = require("node:assert/strict");

const banco = require("../src/central/banco");
const envio = require("../src/central/envio");

const CONFIG = { central: { envio_conta_azul: { habilitado: true, somente_empresa_id: "999" } } };

const CAMPOS = {
    data_competencia: { valor: "2026-01-11" },
    valor: { valor: 200.54 },
    tipo: { valor: "ALMOCO" },
    fornecedor: { valor: "RESTAURANTES", nome_lido: "SUPER LIDER ALIMENTOS LTDA", cnpj_lido: "07.605.075/0010-36" },
    categoria: { nome: "Refeição - Almoço VMac" },
    descricao: { valor: "ALMOÇO - 4 PESSOAS" },
    centro_custo: { nome: "INFRA - ECOSUL" },
    pagamento: { forma: "CARTAO_CREDITO", rotulo: "CRÉDITO BB" },
    observacao: { valor: null },
    anexo: { descricao: "REEMBOLSO EVERSON" },
};

function criarDespesa(db, estado = "APROVADO", campos = CAMPOS) {
    const t = new Date().toISOString();
    const midia = db.prepare("INSERT INTO midias (sha256, arquivo, recebida_em, registrada_em) VALUES ('x', ?, ?, ?)").run(`f${Math.random()}.jpg`, t, t);
    return Number(db.prepare(`INSERT INTO despesas (midia_id, estado, campos, pendencias, avisos, criado_em, atualizado_em)
        VALUES (?, ?, ?, '[]', '[]', ?, ?)`).run(midia.lastInsertRowid, estado, JSON.stringify(campos), t, t).lastInsertRowid);
}

function apiFalsa({ empresa = "999", ignorarCentro = false, fornecedores = null } = {}) {
    const chamadas = [];
    let criado = null;
    const pessoas = fornecedores || [{ id: "f1", nome: "SUPER LIDER ALIMENTOS LTDA", documento: "07605075001036", ativo: true, perfis: ["Fornecedor"] }];
    return {
        chamadas,
        empresaConectada: async () => ({ id_empresa: empresa, razao_social: "Teste" }),
        listarCategoriasDespesa: async () => [{ id: "cat-almoco", nome: " Refeição - Almoço " }],
        listarCentrosCusto: async () => [{ id: "cc-teste", nome: "TESTE CC" }],
        listarContasFinanceiras: async () => [{ id: "conta1", nome: "Teste", conta_padrao: true }],
        buscarPessoas: async (filtro) => {
            chamadas.push(["pessoas", filtro]);
            if (filtro.documentos) return pessoas.filter((p) => p.documento === filtro.documentos);
            return pessoas.filter((p) => p.nome.includes(filtro.busca));
        },
        criarFornecedor: async (dados) => { chamadas.push(["fornecedor", dados]); return { id: "novo", nome: dados.nome }; },
        criarContaPagarDireta: async (corpo) => {
            chamadas.push(["criar", corpo]);
            criado = corpo;
            return { id: "ev1", observacao: corpo.observacao, condicao_pagamento: { parcelas: [{ id: "p1" }] } };
        },
        obterParcelaFinanceira: async () => ({
            descricao: criado.descricao, metodo_pagamento: criado.condicao_pagamento.parcelas[0].metodo_pagamento,
            conta_financeira: { id: criado.conta_financeira, nome: "Teste" },
            valor_composicao: { valor_bruto: criado.valor },
            evento: { data_competencia: criado.data_competencia, rateio: criado.rateio.map((r) => ({
                id_categoria: r.id_categoria, nome_categoria: "Refeição - Almoço",
                rateio_centro_custo: ignorarCentro ? [] : (r.rateio_centro_custo || []).map((c) => ({ ...c, nome_centro_custo: "TESTE CC" })),
            })) },
        }),
        buscarContasPagar: async () => ({ itens: [{ id: "p1", total: criado.valor, fornecedor: { id: criado.id_fornecedor, nome: "SUPER LIDER ALIMENTOS LTDA" } }] }),
    };
}

test("bloqueia quando a empresa conectada nao e a de teste", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa({ empresa: "123" });
    await assert.rejects(envio.enviar(db, id, { api, config: CONFIG }), /não é a empresa de teste 999/);
    assert.equal(api.chamadas.length, 0);
});

test("bloqueia sem empresa de teste configurada ou com envio desligado", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    await assert.rejects(envio.planejar(db, id, { api: apiFalsa(), config: { central: { envio_conta_azul: { habilitado: true } } } }), /somente_empresa_id/);
    await assert.rejects(envio.planejar(db, id, { api: apiFalsa(), config: {} }), /desligado/);
});

test("so envia despesa aprovada", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db, "AGUARDANDO_REVISAO");
    await assert.rejects(envio.planejar(db, id, { api: apiFalsa(), config: CONFIG }), /só aprovadas/);
});

test("nao inventa fornecedor: sem cadastro no Conta Azul, nao envia", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa({ fornecedores: [] });
    await assert.rejects(envio.enviar(db, id, { api, config: CONFIG }), /Fornecedor não encontrado/);
    assert.ok(!api.chamadas.some((c) => c[0] === "criar"));
});

test("envia com fornecedor pelo CNPJ, confere campo a campo e nao reenvia", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa();
    const r = await envio.enviar(db, id, { api, config: CONFIG });
    assert.equal(r.status, "ENVIADO", envio.relatorioEmTexto(r));
    assert.deepEqual(api.chamadas.find((c) => c[0] === "pessoas")[1], { documentos: "07605075001036" });
    const corpo = api.chamadas.find((c) => c[0] === "criar")[1];
    assert.equal(corpo.id_fornecedor, "f1");
    assert.equal(corpo.observacao, "REEMBOLSO EVERSON");
    assert.equal(corpo.referencia_externa, `central-${id}`);
    assert.deepEqual(corpo.rateio[0].rateio_centro_custo, [{ id_centro_custo: "cc-teste", valor: 200.54 }]);
    assert.equal(corpo.condicao_pagamento.parcelas[0].metodo_pagamento, "CARTAO_CREDITO");
    assert.ok(r.substituicoes.some((s) => s.includes("TESTE CC")));
    assert.match(envio.relatorioEmTexto(r), /– foto anexada/);
    await assert.rejects(envio.enviar(db, id, { api, config: CONFIG }), /já foi enviada/);
});

test("aponta o que nao ficou gravado", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const r = await envio.enviar(db, id, { api: apiFalsa({ ignorarCentro: true }), config: CONFIG });
    assert.equal(r.status, "ENVIADO_INCOMPLETO");
    assert.deepEqual(r.faltou, ["centro de custo"]);
    assert.match(envio.relatorioEmTexto(r), /✗ centro de custo/);
});

test("na conta de teste cadastra o fornecedor que falta: CNPJ + nome lido, ou o generico aprovado", async () => {
    const db = banco.abrir(":memory:");
    const comCnpj = criarDespesa(db);
    const api = apiFalsa({ fornecedores: [] });
    const r = await envio.enviar(db, comCnpj, { api, config: CONFIG, criarFornecedor: true });
    assert.notEqual(r.status, "FALHOU");
    assert.deepEqual(api.chamadas.find((c) => c[0] === "fornecedor")[1], { nome: "SUPER LIDER ALIMENTOS LTDA", documento: "07605075001036" });

    const semCnpj = criarDespesa(db, "APROVADO", { ...CAMPOS, fornecedor: { valor: "RESTAURANTES", nome_lido: "Sua senha" } });
    const api2 = apiFalsa({ fornecedores: [] });
    await envio.enviar(db, semCnpj, { api: api2, config: CONFIG, criarFornecedor: true });
    assert.deepEqual(api2.chamadas.find((c) => c[0] === "fornecedor")[1], { nome: "RESTAURANTES" });
});

test("lista so as aprovadas que ainda nao subiram", async () => {
    const db = banco.abrir(":memory:");
    const a = criarDespesa(db);
    const b = criarDespesa(db);
    criarDespesa(db, "AGUARDANDO_REVISAO");
    await envio.enviar(db, a, { api: apiFalsa(), config: CONFIG });
    assert.deepEqual(envio.pendentesDeEnvio(db, "999"), [b]);
});

test("na conta de teste, material de campo vira a categoria equivalente", () => {
    const m = envio.mapear({ categoria: "MATERIAL DE CAMPO", tipo: "OUTROS" },
        { categorias: [{ id: "x", nome: "Materiais Aplicados na Prestação de Serviços" }, { id: "y", nome: "Despesas a identificar" }], centros: [] }, { teste: true });
    assert.equal(m.categoria.id, "x");
});
