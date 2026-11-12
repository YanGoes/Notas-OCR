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

// Cartoes do teste: o cartao da nota (CRÉDITO BB) aponta para a conta financeira "Teste".
const CARTOES_T = [{ codigo: "BB", rotulo: "CRÉDITO BB", conta_conta_azul: "Teste", conta_conta_azul_id: null }];

function apiFalsa({ empresa = "999", ignorarCentro = false, fornecedores = null, categorias = null, centros = null, contas = null } = {}) {
    const chamadas = [];
    let criado = null;
    const pessoas = fornecedores || [{ id: "f1", nome: "RESTAURANTES", ativo: true, perfis: ["Fornecedor"] },
        { id: "f2", nome: "SUPER LIDER ALIMENTOS LTDA", documento: "07605075001036", ativo: true, perfis: ["Fornecedor"] }];
    return {
        chamadas,
        empresaConectada: async () => ({ id_empresa: empresa, razao_social: "Teste" }),
        listarCategoriasDespesa: async () => categorias || [{ id: "cat-almoco", nome: " Refeição - Almoço VMac " }],
        listarCentrosCusto: async () => centros || [{ id: "cc-ecosul", nome: "INFRA - ECOSUL" }],
        listarContasFinanceiras: async () => contas || [{ id: "conta-padrao", nome: "Caixa", conta_padrao: true }, { id: "conta1", nome: "Teste" }],
        criarCentroCusto: async (dados) => { chamadas.push(["centro", dados]); return { id: "cc-novo", nome: dados.nome }; },
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
                id_categoria: r.id_categoria, nome_categoria: "Refeição - Almoço VMac",
                rateio_centro_custo: ignorarCentro ? [] : (r.rateio_centro_custo || []).map((c) => ({ ...c, nome_centro_custo: "INFRA - ECOSUL" })),
            })) },
        }),
        buscarContasPagar: async () => ({ itens: [{ id: "p1", total: criado.valor, fornecedor: { id: criado.id_fornecedor, nome: "RESTAURANTES" } }] }),
    };
}

test("bloqueia quando a empresa conectada nao e a de teste", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa({ empresa: "123" });
    await assert.rejects(envio.enviar(db, id, { api, config: CONFIG, cartoes: CARTOES_T }), /não é a empresa de teste 999/);
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
    await assert.rejects(envio.planejar(db, id, { api: apiFalsa(), config: CONFIG, cartoes: CARTOES_T }), /só aprovadas/);
});

test("nota sem cartao/conta ou sem categoria nao sobe, nem na conta de teste", async () => {
    const db = banco.abrir(":memory:");
    const api = apiFalsa();
    const semCartao = criarDespesa(db, "APROVADO", { ...CAMPOS, pagamento: { forma: "CARTAO_CREDITO", rotulo: "CARTAO_CREDITO" } });
    await assert.rejects(envio.enviar(db, semCartao, { api, config: CONFIG, cartoes: CARTOES_T }), /não diz de qual cartão ou conta saiu o pagamento/);
    const semCategoria = criarDespesa(db, "APROVADO", { ...CAMPOS, categoria: { nome: null } });
    await assert.rejects(envio.enviar(db, semCategoria, { api, config: CONFIG, cartoes: CARTOES_T }), /sem categoria/);
    const cartaoSemConta = criarDespesa(db);
    await assert.rejects(envio.enviar(db, cartaoSemConta, { api, config: CONFIG, cartoes: [{ codigo: "BB", rotulo: "CRÉDITO BB", conta_conta_azul_id: null }] }), /sem a conta financeira do Conta Azul/);
    assert.ok(!api.chamadas.some((c) => c[0] === "criar"));
});

