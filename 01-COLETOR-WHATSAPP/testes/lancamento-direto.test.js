"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");
const contaAzul = require("../src/conta-azul");
const { lancarDespesa, montarPayload, impedimentosParaLancar } = require("../src/lancamento-direto");

const PASTA_AUDITORIA = path.join(RAIZ, "dados", "auditoria");
const CATEGORIA = "5bd50b47-4409-4157-b631-98a24f26148a";
const CENTRO = "43a40a34-8f89-11f1-8cae-0b3dbe3e2005";

function auditoria(extra = {}) {
    return {
        arquivo_imagem: "nota.jpg",
        ocr: { fornecedor: "AUTO POSTO SANTA BRANCA", valor: 100.05, data: "2026-01-05", cnpj: "65954984000195" },
        classificacao: { tipo: "combustivel", categoria_nome: "COMBUSTIVEL", categoria_id: CATEGORIA, centro_custo_nome: "CONSOL MG-050", centro_custo_id: CENTRO },
        forma_pagamento: { codigo: "DINHEIRO" },
        validacoes: { bloqueado: false, revisao_necessaria: false, motivos: [] },
        conta_azul: { descricao_sugerida: "Abastecimento CONSOL MG-050 | Placa JKM-0196" },
        ...extra,
    };
}

function escrever(base, dados) {
    fs.mkdirSync(PASTA_AUDITORIA, { recursive: true });
    fs.writeFileSync(path.join(PASTA_AUDITORIA, `${base}.json`), JSON.stringify(dados, null, 2), "utf8");
}
function limpar(base) {
    fs.rmSync(path.join(PASTA_AUDITORIA, `${base}.json`), { force: true });
}

async function comMocks(mocks, fn) {
    const originais = {};
    for (const chave of Object.keys(mocks)) originais[chave] = contaAzul[chave];
    Object.assign(contaAzul, mocks);
    try { return await fn(); } finally { Object.assign(contaAzul, originais); }
}

const semLog = () => {};

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

test("payload leva categoria e centro de custo, no formato confirmado da API", () => {
    const p = montarPayload(auditoria());
    assert.equal(p.valor, 100.05);
    assert.equal(p.data_competencia, "2026-01-05");
    assert.equal(p.rateio[0].id_categoria, CATEGORIA);
    assert.equal(p.rateio[0].rateio_centro_custo[0].id_centro_custo, CENTRO, "centro vai DENTRO do rateio, como lista");
    assert.equal(p.condicao_pagamento.parcelas[0].detalhe_valor.valor_bruto, 100.05, "composicao chama detalhe_valor");
    assert.equal(p.condicao_pagamento.parcelas[0].metodo_pagamento, "DINHEIRO");
    assert.match(p.descricao, /Abastecimento/);
    // A listagem do Conta Azul mostra a descricao da parcela, entao ela nao pode
    // ser "Parcela 1/1" — precisa repetir a descricao real da despesa.
    assert.equal(p.condicao_pagamento.parcelas[0].descricao, p.descricao);
});

// ---------------------------------------------------------------------------
// Travas antes de criar
// ---------------------------------------------------------------------------

test("recusa lancar sem categoria ou sem centro de custo", () => {
    assert.match(impedimentosParaLancar(auditoria({
        classificacao: { categoria_id: null, centro_custo_id: CENTRO },
    })).join(" "), /Categoria sem UUID/);

    assert.match(impedimentosParaLancar(auditoria({
        classificacao: { categoria_id: CATEGORIA, centro_custo_id: "PREENCHER_UUID_CONTA_AZUL" },
    })).join(" "), /Centro de custo sem UUID/);
});

test("recusa lancar documento bloqueado, sem valor ou sem data", () => {
    assert.match(impedimentosParaLancar(auditoria({
        validacoes: { bloqueado: true, motivos: ["Possivel documento duplicado."] },
    })).join(" "), /bloqueado/i);
    assert.match(impedimentosParaLancar(auditoria({ ocr: { valor: 0, data: "2026-01-05" } })).join(" "), /Valor/);
    assert.match(impedimentosParaLancar(auditoria({ ocr: { valor: 10, data: null } })).join(" "), /Data/);
});

