"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { centroCustoDoTextoLivre, aplicarCentroCustoPadrao } = require("../src/pipeline");
const { camposFaltantes, extrairEstadoAtual } = require("../src/enriquecedor-conta-azul");
const { interpretarLegenda } = require("../src/legenda");
const notificacoes = require("../src/notificacoes");

const CENTROS = [
    { id: "centro-1", nome: "CONSOL MG-050", apelidos: ["mg050"] },
    { id: "centro-2", nome: "CONSOL MG-259", apelidos: [] },
    { id: "centro-3", nome: "OBRA BR-153", apelidos: [] },
];

// ---------------------------------------------------------------------------
// Projeto escrito livremente na legenda
// ---------------------------------------------------------------------------

test("le o projeto escrito na legenda sem o rotulo 'Centro de custo:'", () => {
    assert.equal(centroCustoDoTextoLivre("almoco CONSOL MG-050", CENTROS)?.id, "centro-1");
    assert.equal(centroCustoDoTextoLivre("abastecimento obra br-153", CENTROS)?.id, "centro-3");
    assert.equal(centroCustoDoTextoLivre("almoco mg050", CENTROS)?.id, "centro-1", "apelido tambem vale");
});

test("nao adivinha o projeto quando a legenda cita mais de um", () => {
    assert.equal(centroCustoDoTextoLivre("transferencia CONSOL MG-050 para CONSOL MG-259", CENTROS), null);
});

test("legenda sem nenhum projeto conhecido nao inventa centro de custo", () => {
    assert.equal(centroCustoDoTextoLivre("almoco da equipe", CENTROS), null);
    assert.equal(centroCustoDoTextoLivre("", CENTROS), null);
});

test("aceita o rotulo 'Projeto:' na legenda estruturada", () => {
    const operador = interpretarLegenda("Tipo: Alimentacao\nProjeto: CONSOL MG-259");
    assert.equal(operador.centro_custo_informado, "CONSOL MG-259");
});

test("projeto escrito na legenda vence o padrao do grupo", () => {
    const contexto = aplicarCentroCustoPadrao(
        interpretarLegenda("almoco CONSOL MG-259"),
        { legenda: "almoco CONSOL MG-259", centro_custo_padrao: { id: "centro-1", nome: "CONSOL MG-050" } },
        CENTROS
    );
    assert.equal(contexto.origem, "legenda_texto_livre");
    assert.equal(contexto.centro.id, "centro-2");
});

test("sem projeto na legenda, continua usando o padrao do grupo", () => {
    const contexto = aplicarCentroCustoPadrao(
        interpretarLegenda("almoco da equipe"),
        { legenda: "almoco da equipe", centro_custo_padrao: { id: "centro-1", nome: "CONSOL MG-050" } },
        CENTROS
    );
    assert.equal(contexto.origem, "grupo_whatsapp");
    assert.equal(contexto.centro.id, "centro-1");
});

// ---------------------------------------------------------------------------
// Conferencia do lancamento inteiro
// ---------------------------------------------------------------------------

test("confere todos os campos do lancamento, nao so categoria/centro/pagamento", () => {
    const estado = extrairEstadoAtual({
        rateio: [{ id_categoria: "cat-1", valor: 48 }],
        metodo_pagamento: null,
        descricao: "Compra",
        data_competencia: "2026-08-10",
        data_vencimento: null,
        valor: 48,
        anexos: [],
    });
    const faltantes = camposFaltantes(estado);
    const campos = faltantes.map((item) => item.campo);

    assert.ok(campos.includes("centro_custo"), "centro de custo vazio deve aparecer");
    assert.ok(campos.includes("metodo_pagamento"), "forma de pagamento vazia deve aparecer");
    assert.ok(campos.includes("fornecedor"), "fornecedor vazio deve aparecer");
    assert.ok(campos.includes("data_vencimento"), "vencimento vazio deve aparecer");
    assert.ok(campos.includes("conta_financeira"), "conta financeira vazia deve aparecer");
    assert.ok(campos.includes("anexo"), "lancamento sem anexo deve aparecer");
    assert.ok(!campos.includes("categoria"), "categoria preenchida nao pode ser listada");
    assert.ok(!campos.includes("descricao"), "descricao preenchida nao pode ser listada");

    // separa o que o sistema consegue preencher do que depende de uma pessoa
    assert.equal(faltantes.find((item) => item.campo === "centro_custo").preenchivel, true);
    assert.equal(faltantes.find((item) => item.campo === "fornecedor").preenchivel, false);
});