test("envia o que esta na Central (fornecedor aprovado, categoria, centro, conta do cartao), confere e nao reenvia", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa();
    const r = await envio.enviar(db, id, { api, config: CONFIG, cartoes: CARTOES_T });
    assert.equal(r.status, "ENVIADO", envio.relatorioEmTexto(r));
    // O fornecedor e o APROVADO na Central (RESTAURANTES), nao o do CNPJ lido no cupom.
    assert.deepEqual(api.chamadas.filter((c) => c[0] === "pessoas").map((c) => c[1]), [{ busca: "RESTAURANTES" }]);
    const corpo = api.chamadas.find((c) => c[0] === "criar")[1];
    assert.equal(corpo.id_fornecedor, "f1");
    assert.equal(corpo.conta_financeira, "conta1");
    assert.equal(corpo.rateio[0].id_categoria, "cat-almoco");
    assert.deepEqual(r.cadastros_criados, []);
    assert.equal(corpo.observacao, "REEMBOLSO EVERSON");
    assert.equal("referencia_externa" in corpo, false, "o lançamento não leva código de referência");
    assert.deepEqual(corpo.rateio[0].rateio_centro_custo, [{ id_centro_custo: "cc-ecosul", valor: 200.54 }]);
    assert.equal(corpo.condicao_pagamento.parcelas[0].metodo_pagamento, "CARTAO_CREDITO");
    assert.match(envio.relatorioEmTexto(r), /– foto anexada/);
    await assert.rejects(envio.enviar(db, id, { api, config: CONFIG, cartoes: CARTOES_T }), /já foi enviada/);
});

test("aponta o que nao ficou gravado", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const r = await envio.enviar(db, id, { api: apiFalsa({ ignorarCentro: true }), config: CONFIG, cartoes: CARTOES_T });
    assert.equal(r.status, "ENVIADO_INCOMPLETO");
    assert.deepEqual(r.faltou, ["centro de custo"]);
    assert.match(envio.relatorioEmTexto(r), /✗ centro de custo/);
});

test("na conta de teste, o fornecedor que falta e cadastrado com o nome APROVADO; so sem aprovado vale o CNPJ + nome lido", async () => {
    const db = banco.abrir(":memory:");
    const aprovado = criarDespesa(db);
    const api = apiFalsa({ fornecedores: [] });
    const r = await envio.enviar(db, aprovado, { api, config: CONFIG, cartoes: CARTOES_T });
    assert.equal(r.status, "ENVIADO", envio.relatorioEmTexto(r));
    assert.deepEqual(api.chamadas.find((c) => c[0] === "fornecedor")[1], { nome: "RESTAURANTES" });
    assert.deepEqual(r.cadastros_criados, ['fornecedor "RESTAURANTES" cadastrado(a) na conta de teste']);

    const soCnpj = criarDespesa(db, "APROVADO", { ...CAMPOS, fornecedor: { valor: null, nome_lido: "SUPER LIDER ALIMENTOS LTDA", cnpj_lido: "07.605.075/0010-36" } });
    const api2 = apiFalsa({ fornecedores: [] });
    await envio.enviar(db, soCnpj, { api: api2, config: CONFIG, cartoes: CARTOES_T });
    assert.deepEqual(api2.chamadas.find((c) => c[0] === "fornecedor")[1], { nome: "SUPER LIDER ALIMENTOS LTDA", documento: "07605075001036" });

    // Sem fornecedor aprovado e sem CNPJ: um nome lido solto ("Sua senha") nunca vira fornecedor.
    const lixo = criarDespesa(db, "APROVADO", { ...CAMPOS, fornecedor: { valor: null, nome_lido: "Sua senha" } });
    const api3 = apiFalsa({ fornecedores: [] });
    await assert.rejects(envio.enviar(db, lixo, { api: api3, config: CONFIG, cartoes: CARTOES_T }), /fornecedor "Sua senha" não existe/);
    assert.ok(!api3.chamadas.some((c) => ["fornecedor", "criar"].includes(c[0])));
});

test("lista so as aprovadas que ainda nao subiram", async () => {
    const db = banco.abrir(":memory:");
    const a = criarDespesa(db);
    const b = criarDespesa(db);
    criarDespesa(db, "AGUARDANDO_REVISAO");
    await envio.enviar(db, a, { api: apiFalsa(), config: CONFIG, cartoes: CARTOES_T });
    assert.deepEqual(envio.pendentesDeEnvio(db, "999"), [b]);
});