test("recusa lancar a mesma nota duas vezes", () => {
    const impedimentos = impedimentosParaLancar(auditoria({
        lancamento_direto: { status: "CRIADO", lancamento_id: "evento-1" },
    }));
    assert.match(impedimentos.join(" "), /ja foi lancada/i);
});

// ---------------------------------------------------------------------------
// Criacao
// ---------------------------------------------------------------------------

test("simulacao nao envia nada ao Conta Azul", async () => {
    const base = `teste_lanc_sim_${Date.now()}`;
    escrever(base, auditoria());
    try {
        let chamou = false;
        await comMocks({ criarContaPagar: async () => { chamou = true; return {}; } }, async () => {
            const r = await lancarDespesa(base, { dryRun: true, log: semLog });
            assert.equal(r.simulado, true);
            assert.equal(r.criado, false);
            assert.ok(r.payload, "mostra o payload que seria enviado");
        });
        assert.equal(chamou, false);
    } finally { limpar(base); }
});

test("cria a despesa e confirma consultando o Conta Azul", async () => {
    const base = `teste_lanc_ok_${Date.now()}`;
    escrever(base, auditoria());
    try {
        let buscas = 0;
        let enviado = null;
        await comMocks({
            buscarContasPagar: async () => { buscas += 1; return { itens: buscas === 1 ? [] : [{ id: "evento-99" }] }; },
            criarContaPagar: async (corpo) => { enviado = corpo; return { protocolo: "prot-1", status: "PENDING" }; },
        }, async () => {
            const r = await lancarDespesa(base, { dryRun: false, log: semLog });
            assert.equal(r.criado, true);
            assert.equal(r.lancamento_id, "evento-99");
            assert.equal(r.protocolo, "prot-1");
        });
        assert.equal(enviado.rateio[0].rateio_centro_custo[0].id_centro_custo, CENTRO);

        const gravado = JSON.parse(fs.readFileSync(path.join(PASTA_AUDITORIA, `${base}.json`), "utf8"));
        assert.equal(gravado.lancamento_direto.status, "CRIADO");
        assert.equal(gravado.lancamento_direto.lancamento_id, "evento-99");
    } finally { limpar(base); }
});

test("nao cria quando ja existe lancamento igual no Conta Azul", async () => {
    const base = `teste_lanc_dup_${Date.now()}`;
    escrever(base, auditoria());
    try {
        let criou = false;
        await comMocks({
            buscarContasPagar: async () => ({ itens: [{ id: "evento-ja-existe" }] }),
            criarContaPagar: async () => { criou = true; return {}; },
        }, async () => {
            const r = await lancarDespesa(base, { dryRun: false, log: semLog });
            assert.equal(r.criado, false);
            assert.equal(r.duplicado, true);
            assert.match(r.erro, /Ja existe lancamento/i);
        });
        assert.equal(criou, false, "nunca pode criar duplicado");
    } finally { limpar(base); }
});

test("nao cria quando nao consegue nem consultar o Conta Azul", async () => {
    const base = `teste_lanc_off_${Date.now()}`;
    escrever(base, auditoria());
    try {
        let criou = false;
        await comMocks({
            buscarContasPagar: async () => { throw new Error("Conta Azul 500: indisponivel"); },
            criarContaPagar: async () => { criou = true; return {}; },
        }, async () => {
            const r = await lancarDespesa(base, { dryRun: false, log: semLog });
            assert.equal(r.criado, false);
            assert.match(r.erro, /checar duplicidade/i);
        });
        assert.equal(criou, false, "sem conseguir checar duplicidade, nao arrisca criar");
    } finally { limpar(base); }
});

