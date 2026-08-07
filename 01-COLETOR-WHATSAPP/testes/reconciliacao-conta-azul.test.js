"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    construirContextoReconciliacao,
    construirFiltrosReconciliacao,
    avaliarCandidatoReconciliacao,
    selecionarReconciliacaoInequivoca,
    reconciliarContaPagarAceita,
    loteLiberadoParaEmpresa,
} = require("../src/envio-conta-azul");

const EMPRESA = "3434571";
const FORNECEDOR = "8edcc481-b22d-4228-a633-0096f71c9393";
const CATEGORIA = "5bd50b47-4409-4157-b631-98a24f26148a";
const CENTRO = "43a40a34-8f89-11f1-8cae-0b3dbe3e2005";
const PARCELA = "ee16c9ab-4764-4e3b-8ee0-74248d9ad5e6";
const EVENTO = "b2e28c28-71e2-4604-bf8b-6f6ee8828f7c";

function auditoria() {
    return {
        ocr: { valor: 44, data: "2026-07-27", cnpj: "20.603.589/0001-20" },
        classificacao: { categoria_id: CATEGORIA, centro_custo_id: CENTRO },
        conta_azul: {
            empresa_id: EMPRESA,
            status: "CONFIRMACAO_INCERTA",
            previa: {
                tipo: "DESPESA",
                valor: 44,
                data_competencia: "2026-07-27",
                referencia_externa: "000014936",
                fornecedor: { id: FORNECEDOR, nome: "PANIFICADORA JK" },
                categoria: { id: CATEGORIA },
                centro_custo: { id: CENTRO },
                parcelas: [{ data_vencimento: "2026-07-27", valor_bruto: 44 }],
            },
        },
    };
}

function candidato({ parcela = PARCELA, evento = EVENTO, status = "QUITADO", anexos = true } = {}) {
    return {
        resumo: {
            id: parcela,
            status: status === "QUITADO" ? "ACQUITTED" : "PENDING",
            total: 44,
            descricao: "Compra de lanche - jul/2026",
            data_vencimento: "2026-07-27",
            data_competencia: "2026-07-27",
            categorias: [{ id: CATEGORIA, nome: "Lanches e Refeicoes" }],
            centros_de_custo: [{ id: CENTRO, nome: "CONSOL MG-050" }],
            fornecedor: { id: FORNECEDOR, nome: "PANIFICADORA JK" },
        },
        detalhe: {
            id: parcela,
            status,
            evento: {
                id: evento,
                tipo: "DESPESA",
                data_competencia: "2026-07-27",
                codigo_referencia: "000014936",
                rateio: [{
                    id_categoria: CATEGORIA,
                    valor: 44,
                    rateio_centro_custo: [{ id_centro_custo: CENTRO, valor: 44 }],
                }],
            },
            data_vencimento: "2026-07-27",
            valor_composicao: { valor_bruto: 44 },
            anexos: anexos ? [{ id: "anexo" }] : [],
            baixas: [],
        },
        pessoa: {
            id: FORNECEDOR,
            documento: "20603589000120",
            perfis: [{ tipo_perfil: "Fornecedor" }],
        },
    };
}

test("constroi busca estreita por parcela, competencia, valor, categoria e centro", () => {
    const contexto = construirContextoReconciliacao(auditoria(), { empresaId: EMPRESA });
    assert.deepEqual(contexto.impedimentos, []);
    assert.deepEqual(construirFiltrosReconciliacao(contexto), {
        pagina: 1,
        tamanho_pagina: 100,
        data_vencimento_de: "2026-07-27",
        data_vencimento_ate: "2026-07-27",
        data_competencia_de: "2026-07-27",
        data_competencia_ate: "2026-07-27",
        valor_de: "44.00",
        valor_ate: "44.00",
        ids_categorias: [CATEGORIA],
        ids_centros_de_custo: [CENTRO],
    });
});

test("valida inequivocamente resumo, parcela, evento, fornecedor, rateio e referencia", () => {
    const contexto = construirContextoReconciliacao(auditoria(), { empresaId: EMPRESA });
    for (const status of ["QUITADO", "PENDENTE"]) {
        const resultado = avaliarCandidatoReconciliacao(contexto, candidato({ status }));
        assert.equal(resultado.valido, true, resultado.motivos.join(" "));
        assert.equal(resultado.evento_id, EVENTO);
        assert.equal(resultado.parcela_id, PARCELA);
    }
    const perfilComoTexto = candidato();
    perfilComoTexto.pessoa.perfis = ["Fornecedor"];
    assert.equal(avaliarCandidatoReconciliacao(contexto, perfilComoTexto).valido, true);
});