test("nada e trocado por parecido: categoria e centro so pelo nome exato da Central", () => {
    const m = envio.mapear({ categoria: "MATERIAL DE CAMPO", centro: "DESPESAS ADMINISTRATIVAS" },
        { categorias: [{ id: "x", nome: "Materiais Aplicados na Prestação de Serviços" }, { id: "y", nome: " material de campo " }], centros: [{ id: "t", nome: "TESTE CC" }] });
    assert.equal(m.categoria.id, "y");
    assert.equal(m.centro, null);
});

test("na conta de teste, o cadastro que falta e criado com o MESMO nome da Central antes de lancar", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    // A conta de teste so tem os cadastros de fabrica: nada do que a nota pede existe la.
    const api = apiFalsa({ fornecedores: [], categorias: [{ id: "c0", nome: "Lanches e Refeições" }], centros: [{ id: "t", nome: "TESTE CC" }], contas: [{ id: "k0", nome: "Caixa", conta_padrao: true }] });
    const robo = { chamadas: [], verificar: async () => ({ ok: true }),
        criarCategoriaDespesa: async (nome) => { robo.chamadas.push(["categoria", nome]); return { ok: true, id: "cat-nova", nome }; },
        criarContaFinanceira: async (nome) => { robo.chamadas.push(["conta", nome]); return { ok: true, id: "conta-nova", nome }; } };
    // Plano (sem enviar): mostra o que falta, nao cria nada.
    const plano = await envio.planejar(db, id, { api, config: CONFIG, cartoes: CARTOES_T, robo });
    assert.deepEqual(plano.faltam.map((f) => `${f.tipo}: ${f.nome}`), ["categoria: Refeição - Almoço VMac", "centro de custo: INFRA - ECOSUL", "conta financeira: Teste", "fornecedor: RESTAURANTES"]);
    assert.equal(robo.chamadas.length + api.chamadas.filter((c) => ["centro", "fornecedor"].includes(c[0])).length, 0);
    // Envio: cadastra os quatro e lanca com os IDs novos.
    const r = await envio.enviar(db, id, { api, config: CONFIG, cartoes: CARTOES_T, robo });
    assert.deepEqual(robo.chamadas, [["categoria", "Refeição - Almoço VMac"], ["conta", "Teste"]]);
    assert.deepEqual(api.chamadas.find((c) => c[0] === "centro")[1], { nome: "INFRA - ECOSUL" });
    assert.deepEqual(api.chamadas.find((c) => c[0] === "fornecedor")[1], { nome: "RESTAURANTES" });
    const corpo = api.chamadas.find((c) => c[0] === "criar")[1];
    assert.equal(corpo.rateio[0].id_categoria, "cat-nova");
    assert.deepEqual(corpo.rateio[0].rateio_centro_custo, [{ id_centro_custo: "cc-novo", valor: 200.54 }]);
    assert.equal(corpo.conta_financeira, "conta-nova");
    assert.equal(corpo.id_fornecedor, "novo");
    assert.equal(r.cadastros_criados.length, 4);
    // Robo nao conseguiu cadastrar a categoria: o lancamento nao e criado com outra.
    const outra = criarDespesa(db);
    const api2 = apiFalsa({ categorias: [{ id: "c0", nome: "Lanches e Refeições" }] });
    const roboFalho = { verificar: async () => ({ ok: true }), criarCategoriaDespesa: async () => ({ ok: false, erro: "sessão expirou" }) };
    await assert.rejects(envio.enviar(db, outra, { api: api2, config: CONFIG, cartoes: CARTOES_T, robo: roboFalho }), /Não consegui cadastrar a categoria "Refeição - Almoço VMac"/);
    assert.ok(!api2.chamadas.some((c) => c[0] === "criar"));
});