test("se a API recusar metodo_pagamento, cria sem ele em vez de falhar", async () => {
    const base = `teste_lanc_metodo_${Date.now()}`;
    escrever(base, auditoria());
    try {
        const enviados = [];
        let buscas = 0;
        await comMocks({
            buscarContasPagar: async () => { buscas += 1; return { itens: buscas === 1 ? [] : [{ id: "evento-77" }] }; },
            criarContaPagar: async (corpo) => {
                enviados.push(corpo);
                if (corpo.condicao_pagamento.parcelas[0].metodo_pagamento) {
                    throw new Error("Conta Azul 400: metodo_pagamento nao aceito na criacao");
                }
                return { protocolo: "prot-2", status: "PENDING" };
            },
        }, async () => {
            const r = await lancarDespesa(base, { dryRun: false, log: semLog });
            assert.equal(r.criado, true);
            assert.equal(r.metodo_pagamento_aplicado, false);
        });
        // A API recusou as variacoes que levavam metodo_pagamento; venceu a primeira sem ele.
        assert.ok(enviados.length >= 2, "tentou variacoes menores do payload");
        const aceito = enviados[enviados.length - 1];
        assert.equal(aceito.condicao_pagamento.parcelas[0].metodo_pagamento, undefined);
        assert.equal(aceito.rateio[0].id_categoria, CATEGORIA, "categoria nunca sai do payload");
        assert.equal(aceito.rateio[0].rateio_centro_custo[0].id_centro_custo, CENTRO, "centro de custo nunca sai do payload");
    } finally { limpar(base); }
});

test("avisa quando o Conta Azul aceita o pedido mas o lancamento nao aparece", async () => {
    const base = `teste_lanc_incerto_${Date.now()}`;
    escrever(base, auditoria());
    try {
        await comMocks({
            buscarContasPagar: async () => ({ itens: [] }),
            criarContaPagar: async () => ({ protocolo: "prot-3", status: "PENDING" }),
        }, async () => {
            const r = await lancarDespesa(base, { dryRun: false, log: semLog });
            assert.equal(r.criado, false);
            assert.match(r.erro, /ainda nao aparece na busca/i);
            assert.match(r.erro, /nao duplicar/i);
        });
    } finally { limpar(base); }
});

test("observacao carrega a rastreabilidade que a API nao guarda em outro lugar", () => {
    const p = montarPayload(auditoria({
        ocr: {
            fornecedor: "AUTO POSTO SANTA BRANCA", cnpj: "65954984000195", valor: 100.05, data: "2026-01-05",
            chave_fiscal: "35260165954984000195650010000061341663815932",
        },
        dados_abastecimento: { placa: "JKM-0196", litragem: 16.429, unidade: "L", combustivel: "GASOLINA COMUM" },
        rastreabilidade: { sha256: "a1b2c3d4e5f6a7b8c9d0" },
    }));
    // Como o lancamento nasce sem fornecedor e sem anexo, a observacao precisa
    // permitir achar a nota original depois.
    assert.match(p.observacao, /Fornecedor: AUTO POSTO SANTA BRANCA/);
    assert.match(p.observacao, /CNPJ: 65954984000195/);
    assert.match(p.observacao, /Placa: JKM-0196/);
    assert.match(p.observacao, /Chave NFC-e: 3526/);
    assert.match(p.observacao, /Comprovante: nota\.jpg/);
    assert.ok(p.observacao.length <= 1000, "respeita o limite do campo");
});

test("se a API recusar a observacao, cria sem ela mantendo categoria e centro", async () => {
    const base = `teste_lanc_obs_${Date.now()}`;
    escrever(base, auditoria());
    try {
        const enviados = [];
        let buscas = 0;
        await comMocks({
            buscarContasPagar: async () => { buscas += 1; return { itens: buscas === 1 ? [] : [{ id: "evento-55" }] }; },
            criarContaPagar: async (corpo) => {
                enviados.push(corpo);
                if (corpo.observacao) throw new Error("Conta Azul 400: campo observacao nao aceito");
                return { protocolo: "prot-9", status: "PENDING" };
            },
        }, async () => {
            const r = await lancarDespesa(base, { dryRun: false, log: semLog });
            assert.equal(r.criado, true);
            assert.equal(r.observacao_aplicada, false);
        });
        const aceito = enviados[enviados.length - 1];
        assert.equal(aceito.rateio[0].rateio_centro_custo[0].id_centro_custo, CENTRO);
    } finally { limpar(base); }
});