test("lancamento completo nao gera nenhuma pendencia", () => {
    const estado = extrairEstadoAtual({
        rateio: [{ id_categoria: "cat-1", valor: 48, rateio_centro_custo: [{ id_centro_custo: "centro-1", valor: 48 }] }],
        metodo_pagamento: "PIX",
        descricao: "Compra",
        fornecedor: { nome: "PADARIA" },
        data_competencia: "2026-08-10",
        data_vencimento: "2026-08-10",
        id_conta_financeira: "conta-1",
        valor: 48,
        anexos: [{ id: "anexo-1" }],
    });
    assert.deepEqual(camposFaltantes(estado), []);
});

// ---------------------------------------------------------------------------
// Central de avisos do programa
// ---------------------------------------------------------------------------

test("registra, conta e marca avisos como lidos", () => {
    const backup = fs.existsSync(notificacoes.ARQUIVO) ? fs.readFileSync(notificacoes.ARQUIVO, "utf8") : null;
    try {
        notificacoes.limpar();
        assert.equal(notificacoes.contarNaoLidas(), 0);

        notificacoes.registrar({ titulo: "Despesa completa", texto: "tudo certo", nivel: "sucesso", base: "doc-1" });
        notificacoes.registrar({ titulo: "Falta informacao", texto: "confira", nivel: "atencao", base: "doc-2", pendencias: ["Forma de pagamento"] });

        assert.equal(notificacoes.contarNaoLidas(), 2);
        const lista = notificacoes.listar();
        assert.equal(lista[0].titulo, "Falta informacao", "o aviso mais novo vem primeiro");
        assert.deepEqual(lista[0].pendencias, ["Forma de pagamento"]);

        notificacoes.marcarLida(lista[0].id);
        assert.equal(notificacoes.contarNaoLidas(), 1);

        notificacoes.marcarLida();
        assert.equal(notificacoes.contarNaoLidas(), 0);
        assert.equal(notificacoes.listar().length, 2, "marcar como lida nao apaga o historico");
    } finally {
        if (backup === null) notificacoes.limpar();
        else fs.writeFileSync(notificacoes.ARQUIVO, backup, "utf8");
    }
});

test("nome mais especifico vence: 'CONSOL MG-050' nao e confundido com 'Consol'", () => {
    // Cadastro real do cliente, onde um centro curto e prefixo de outros
    const centros = [
        { id: "c-curto", nome: "Consol", apelidos: [] },
        { id: "c-050", nome: "CONSOL MG-050", apelidos: [] },
        { id: "c-259", nome: "CONSOL MG-259", apelidos: [] },
    ];
    assert.equal(centroCustoDoTextoLivre("Abastecimento CONSOL MG-050 Placa JKM0I96", centros)?.id, "c-050");
    assert.equal(centroCustoDoTextoLivre("Janta CONSOL MG-259", centros)?.id, "c-259");
    assert.equal(centroCustoDoTextoLivre("Cafe Consol", centros)?.id, "c-curto", "o nome curto sozinho continua valendo");
    assert.equal(
        centroCustoDoTextoLivre("Transferencia CONSOL MG-050 para CONSOL MG-259", centros),
        null,
        "dois projetos distintos citados = ambiguidade real"
    );
});