const CONFIG_LINK = { central: { envio_conta_azul: { habilitado: true, somente_empresa_id: "999", link_da_foto: true } } };
const LINK = "https://drive.google.com/file/d/1Is6u32kmlssT9FdgsiPLhnsMpy9UsKFp/view";

test("com link_da_foto ligado, a observacao leva o link da foto no Drive e ele e conferido", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa();
    const r = await envio.enviar(db, id, { api, config: CONFIG_LINK, cartoes: CARTOES_T, linkDaFoto: () => ({ link: LINK, caminho: "x.jpg" }) });
    assert.equal(r.status, "ENVIADO", envio.relatorioEmTexto(r));
    assert.equal(api.chamadas.find((c) => c[0] === "criar")[1].observacao, `REEMBOLSO EVERSON | Foto: ${LINK}`);
    assert.equal(r.foto_drive, LINK);
    assert.match(envio.relatorioEmTexto(r), /✓ link da foto/);
    assert.doesNotMatch(envio.relatorioEmTexto(r), /foto anexada/);
});

test("com link_da_foto ligado, nota com foto sem link no Drive nao sobe", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa();
    await assert.rejects(envio.enviar(db, id, { api, config: CONFIG_LINK, cartoes: CARTOES_T, linkDaFoto: () => ({ link: null, motivo: "a foto ainda não foi copiada para o Drive" }) }),
        /sem o link da foto no Drive \(a foto ainda não foi copiada/);
    assert.ok(!api.chamadas.some((c) => c[0] === "criar"));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM envios_conta_azul").get().n, 0);
});

test("espera o Drive terminar de enviar a foto antes de desistir", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    let leituras = 0;
    const linkDaFoto = () => { leituras += 1; return leituras < 2 ? { link: null, aguardar: true, motivo: "o Google Drive ainda não terminou de enviar a foto" } : { link: LINK }; };
    const plano = await envio.planejar(db, id, { api: apiFalsa(), config: CONFIG_LINK, cartoes: CARTOES_T, linkDaFoto, esperaLinkMs: 5000 });
    assert.equal(plano.foto_drive.link, LINK);
    assert.equal(leituras, 2);
    // Sem tempo de espera, desiste na hora.
    await assert.rejects(envio.planejar(db, id, { api: apiFalsa(), config: CONFIG_LINK, cartoes: CARTOES_T, linkDaFoto: () => ({ link: null, aguardar: true, motivo: "enviando" }) }), /sem o link da foto/);
});

test("nota sem comprovante sobe sem link, mesmo com link_da_foto ligado", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db, "APROVADO", { ...CAMPOS, sem_comprovante: { valor: true } });
    const api = apiFalsa();
    const r = await envio.enviar(db, id, { api, config: CONFIG_LINK, cartoes: CARTOES_T, linkDaFoto: () => { throw new Error("não deveria procurar a foto"); } });
    assert.equal(r.status, "ENVIADO", envio.relatorioEmTexto(r));
    assert.equal(api.chamadas.find((c) => c[0] === "criar")[1].observacao, "REEMBOLSO EVERSON");
});

// ---- Robo de tela: link na aba Anexo --------------------------------------
const CONFIG_ANEXO = { central: { envio_conta_azul: { habilitado: true, somente_empresa_id: "999", link_da_foto: "anexo" } } };

function roboFalso({ sessao = true, grava = true } = {}) {
    const chamadas = [];
    return {
        chamadas,
        verificar: async () => { chamadas.push(["verificar"]); if (!sessao) throw new Error("Robô sem login no Conta Azul"); return { ok: true }; },
        anexarLink: async (eventoId, dados) => { chamadas.push(["anexar", eventoId, dados]); return grava ? { ok: true, anexo_id: "ax1" } : { ok: false, erro: "sessão expirou" }; },
        fechar: () => {},
    };
}