test("ausencia de anexo na resposta financeira gera aviso, mas nao falso negativo", () => {
    const contexto = construirContextoReconciliacao(auditoria(), { empresaId: EMPRESA });
    const resultado = avaliarCandidatoReconciliacao(contexto, candidato({ anexos: false }));
    assert.equal(resultado.valido, true);
    assert.equal(resultado.anexo_localizado_na_api, false);
    assert.match(resultado.avisos.join(" "), /imagem visualmente/i);
    assert.match(resultado.avisos.join(" "), /nao libera o lote/i);
});

test("anexo de uma baixa e registrado, mas nunca substitui a conferencia visual do piloto", () => {
    const contexto = construirContextoReconciliacao(auditoria(), { empresaId: EMPRESA });
    const entrada = candidato({ anexos: false });
    entrada.detalhe.baixas = [{ anexos: [{ id: "anexo-da-baixa" }] }];
    const resultado = avaliarCandidatoReconciliacao(contexto, entrada);
    assert.equal(resultado.valido, true, resultado.motivos.join(" "));
    assert.equal(resultado.anexo_localizado_na_api, true);

    const fila = [{
        base: "nota-piloto",
        conta_azul: {
            status: "CONFIRMADO",
            empresa_id: EMPRESA,
            evento_id: resultado.evento_id,
            reconciliacao_financeira: { anexo_localizado_na_api: true },
        },
    }];
    assert.equal(loteLiberadoParaEmpresa(fila, EMPRESA), false);
});

test("qualquer contradicao financeira impede a reconciliacao", async (t) => {
    const contexto = construirContextoReconciliacao(auditoria(), { empresaId: EMPRESA });
    const casos = [
        ["valor do resumo", (c) => { c.resumo.total = 45; }],
        ["valor do detalhe", (c) => { c.detalhe.valor_composicao.valor_bruto = 45; }],
        ["competencia do resumo", (c) => { c.resumo.data_competencia = "2026-07-28"; }],
        ["competencia", (c) => { c.detalhe.evento.data_competencia = "2026-07-28"; }],
        ["vencimento do resumo", (c) => { c.resumo.data_vencimento = "2026-07-28"; }],
        ["vencimento do detalhe", (c) => { c.detalhe.data_vencimento = "2026-07-28"; }],
        ["tipo", (c) => { c.detalhe.evento.tipo = "RECEITA"; }],
        ["parcela trocada no detalhe", (c) => { c.detalhe.id = "70b021b7-c7e3-4277-a64d-b85b7538b210"; }],
        ["evento sem ID", (c) => { c.detalhe.evento.id = null; }],
        ["parcela cancelada", (c) => { c.detalhe.status = "CANCELADO"; }],
        ["fornecedor", (c) => { c.resumo.fornecedor.id = "70b021b7-c7e3-4277-a64d-b85b7538b210"; }],
        ["CNPJ", (c) => { c.pessoa.documento = "11111111000111"; }],
        ["categoria do resumo", (c) => { c.resumo.categorias[0].id = "70b021b7-c7e3-4277-a64d-b85b7538b210"; }],
        ["categoria", (c) => { c.detalhe.evento.rateio[0].id_categoria = "70b021b7-c7e3-4277-a64d-b85b7538b210"; }],
        ["centro do resumo", (c) => { c.resumo.centros_de_custo[0].id = "70b021b7-c7e3-4277-a64d-b85b7538b210"; }],
        ["centro", (c) => { c.detalhe.evento.rateio[0].rateio_centro_custo[0].id_centro_custo = "70b021b7-c7e3-4277-a64d-b85b7538b210"; }],
        ["referencia", (c) => { c.detalhe.evento.codigo_referencia = "OUTRA"; }],
    ];
    for (const [nome, alterar] of casos) {
        await t.test(nome, () => {
            const entrada = candidato();
            alterar(entrada);
            assert.equal(avaliarCandidatoReconciliacao(contexto, entrada).valido, false);
        });
    }
});

