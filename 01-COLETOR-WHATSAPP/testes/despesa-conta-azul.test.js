"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    montarDespesa,
    criarDespesa,
    confirmarDespesa,
    validarDetalheDespesa,
    dataIso,
    numeroPositivo,
    uuidValido,
} = require("../src/despesa-conta-azul");

const CATEGORIA = "5bd50b47-4409-4157-b631-98a24f26148a";
const CENTRO = "43a40a34-8f89-11f1-8cae-0b3dbe3e2005";
const PROTOCOLO = "1ee1d478-a674-4b70-a6a9-60c69f43f9aa";
const PARCELA = "8e0635a6-9a22-46e4-bcee-a5fd0ec8fd92";
const base = {
    descricao: "ALMOCO - 2 PESSOAS",
    valor: 84,
    data: "2026-08-07",
    idCategoria: CATEGORIA,
    idCentroCusto: CENTRO,
};

function detalheValido(alterar = (valor) => valor) {
    const detalhe = {
        id: PARCELA,
        valor_composicao: { valor_bruto: 84 },
        evento: {
            id: "a99dc8c1-07f1-4f49-a741-ff9b48552cea",
            tipo: "DESPESA",
            data_competencia: "2026-08-07",
            referencia: { id: PROTOCOLO },
            rateio: [{
                id_categoria: CATEGORIA,
                valor_bruto: 84,
                rateio_centro_custo: [{ id_centro_custo: CENTRO, valor_bruto: 84 }],
            }],
        },
    };
    alterar(detalhe);
    return detalhe;
}

test("monta o corpo direto com parcela, categoria e centro corretos", () => {
    const corpo = montarDespesa(base);
    assert.equal(corpo.descricao, base.descricao);
    assert.equal(corpo.valor, 84);
    assert.equal(corpo.data_competencia, "2026-08-07");
    assert.equal(corpo.condicao_pagamento.parcelas[0].descricao, base.descricao);
    assert.deepEqual(corpo.condicao_pagamento.parcelas[0].detalhe_valor, {
        valor_bruto: 84, valor_liquido: 84, desconto: 0, taxa: 0, multa: 0, juros: 0,
    });
    assert.deepEqual(corpo.rateio[0].rateio_centro_custo, [{ id_centro_custo: CENTRO, valor: 84 }]);
});

test("normaliza valor brasileiro e arredonda todos os rateios", () => {
    assert.equal(numeroPositivo("R$ 1.234,567"), 1234.57);
    const corpo = montarDespesa({ ...base, valor: "84,006" });
    assert.equal(corpo.valor, 84.01);
    assert.equal(corpo.rateio[0].valor, 84.01);
    assert.equal(corpo.rateio[0].rateio_centro_custo[0].valor, 84.01);
});

test("recusa datas inexistentes e UUIDs improvisados", () => {
    for (const data of ["2026-99-99", "2026-02-31", "31/02/2026", "07-08-2026"]) {
        assert.equal(dataIso(data), null, data);
        assert.throws(() => montarDespesa({ ...base, data }), /Data invalida/);
    }
    assert.equal(dataIso("07/08/2026"), "2026-08-07");
    assert.equal(uuidValido(CATEGORIA), true);
    for (const id of ["abc", "PREENCHER_UUID_CONTA_AZUL", "", null]) assert.equal(uuidValido(id), false);
    assert.throws(() => montarDespesa({ ...base, idCategoria: "abc" }), /UUID da categoria/);
    assert.throws(() => montarDespesa({ ...base, idCentroCusto: "abc" }), /UUID do centro/);
});

test("centro de custo e obrigatorio no motor direto por padrao", () => {
    assert.throws(() => montarDespesa({ ...base, idCentroCusto: null }), /Centro de custo obrigatorio/);
    const corpo = montarDespesa({ ...base, idCentroCusto: null, permitirSemCentro: true });
    assert.equal("rateio_centro_custo" in corpo.rateio[0], false);
});

test("criacao direta exige e confere a empresa antes do POST", async () => {
    const chamadas = [];
    const requisicaoFn = async (endpoint, opcoes) => {
        chamadas.push({ endpoint, opcoes });
        if (endpoint === "/v1/pessoas/conta-conectada") return { id_empresa: "3434571" };
        return { protocolo: PROTOCOLO, status: "PENDING" };
    };
    await assert.rejects(() => criarDespesa(base, { requisicaoFn }), /empresa confirmada/);
    await assert.rejects(() => criarDespesa(base, { empresaEsperadaId: "outra", requisicaoFn }), /nao corresponde/);
    const criado = await criarDespesa(base, { empresaEsperadaId: "3434571", requisicaoFn });
    assert.equal(criado.protocolo, PROTOCOLO);
    assert.equal(chamadas.at(-1).endpoint, "/v1/financeiro/eventos-financeiros/contas-a-pagar");
    assert.equal(JSON.parse(chamadas.at(-1).opcoes.body).rateio[0].id_categoria, CATEGORIA);
});

test("reconciliacao direta valida protocolo, valor, data, categoria e centro", () => {
    const esperado = { ...base, protocolo: PROTOCOLO };
    assert.equal(validarDetalheDespesa(detalheValido(), esperado).valido, true);
    const contradicoes = [
        (d) => { d.evento.referencia.id = "outro"; },
        (d) => { d.valor_composicao.valor_bruto = 85; },
        (d) => { d.evento.data_competencia = "2026-08-08"; },
        (d) => { d.evento.rateio[0].id_categoria = "4515b867-b36f-4703-ab50-7a1d35c2096f"; },
        (d) => { d.evento.rateio[0].valor_bruto = 80; },
        (d) => { d.evento.rateio[0].rateio_centro_custo[0].id_centro_custo = "441058a6-8f89-11f1-a757-1b04f821eecd"; },
        (d) => { d.evento.rateio[0].rateio_centro_custo[0].valor_bruto = 80; },
    ];
    for (const alterar of contradicoes) {
        assert.equal(validarDetalheDespesa(detalheValido(alterar), esperado).valido, false);
    }
});

test("confirmacao consulta a parcela e so aceita um candidato integral", async () => {
    const requisicaoFn = async (endpoint) => {
        if (endpoint.includes("/buscar?")) {
            return { itens: [{ id: PARCELA, descricao: base.descricao, total: 84 }] };
        }
        if (endpoint.endsWith(PARCELA)) return detalheValido();
        throw new Error(`Endpoint inesperado: ${endpoint}`);
    };
    const resposta = await confirmarDespesa({ ...base, protocolo: PROTOCOLO }, { requisicaoFn });
    assert.equal(resposta.confirmado, true);
    assert.equal(resposta.lancamento.id, PARCELA);
});

test("confirmacao sem protocolo ou com mais de um candidato nunca escolhe por aproximacao", async () => {
    await assert.rejects(() => confirmarDespesa(base, { requisicaoFn: async () => ({ itens: [] }) }), /Protocolo obrigatorio/);
    const requisicaoFn = async (endpoint) => {
        if (endpoint.includes("/buscar?")) {
            return { itens: [
                { id: PARCELA, descricao: base.descricao, total: 84 },
                { id: "f6ef1d9b-f9ee-4f51-8cb4-b5b091c3e718", descricao: base.descricao, total: 84 },
            ] };
        }
        return detalheValido();
    };
    const resposta = await confirmarDespesa({ ...base, protocolo: PROTOCOLO }, { requisicaoFn });
    assert.equal(resposta.confirmado, false);
    assert.equal(resposta.ambiguo, true);
});