test("modo anexo: o link vai para a aba Anexo pelo robo e NAO vai na observacao", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa();
    const robo = roboFalso();
    const r = await envio.enviar(db, id, { api, config: CONFIG_ANEXO, cartoes: CARTOES_T, robo, linkDaFoto: () => ({ link: LINK }) });
    assert.equal(r.status, "ENVIADO", envio.relatorioEmTexto(r));
    assert.equal(api.chamadas.find((c) => c[0] === "criar")[1].observacao, "REEMBOLSO EVERSON");
    assert.deepEqual(robo.chamadas.find((c) => c[0] === "anexar"), ["anexar", "ev1", { url: LINK, descricao: "REEMBOLSO EVERSON", valor: 200.54 }]);
    assert.match(envio.relatorioEmTexto(r), /✓ anexo da foto/);
    assert.equal(r.anexo.anexo_id, "ax1");
});

test("modo anexo: robo sem sessao no site nao cria o lancamento", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa();
    await assert.rejects(envio.enviar(db, id, { api, config: CONFIG_ANEXO, cartoes: CARTOES_T, robo: roboFalso({ sessao: false }), linkDaFoto: () => ({ link: LINK }) }), /Robô sem login/);
    assert.ok(!api.chamadas.some((c) => c[0] === "criar"));
});

test("modo anexo: se o robo falhar depois de criar, fica incompleto e a nova tentativa completa", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const r = await envio.enviar(db, id, { api: apiFalsa(), config: CONFIG_ANEXO, cartoes: CARTOES_T, robo: roboFalso({ grava: false }), linkDaFoto: () => ({ link: LINK }) });
    assert.equal(r.status, "ENVIADO_INCOMPLETO");
    assert.deepEqual(r.faltou, ["anexo da foto"]);
    const robo = roboFalso();
    const de_novo = await envio.anexarPendentes(db, { robo, config: CONFIG_ANEXO, cartoes: CARTOES_T });
    assert.deepEqual(de_novo, [{ despesa_id: id, ok: true, ja_tinha: false, erro: null }]);
    assert.equal(robo.chamadas.find((c) => c[0] === "anexar")[1], "ev1");
    assert.equal(db.prepare("SELECT status FROM envios_conta_azul WHERE despesa_id = ?").get(id).status, "ENVIADO");
    // Nada mais pendente: nao chama o robo de novo.
    const robo2 = roboFalso();
    assert.deepEqual(await envio.anexarPendentes(db, { robo: robo2, config: CONFIG_ANEXO, cartoes: CARTOES_T }), []);
    assert.ok(!robo2.chamadas.some((c) => c[0] === "anexar"));
});

test("modo ambos e nota sem comprovante", async () => {
    const db = banco.abrir(":memory:");
    const ambos = { central: { envio_conta_azul: { habilitado: true, somente_empresa_id: "999", link_da_foto: "ambos" } } };
    const api = apiFalsa();
    const robo = roboFalso();
    const r = await envio.enviar(db, criarDespesa(db), { api, config: ambos, cartoes: CARTOES_T, robo, linkDaFoto: () => ({ link: LINK }) });
    assert.equal(r.status, "ENVIADO", envio.relatorioEmTexto(r));
    assert.equal(api.chamadas.find((c) => c[0] === "criar")[1].observacao, `REEMBOLSO EVERSON | Foto: ${LINK}`);
    assert.ok(robo.chamadas.some((c) => c[0] === "anexar"));
    // Nota sem comprovante: nao ha foto, o robo nem e consultado.
    const robo2 = roboFalso({ sessao: false });
    const semFoto = criarDespesa(db, "APROVADO", { ...CAMPOS, sem_comprovante: { valor: true } });
    const r2 = await envio.enviar(db, semFoto, { api: apiFalsa(), config: CONFIG_ANEXO, cartoes: CARTOES_T, robo: robo2 });
    assert.equal(r2.status, "ENVIADO", envio.relatorioEmTexto(r2));
    assert.equal(robo2.chamadas.length, 0);
    const modo = (regra) => envio.modoDaFoto({ central: { envio_conta_azul: regra } });
    assert.deepEqual(modo({ link_da_foto: true }), { arquivo: false, link: false, observacao: true });
    assert.deepEqual(modo({ link_da_foto: "anexo" }), { arquivo: false, link: true, observacao: false });
    assert.deepEqual(modo({ anexo_da_foto: "arquivo" }), { arquivo: true, link: false, observacao: false });
    assert.deepEqual(modo({ anexo_da_foto: "link" }), { arquivo: false, link: true, observacao: false });
    assert.deepEqual(modo({}), { arquivo: false, link: false, observacao: false });
});

