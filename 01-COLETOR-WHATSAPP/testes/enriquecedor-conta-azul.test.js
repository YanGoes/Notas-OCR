"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// O enriquecedor acessa `contaAzul.<funcao>(...)` sempre pela propriedade do
// modulo (nao desestrutura no import), entao da para trocar as funcoes aqui
// sem precisar de nenhuma biblioteca de mock: e o mesmo objeto que o
// enriquecedor enxerga.
const contaAzul = require("../src/conta-azul");
const enriquecedor = require("../src/enriquecedor-conta-azul");

const CATEGORIA_ALMOCO = "4515b867-b36f-4703-ab50-7a1d35c2096f"; // "Refeição - Almoço" real em configuracao/categorias.json
const CENTRO_CONSOL_050 = "43a40a34-8f89-11f1-8cae-0b3dbe3e2005"; // "CONSOL MG-050" real em configuracao/centros_custo.json

function parcelaFake({ categoriaId = null, centroCustoId = null, metodoPagamento = null, id = "parcela-1", versao = 1 } = {}) {
    const rateio = categoriaId
        ? [{
            id_categoria: categoriaId,
            valor: 48,
            ...(centroCustoId ? { rateio_centro_custo: [{ id_centro_custo: centroCustoId, valor: 48 }] } : {}),
        }]
        : [];
    return { id, versao, metodo_pagamento: metodoPagamento, rateio };
}

function eventoFake(overrides = {}) {
    return { id: "evento-1", descricao: "Compra teste", valor: 48, data_competencia: "2026-08-10", ...overrides };
}

async function comMocks(mocks, fn) {
    const originais = {};
    for (const chave of Object.keys(mocks)) originais[chave] = contaAzul[chave];
    Object.assign(contaAzul, mocks);
    try {
        return await fn();
    } finally {
        Object.assign(contaAzul, originais);
    }
}

const semLog = () => {};

// ---------------------------------------------------------------------------
// atualizarParcela — fallback de hipotese (rateio/centro de custo no PATCH
// nunca foi confirmado por teste real; so metodo_pagamento foi confirmado)
// ---------------------------------------------------------------------------

test("atualizarParcela aplica categoria + centro + metodo quando a API aceita o payload completo", async () => {
    const corposEnviados = [];
    await comMocks({
        patchParcela: async (id, corpo) => { corposEnviados.push(corpo); return { ok: true }; },
    }, async () => {
        const resultado = await enriquecedor.atualizarParcela(
            "parcela-1", 1,
            { categoriaId: CATEGORIA_ALMOCO, valor: 48, centroCustoId: CENTRO_CONSOL_050, metodoPagamento: "PIX" },
            { log: semLog }
        );
        assert.equal(resultado.tentativaAplicada, "rateio_completo");
        assert.equal(resultado.categoriaAplicada, true);
        assert.equal(resultado.centroCustoAplicado, true);
        assert.equal(resultado.metodoPagamentoAplicado, true);
        assert.equal(corposEnviados.length, 1);
        assert.equal(corposEnviados[0].rateio[0].rateio_centro_custo[0].id_centro_custo, CENTRO_CONSOL_050);
    });
});

test("atualizarParcela cai para payload sem centro de custo quando a API rejeita especificamente esse campo (400)", async () => {
    const corposEnviados = [];
    await comMocks({
        patchParcela: async (id, corpo) => {
            corposEnviados.push(corpo);
            if (corpo.rateio?.[0]?.rateio_centro_custo) {
                throw new Error('Conta Azul 400: {"erro":"campo rateio_centro_custo nao suportado"}');
            }
            return { ok: true };
        },
    }, async () => {
        const resultado = await enriquecedor.atualizarParcela(
            "parcela-1", 1,
            { categoriaId: CATEGORIA_ALMOCO, valor: 48, centroCustoId: CENTRO_CONSOL_050, metodoPagamento: "PIX" },
            { log: semLog }
        );
        assert.equal(resultado.tentativaAplicada, "rateio_sem_centro_custo");
        assert.equal(resultado.categoriaAplicada, true);
        assert.equal(resultado.centroCustoAplicado, false);
        assert.equal(resultado.metodoPagamentoAplicado, true);
        assert.equal(corposEnviados.length, 2);
        assert.equal(corposEnviados[1].rateio[0].rateio_centro_custo, undefined);
    });
});

test("atualizarParcela cai ate metodo_pagamento isolado quando o rateio inteiro e rejeitado (400)", async () => {
    let chamadas = 0;
    await comMocks({
        patchParcela: async (id, corpo) => {
            chamadas += 1;
            if (corpo.rateio) throw new Error("Conta Azul 422: rateio nao aceito neste endpoint");
            return { ok: true };
        },
    }, async () => {
        const resultado = await enriquecedor.atualizarParcela(
            "parcela-1", 1,
            { categoriaId: CATEGORIA_ALMOCO, valor: 48, centroCustoId: CENTRO_CONSOL_050, metodoPagamento: "PIX" },
            { log: semLog }
        );
        assert.equal(resultado.tentativaAplicada, "somente_metodo_pagamento");
        assert.equal(resultado.categoriaAplicada, false);
        assert.equal(resultado.centroCustoAplicado, false);
        assert.equal(resultado.metodoPagamentoAplicado, true);
        assert.equal(chamadas, 3);
    });
});