test("zero, multiplos candidatos ou pagina incompleta permanecem incertos", () => {
    const contexto = construirContextoReconciliacao(auditoria(), { empresaId: EMPRESA });
    assert.equal(selecionarReconciliacaoInequivoca(contexto, []).confirmado, false);

    const segundo = candidato({
        parcela: "a976f173-f531-4660-96ae-04b71c879264",
        evento: "a5473eec-4e74-41ee-b500-9f61de8a8b8b",
    });
    assert.equal(selecionarReconciliacaoInequivoca(contexto, [candidato(), segundo]).confirmado, false);
    assert.equal(selecionarReconciliacaoInequivoca(contexto, [candidato()], { totalRemoto: 2 }).confirmado, false);
});

test("um candidato integral vence divergentes avaliados, mas nunca um candidato nao consultado", () => {
    const contexto = construirContextoReconciliacao(auditoria(), { empresaId: EMPRESA });
    const divergente = candidato({
        parcela: "a976f173-f531-4660-96ae-04b71c879264",
        evento: "a5473eec-4e74-41ee-b500-9f61de8a8b8b",
    });
    divergente.resumo.total = 45;
    assert.equal(
        selecionarReconciliacaoInequivoca(contexto, [candidato(), divergente], { totalRemoto: 2 }).confirmado,
        true,
        "Um candidato totalmente consultado e divergente nao torna ambigua a correspondencia integral unica.",
    );

    const naoConsultado = {
        resumo: divergente.resumo,
        detalhe: {},
        pessoa: {},
        erro_consulta: "timeout ao consultar a parcela",
    };
    const incerto = selecionarReconciliacaoInequivoca(contexto, [candidato(), naoConsultado], { totalRemoto: 2 });
    assert.equal(incerto.confirmado, false, "Uma consulta incompleta pode esconder uma segunda correspondencia integral.");
    assert.match(incerto.motivos.join(" "), /detalhes completamente consultados/i);
});

test("situacao pago ou em aberto nao serve para desempatar duas despesas iguais", () => {
    const contexto = construirContextoReconciliacao(auditoria(), { empresaId: EMPRESA });
    const pago = candidato({ status: "QUITADO" });
    const aberto = candidato({
        parcela: "a976f173-f531-4660-96ae-04b71c879264",
        evento: "a5473eec-4e74-41ee-b500-9f61de8a8b8b",
        status: "PENDENTE",
    });
    const resultado = selecionarReconciliacaoInequivoca(contexto, [pago, aberto], { totalRemoto: 2 });
    assert.equal(resultado.confirmado, false);
    assert.equal(resultado.candidatos_validos, 2);
});

test("orquestrador usa dependencias injetadas e nunca chama APIs reais em teste", async () => {
    const entrada = candidato();
    const chamadas = [];
    const resultado = await reconciliarContaPagarAceita(auditoria(), {
        empresaId: EMPRESA,
        buscar: async (filtros) => { chamadas.push(["buscar", filtros]); return { itens_totais: 1, itens: [entrada.resumo] }; },
        obterParcela: async (id) => { chamadas.push(["parcela", id]); return entrada.detalhe; },
        obterPessoa: async (id) => { chamadas.push(["pessoa", id]); return entrada.pessoa; },
    });
    assert.equal(resultado.confirmado, true, resultado.motivos.join(" "));
    assert.deepEqual(chamadas.map(([tipo]) => tipo), ["buscar", "parcela", "pessoa"]);
    assert.equal(resultado.evento_id, EVENTO);
});

test("falha ao hidratar detalhe ou pessoa nao confirma por aproximacao", async () => {
    const entrada = candidato();
    const resultado = await reconciliarContaPagarAceita(auditoria(), {
        empresaId: EMPRESA,
        buscar: async () => ({ itens_totais: 1, itens: [entrada.resumo] }),
        obterParcela: async () => { throw new Error("indisponivel"); },
        obterPessoa: async () => { throw new Error("nao deveria ser chamada"); },
    });
    assert.equal(resultado.confirmado, false);
    assert.equal(resultado.candidatos_validos, 0);
    assert.match(JSON.stringify(resultado.avaliacoes), /indisponivel/);
});