// ---- Imagem da nota como anexo (sem link) e envio por conta ----------------
const CONFIG_ARQUIVO = { central: { envio_conta_azul: { habilitado: true, somente_empresa_id: "999", anexo_da_foto: "arquivo" } } };
const FOTO = "C:\\fotos\\nota.jpg";

function roboDeArquivo({ grava = true, empresa = "999" } = {}) {
    const chamadas = [];
    return {
        chamadas,
        verificar: async ({ empresaId } = {}) => {
            chamadas.push(["verificar", empresaId]);
            if (empresaId && empresaId !== empresa) throw new Error(`A janela do robô está logada na empresa ${empresa}, e o envio é para a empresa ${empresaId}.`);
            return { ok: true };
        },
        anexarArquivo: async (eventoId, dados) => { chamadas.push(["arquivo", eventoId, dados]); return grava ? { tipo: "arquivo", nome: dados.nome, ok: true, anexo_id: "ax9" } : { tipo: "arquivo", nome: dados.nome, ok: false, erro: "sessão expirou" }; },
        anexarLink: async () => { throw new Error("não deveria gravar link"); },
        fechar: () => {},
    };
}

test("modo arquivo: a IMAGEM vai para a aba Anexo, sem link em lugar nenhum e sem depender do Drive", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa();
    const robo = roboDeArquivo();
    const r = await envio.enviar(db, id, { api, config: CONFIG_ARQUIVO, cartoes: CARTOES_T, robo, localizar: () => FOTO, linkDaFoto: () => { throw new Error("não deveria procurar o link"); } });
    assert.equal(r.status, "ENVIADO", envio.relatorioEmTexto(r));
    assert.equal(api.chamadas.find((c) => c[0] === "criar")[1].observacao, "REEMBOLSO EVERSON");
    assert.deepEqual(robo.chamadas[0], ["verificar", "999"]);
    assert.deepEqual(robo.chamadas.find((c) => c[0] === "arquivo"),
        ["arquivo", "ev1", { arquivo: FOTO, nome: `#${id} ALMOCO R$ 200,54.jpg`, descricao: "REEMBOLSO EVERSON", valor: 200.54 }]);
    assert.equal(r.foto_drive, null);
    assert.equal(r.conta, "teste");
    assert.match(envio.relatorioEmTexto(r), /✓ foto anexada ao lançamento \(robô de tela\)/);
    assert.match(envio.relatorioEmTexto(r), /✓ anexo da foto: enviado "#\d+ ALMOCO R\$ 200,54\.jpg".*imagem na aba Anexo/);
});

test("modo arquivo: sem a foto no programa, ou com o robo em outra empresa, nada e criado", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiFalsa();
    await assert.rejects(envio.enviar(db, id, { api, config: CONFIG_ARQUIVO, cartoes: CARTOES_T, robo: roboDeArquivo(), localizar: () => null }), /a foto da nota não está mais no programa/);
    await assert.rejects(envio.enviar(db, id, { api, config: CONFIG_ARQUIVO, cartoes: CARTOES_T, robo: roboDeArquivo({ empresa: "555" }), localizar: () => FOTO }), /logada na empresa 555/);
    assert.ok(!api.chamadas.some((c) => c[0] === "criar"));
});