test("atualizarParcela propaga imediatamente erros que nao sao rejeicao de campo (ex: 401), sem tentar payload menor", async () => {
    let chamadas = 0;
    await comMocks({
        patchParcela: async () => { chamadas += 1; throw new Error("Conta Azul 401: token invalido"); },
    }, async () => {
        await assert.rejects(
            enriquecedor.atualizarParcela(
                "parcela-1", 1,
                { categoriaId: CATEGORIA_ALMOCO, valor: 48, centroCustoId: CENTRO_CONSOL_050, metodoPagamento: "PIX" },
                { log: semLog }
            ),
            /401/
        );
        assert.equal(chamadas, 1);
    });
});

// ---------------------------------------------------------------------------
// buscarLancamentoRecente — nunca escolher "o primeiro" quando ha ambiguidade
// ---------------------------------------------------------------------------

test("buscarLancamentoRecente recusa escolher automaticamente entre candidatos ambiguos e nao retenta", async () => {
    let chamadas = 0;
    await comMocks({
        buscarContasPagar: async () => {
            chamadas += 1;
            return { itens: [eventoFake({ id: "evento-A" }), eventoFake({ id: "evento-B" })] };
        },
    }, async () => {
        await assert.rejects(
            enriquecedor.buscarLancamentoRecente(48, "2026-08-10", { tentativas: 3, intervaloInicialMs: 1, log: semLog }),
            /ambíguos/
        );
        assert.equal(chamadas, 1);
    });
});

test("buscarLancamentoRecente desambigua por CNPJ/CPF do fornecedor quando informado", async () => {
    await comMocks({
        buscarContasPagar: async () => ({
            itens: [
                eventoFake({ id: "evento-A", fornecedor: { documento: "11.222.333/0001-44" } }),
                eventoFake({ id: "evento-B", fornecedor: { documento: "55.666.777/0001-88" } }),
            ],
        }),
    }, async () => {
        const lancamento = await enriquecedor.buscarLancamentoRecente(48, "2026-08-10", {
            fornecedorCnpj: "55666777000188",
            log: semLog,
        });
        assert.equal(lancamento.id, "evento-B");
    });
});

// ---------------------------------------------------------------------------
// enriquecer() — so complementa o que falta, nunca sobrescreve o que a Conta
// AI ja preencheu corretamente
// ---------------------------------------------------------------------------

test("enriquecer() nao faz nenhum PATCH quando a Conta AI ja preencheu tudo que seria complementado", async () => {
    let patchChamado = false;
    await comMocks({
        buscarContasPagar: async () => ({ itens: [eventoFake()] }),
        buscarParcelasDoEvento: async () => ({
            itens: [parcelaFake({ categoriaId: CATEGORIA_ALMOCO, centroCustoId: CENTRO_CONSOL_050, metodoPagamento: "PIX" })],
        }),
        patchParcela: async () => { patchChamado = true; return {}; },
    }, async () => {
        const resultado = await enriquecedor.enriquecer(
            48, "2026-08-10",
            { categoria: "almoco", centroCusto: "consol mg-050", metodoPagamento: "pix" },
            { log: semLog }
        );
        assert.equal(resultado.sucesso, true);
        assert.equal(resultado.etapas.patch.executado, false);
        assert.equal(resultado.etapas.patch.motivo, "nada_a_complementar");
        assert.equal(patchChamado, false);
    });
});

test("enriquecer() so complementa o centro de custo ausente, preservando a categoria ja definida pela Conta AI", async () => {
    const CATEGORIA_DIFERENTE = "00000000-0000-0000-0000-000000000000";
    const corposEnviados = [];
    await comMocks({
        buscarContasPagar: async () => ({ itens: [eventoFake()] }),
        buscarParcelasDoEvento: async () => ({
            itens: [parcelaFake({ categoriaId: CATEGORIA_DIFERENTE, centroCustoId: null, metodoPagamento: "PIX" })],
        }),
        patchParcela: async (id, corpo) => { corposEnviados.push(corpo); return {}; },
    }, async () => {
        const resultado = await enriquecedor.enriquecer(
            48, "2026-08-10",
            { categoria: "almoco", centroCusto: "consol mg-050", metodoPagamento: "pix" },
            { log: semLog }
        );
        assert.equal(resultado.sucesso, true);
        assert.equal(corposEnviados.length, 1);
        // A categoria enviada e a que JA ESTAVA na parcela, nao a resolvida localmente.
        assert.equal(corposEnviados[0].rateio[0].id_categoria, CATEGORIA_DIFERENTE);
        assert.equal(corposEnviados[0].rateio[0].rateio_centro_custo[0].id_centro_custo, CENTRO_CONSOL_050);
    });
});

// ---------------------------------------------------------------------------
// Concorrencia / duplicidade
// ---------------------------------------------------------------------------

test("enriquecer() recusa uma segunda execucao concorrente para a mesma chave de idempotencia", async () => {
    await comMocks({
        buscarContasPagar: async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return { itens: [eventoFake()] };
        },
        buscarParcelasDoEvento: async () => ({ itens: [parcelaFake({})] }),
        patchParcela: async () => ({}),
    }, async () => {
        const contexto = { categoria: "almoco", centroCusto: "consol mg-050", metodoPagamento: "pix" };
        const opcoes = { dryRun: true, log: semLog, chaveIdempotencia: "teste-trava-concorrencia" };

        const primeira = enriquecedor.enriquecer(48, "2026-08-10", contexto, opcoes);
        await assert.rejects(
            enriquecedor.enriquecer(48, "2026-08-10", contexto, opcoes),
            /em andamento/
        );
        const resultado = await primeira;
        assert.equal(resultado.sucesso, true);

        // A trava precisa ser liberada ao final: uma nova chamada com a mesma
        // chave, depois que a primeira terminou, deve funcionar normalmente.
        const depois = await enriquecedor.enriquecer(48, "2026-08-10", contexto, opcoes);
        assert.equal(depois.sucesso, true);
    });
});