test("modo arquivo: falha do robo deixa incompleto e a nova tentativa anexa a imagem", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const r = await envio.enviar(db, id, { api: apiFalsa(), config: CONFIG_ARQUIVO, cartoes: CARTOES_T, robo: roboDeArquivo({ grava: false }), localizar: () => FOTO });
    assert.equal(r.status, "ENVIADO_INCOMPLETO");
    assert.deepEqual(r.faltou, ["anexo da foto"]);
    const robo = roboDeArquivo();
    assert.deepEqual(await envio.anexarPendentes(db, { robo, config: CONFIG_ARQUIVO, cartoes: CARTOES_T, localizar: () => FOTO }), [{ despesa_id: id, ok: true, ja_tinha: false, erro: null }]);
    assert.equal(robo.chamadas.find((c) => c[0] === "arquivo")[2].nome, `#${id} ALMOCO R$ 200,54.jpg`);
    assert.equal(db.prepare("SELECT status FROM envios_conta_azul WHERE despesa_id = ?").get(id).status, "ENVIADO");
});

// ---- Conta oficial ---------------------------------------------------------
const OFICIAL = { habilitado: true, empresa_id: "777" };
const CONFIG_OFICIAL = { central: { envio_conta_azul: { habilitado: true, somente_empresa_id: "999", anexo_da_foto: "arquivo", oficial: OFICIAL } } };
const CARTOES = [{ codigo: "BB", rotulo: "CRÉDITO BB", conta_conta_azul_id: "conta-bb" }];

function apiOficial({ centros = [{ id: "cc-ecosul", nome: "INFRA - ECOSUL" }], categorias = [{ id: "cat-vmac", nome: "Refeição - Almoço VMac" }] } = {}) {
    const api = apiFalsa({ empresa: "777" });
    return { ...api, listarCategoriasDespesa: async () => categorias, listarCentrosCusto: async () => centros,
        listarContasFinanceiras: async () => [{ id: "conta-padrao", nome: "Caixa", conta_padrao: true }, { id: "conta-bb", nome: "Banco do Brasil" }] };
}

test("conta oficial: so depois de liberada no config, e so para a empresa gravada la", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const semLiberar = { central: { envio_conta_azul: { habilitado: true, somente_empresa_id: "999" } } };
    await assert.rejects(envio.planejar(db, id, { api: apiOficial(), config: semLiberar, conta: "oficial" }), /conta OFICIAL ainda não foi liberado.*Empresa conectada: 777/);
    const outra = { central: { envio_conta_azul: { habilitado: true, oficial: { habilitado: true, empresa_id: "123" } } } };
    await assert.rejects(envio.planejar(db, id, { api: apiOficial(), config: outra, conta: "oficial" }), /não é a empresa oficial liberada \(123\)/);
    // A conta de teste continua presa na empresa de teste, mesmo com a oficial liberada.
    await assert.rejects(envio.planejar(db, id, { api: apiOficial(), config: CONFIG_OFICIAL, conta: "teste" }), /não é a empresa de teste 999/);
    await assert.rejects(envio.planejar(db, id, { api: apiOficial(), config: CONFIG_OFICIAL, conta: "outra" }), /Conta inválida/);
});

test("conta oficial: usa os nomes reais, a conta financeira do cartao e nunca cadastra fornecedor", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const api = apiOficial();
    const robo = roboDeArquivo({ empresa: "777" });
    const r = await envio.enviar(db, id, { api, config: CONFIG_OFICIAL, conta: "oficial", cartoes: CARTOES, robo, localizar: () => FOTO, criarFornecedor: true });
    assert.equal(r.status, "ENVIADO", envio.relatorioEmTexto(r));
    assert.equal(r.conta, "oficial");
    assert.deepEqual(r.cadastros_criados, []);
    const corpo = api.chamadas.find((c) => c[0] === "criar")[1];
    assert.equal(corpo.conta_financeira, "conta-bb");
    assert.equal(corpo.rateio[0].id_categoria, "cat-vmac");
    assert.deepEqual(corpo.rateio[0].rateio_centro_custo, [{ id_centro_custo: "cc-ecosul", valor: 200.54 }]);
    assert.deepEqual(robo.chamadas[0], ["verificar", "777"]);
    assert.equal(db.prepare("SELECT empresa_id FROM envios_conta_azul WHERE despesa_id = ?").get(id).empresa_id, "777");
});

test("conta oficial: nada e trocado nem inventado (categoria, centro, cartao, fornecedor)", async () => {
    const db = banco.abrir(":memory:");
    const id = criarDespesa(db);
    const opcoes = { config: CONFIG_OFICIAL, conta: "oficial", cartoes: CARTOES, robo: roboDeArquivo({ empresa: "777" }), localizar: () => FOTO };
    await assert.rejects(envio.planejar(db, id, { ...opcoes, api: apiOficial({ categorias: [{ id: "x", nome: "Refeição - Almoço" }] }) }), /categoria "Refeição - Almoço VMac" não existe\(m\) no Conta Azul \(conta oficial\)/);
    await assert.rejects(envio.planejar(db, id, { ...opcoes, api: apiOficial({ centros: [{ id: "cc", nome: "TESTE CC" }] }) }), /centro de custo "INFRA - ECOSUL" não existe/);
    await assert.rejects(envio.planejar(db, id, { ...opcoes, api: apiOficial(), cartoes: [{ codigo: "BB", rotulo: "CRÉDITO BB", conta_conta_azul_id: null }] }), /sem a conta financeira do Conta Azul/);
    const semFornecedor = { ...apiOficial(), buscarPessoas: async () => [] };
    await assert.rejects(envio.planejar(db, id, { ...opcoes, api: semFornecedor }), /fornecedor "RESTAURANTES" não existe/);
    // Conta financeira pelo NOME do cartao, quando o ID nao esta preenchido; se nao existir na oficial, nao sobe.
    const porNome = await envio.planejar(db, id, { ...opcoes, api: apiOficial(), cartoes: [{ codigo: "BB", rotulo: "CRÉDITO BB", conta_conta_azul: "banco do brasil" }] });
    assert.equal(porNome.conta.id, "conta-bb");
    await assert.rejects(envio.planejar(db, id, { ...opcoes, api: apiOficial(), cartoes: [{ codigo: "BB", rotulo: "CRÉDITO BB", conta_conta_azul: "Inter - Conta Corrente" }] }), /conta financeira "Inter - Conta Corrente" não existe/);
    assert.ok(!semFornecedor.chamadas.some((c) => ["fornecedor", "centro", "criar"].includes(c[0])));
});

test("lote: confere o robo antes, envia uma a uma e resume; o erro de uma nota nao para as outras", async () => {
    const db = banco.abrir(":memory:");
    const boa = criarDespesa(db);
    const emRevisao = criarDespesa(db, "AGUARDANDO_REVISAO");
    const api = apiFalsa();
    const robo = roboDeArquivo();
    const r = await envio.enviarLote(db, [boa, emRevisao], { api, config: CONFIG_ARQUIVO, cartoes: CARTOES_T, conta: "teste", autor: "yan", robo, localizar: () => FOTO, pausaMs: 0 });
    assert.equal(r.conta, "teste");
    assert.equal(r.empresa.id, "999");
    assert.deepEqual(r.resumo, { completas: 1, incompletas: 0, incertas: 0, nao_enviadas: 1 });
    assert.equal(r.resultados[0].status, "ENVIADO");
    assert.match(r.resultados[1].erro, /só aprovadas/);
    assert.equal(db.prepare("SELECT autor FROM envios_conta_azul WHERE despesa_id = ?").get(boa).autor, "yan");
    // Robo fora (outra empresa): o lote inteiro para antes de criar qualquer coisa.
    const api2 = apiFalsa();
    await assert.rejects(envio.enviarLote(db, [criarDespesa(db)], { api: api2, config: CONFIG_ARQUIVO, cartoes: CARTOES_T, robo: roboDeArquivo({ empresa: "555" }), localizar: () => FOTO, pausaMs: 0 }), /logada na empresa 555/);
    assert.ok(!api2.chamadas.some((c) => c[0] === "criar"));
});
