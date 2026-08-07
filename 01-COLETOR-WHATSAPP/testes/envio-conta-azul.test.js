"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    uuidValido,
    dataIsoValida,
    centavos,
    avaliarProntidao,
    resumirPrevia,
    compararPrevia,
    tokenConfirmacao,
    empresaPreparacaoCompativel,
    avaliarControlePiloto,
    loteLiberadoParaEmpresa,
} = require("../src/envio-conta-azul");

const CATEGORIA = "5bd50b47-4409-4157-b631-98a24f26148a";
const CENTRO = "af692fa0-8f85-11f1-a1fb-07d665f7a520";
const EMPRESA = "1f6a7f36-d858-4b59-90e1-b3a149988501";
const OUTRA_EMPRESA = "70b021b7-c7e3-4277-a64d-b85b7538b210";

function auditoriaValida() {
    return {
        arquivo_imagem: "nota.jpg",
        ocr: { fornecedor: "Fornecedor Teste", cnpj: "20.603.589/0001-20", valor: 44, data: "2026-07-27", confianca: 0.98 },
        classificacao: { tipo: "alimentacao", categoria_id: CATEGORIA, categoria_nome: "Lanches e Refeicoes", centro_custo_id: CENTRO, centro_custo_nome: "Consol" },
        validacoes: { escopo_permitido: true, bloqueado: false, revisao_necessaria: false, duplicado: false, motivos: [] },
        conta_azul: { status: "NAO_ENVIADO" },
    };
}

test("valida UUID, data ISO real e arredondamento em centavos", () => {
    assert.equal(uuidValido(CATEGORIA), true);
    assert.equal(uuidValido("PREENCHER_UUID"), false);
    assert.equal(dataIsoValida("2026-02-28"), true);
    assert.equal(dataIsoValida("2026-02-30"), false);
    assert.equal(centavos(44.009), 4401);
});

test("libera somente auditoria completa da fila aprovada", () => {
    const resultado = avaliarProntidao(auditoriaValida(), { imagemExiste: true, confiancaMinima: 0.95 });
    assert.deepEqual(resultado, { pronto: true, impedimentos: [] });
});

test("bloqueia revisao, identificadores invalidos e reenvio", () => {
    const auditoria = auditoriaValida();
    auditoria.validacoes.revisao_necessaria = true;
    auditoria.validacoes.motivos = ["Centro ausente."];
    auditoria.classificacao.centro_custo_id = "centro-invalido";
    auditoria.conta_azul.status = "PREVIA_CONFERIDA";
    const resultado = avaliarProntidao(auditoria);
    assert.equal(resultado.pronto, false);
    assert.match(resultado.impedimentos.join(" "), /revisao humana/i);
    assert.match(resultado.impedimentos.join(" "), /Centro ausente/i);
    assert.match(resultado.impedimentos.join(" "), /ja foi preparado/i);
});

test("combustivel exige placa e litragem antes do envio", () => {
    const auditoria = auditoriaValida();
    auditoria.classificacao.tipo = "combustivel";
    const resultado = avaliarProntidao(auditoria);
    assert.equal(resultado.pronto, false);
    assert.match(resultado.impedimentos.join(" "), /Placa obrigatoria/);
    assert.match(resultado.impedimentos.join(" "), /Litragem obrigatoria/);
});

test("resume e confere previa equivalente da Captura", () => {
    const resposta = {
        previa_evento_financeiro: {
            tipo: "DESPESA", valor: 44, data_competencia: "2026-07-27", descricao: "Lanche",
            fornecedor: { id: "fornecedor", nome: "Fornecedor Teste", documento: "20603589000120" },
            categoria: { id: CATEGORIA, nome: "Lanches e Refeicoes" },
            centro_custo: { id: CENTRO, nome: "Consol" },
            parcelas: [{ data_vencimento: "2026-07-27", composicao_valor: { valor_bruto: 44 } }],
        },
    };
    const previa = resumirPrevia(resposta);
    assert.equal(previa.parcelas[0].valor_bruto, 44);
    assert.deepEqual(compararPrevia(auditoriaValida(), previa), []);
});

test("impede aceite quando valor, categoria, centro ou fornecedor divergem", () => {
    const previa = {
        tipo: "RECEITA", valor: 45, data_competencia: "2026-07-28",
        fornecedor: { documento: "11111111000111" }, categoria: null, centro_custo: null, parcelas: [],
    };
    const divergencias = compararPrevia(auditoriaValida(), previa);
    assert.equal(divergencias.length, 6);
    assert.match(divergencias.join(" "), /DESPESA/);
    assert.match(divergencias.join(" "), /Categoria diferente/);
});

test("token de confirmacao muda quando a previa muda", () => {
    const auditoria = auditoriaValida();
    auditoria.conta_azul = { status: "PREVIA_CONFERIDA", captura_id: "captura", previa: { tipo: "DESPESA", valor: 44, data_competencia: "2026-07-27", categoria: { id: CATEGORIA }, centro_custo: { id: CENTRO } } };
    const primeiro = tokenConfirmacao("nota", auditoria);
    auditoria.conta_azul.previa.valor = 45;
    assert.notEqual(tokenConfirmacao("nota", auditoria), primeiro);
});

function auditoriaPreparada() {
    const auditoria = auditoriaValida();
    auditoria.rastreabilidade = { sha256: "a".repeat(64), chave_fiscal: "20603589000120|2026-07-27|44.00" };
    auditoria.conta_azul = {
        status: "PREVIA_CONFERIDA",
        empresa_id: EMPRESA,
        documento_id: "documento-1",
        captura_id: "captura-1",
        previa: {
            tipo: "DESPESA",
            valor: 44,
            data_competencia: "2026-07-27",
            descricao: "Lanche - VMAC",
            observacao: "Comprovante recebido pelo WhatsApp",
            fornecedor: { id: "fornecedor-1", nome: "Fornecedor Teste", documento: "20603589000120" },
            categoria: { id: CATEGORIA, nome: "Lanches e Refeicoes" },
            centro_custo: { id: CENTRO, nome: "Consol" },
            parcelas: [{
                data_vencimento: "2026-07-27",
                metodo_pagamento: "CARTAO_CREDITO",
                valor_bruto: 44,
            }],
        },
    };
    return auditoria;
}

test("preparacao fica vinculada a empresa em que a previa foi criada", () => {
    assert.equal(typeof empresaPreparacaoCompativel, "function", "Exporte a verificacao pura do vinculo da empresa da preparacao.");
    const auditoria = auditoriaPreparada();
    assert.equal(empresaPreparacaoCompativel(auditoria, EMPRESA), true);
    assert.equal(empresaPreparacaoCompativel(auditoria, OUTRA_EMPRESA), false);

    delete auditoria.conta_azul.empresa_id;
    assert.equal(empresaPreparacaoCompativel(auditoria, EMPRESA), false, "Preparacao sem empresa vinculada nao pode ser confirmada.");
});

test("token cobre todo o snapshot relevante da auditoria, empresa e previa", async (t) => {
    const casos = [
        ["empresa da preparacao", (a) => { a.conta_azul.empresa_id = OUTRA_EMPRESA; }],
        ["hash da imagem", (a) => { a.rastreabilidade.sha256 = "b".repeat(64); }],
        ["valor local", (a) => { a.ocr.valor = 45; }],
        ["data local", (a) => { a.ocr.data = "2026-07-28"; }],
        ["CNPJ local", (a) => { a.ocr.cnpj = "11.111.111/0001-11"; }],
        ["fornecedor local", (a) => { a.ocr.fornecedor = "Outro fornecedor"; }],
        ["tipo local", (a) => { a.classificacao.tipo = "hospedagem"; }],
        ["categoria local", (a) => { a.classificacao.categoria_id = "7ea38a33-8357-41cc-bdf5-6bba6b1a4612"; }],
        ["centro local", (a) => { a.classificacao.centro_custo_id = "43a40a34-8f89-11f1-8cae-0b3dbe3e2005"; }],
        ["tipo da previa", (a) => { a.conta_azul.previa.tipo = "RECEITA"; }],
        ["valor da previa", (a) => { a.conta_azul.previa.valor = 45; }],
        ["data da previa", (a) => { a.conta_azul.previa.data_competencia = "2026-07-28"; }],
        ["fornecedor da previa", (a) => { a.conta_azul.previa.fornecedor.documento = "11111111000111"; }],
        ["descricao da previa", (a) => { a.conta_azul.previa.descricao = "Descricao alterada"; }],
        ["observacao da previa", (a) => { a.conta_azul.previa.observacao = "Observacao alterada"; }],
        ["vencimento da parcela", (a) => { a.conta_azul.previa.parcelas[0].data_vencimento = "2026-07-28"; }],
        ["metodo da parcela", (a) => { a.conta_azul.previa.parcelas[0].metodo_pagamento = "PIX_PAGAMENTO_INSTANTANEO"; }],
        ["parcelas da previa", (a) => { a.conta_azul.previa.parcelas[0].valor_bruto = 43; }],
    ];

    for (const [nome, alterar] of casos) {
        await t.test(nome, () => {
            const original = auditoriaPreparada();
            const tokenOriginal = tokenConfirmacao("nota-piloto", original);
            const alterada = structuredClone(original);
            alterar(alterada);
            assert.notEqual(tokenConfirmacao("nota-piloto", alterada), tokenOriginal, `${nome} precisa invalidar a confirmacao anterior.`);
        });
    }
});

test("somente um piloto pode permanecer ativo antes da liberacao do lote", () => {
    assert.equal(typeof avaliarControlePiloto, "function", "Exporte a regra pura de exclusividade do piloto.");
    const fila = [{
        base: "nota-a",
        conta_azul: { status: "PREPARACAO_AGENDADA", empresa_id: EMPRESA },
    }];

    const concorrente = avaliarControlePiloto({
        itens: fila,
        base: "nota-b",
        empresaId: EMPRESA,
        loteLiberado: false,
    });
    assert.equal(concorrente.permitido, false);
    assert.equal(concorrente.piloto_ativo, "nota-a");

    const outraEmpresa = avaliarControlePiloto({
        itens: fila,
        base: "nota-b",
        empresaId: OUTRA_EMPRESA,
        loteLiberado: false,
    });
    assert.equal(outraEmpresa.permitido, true, "Pilotos sao isolados por empresa conectada.");
});

test("confirmacao da API nao libera lote sem conferencia manual no ERP", () => {
    assert.equal(typeof loteLiberadoParaEmpresa, "function", "Exporte a regra pura de liberacao do lote.");
    const confirmadoPelaApi = [{
        base: "nota-a",
        conta_azul: { status: "CONFIRMADO", empresa_id: EMPRESA, confirmado_em: "2026-08-07T12:00:00.000Z" },
    }];
    assert.equal(loteLiberadoParaEmpresa(confirmadoPelaApi, EMPRESA), false);

    const conferidoNoErp = structuredClone(confirmadoPelaApi);
    conferidoNoErp[0].conta_azul.status = "PILOTO_VALIDADO_NO_ERP";
    assert.equal(loteLiberadoParaEmpresa(conferidoNoErp, EMPRESA), false, "O estado isolado nao substitui o registro da conferencia.");
    conferidoNoErp[0].conta_azul.validado_no_erp_em = "2026-08-07T12:05:00.000Z";
    assert.equal(loteLiberadoParaEmpresa(conferidoNoErp, EMPRESA), true);
    assert.equal(loteLiberadoParaEmpresa(conferidoNoErp, OUTRA_EMPRESA), false, "Validacao de outra empresa nao libera este lote.");
});

test("estados agendados ou indeterminados nunca ficam elegiveis para reenvio", async (t) => {
    const estados = [
        "PREPARACAO_AGENDADA",
        "PREPARANDO",
        "PREPARACAO_INCERTA",
        "CONFIRMACAO_AGENDADA",
        "CONFIRMANDO",
        "CONFIRMACAO_INCERTA",
        "CONFIRMADO",
        "PILOTO_VALIDADO_NO_ERP",
    ];

    for (const status of estados) {
        await t.test(status, () => {
            const auditoria = auditoriaValida();
            auditoria.conta_azul = { status, empresa_id: EMPRESA };
            const resultado = avaliarProntidao(auditoria, { imagemExiste: true, confiancaMinima: 0.95 });
            assert.equal(resultado.pronto, false, `${status} deve exigir verificacao/continuidade, nunca novo envio.`);
            assert.match(resultado.impedimentos.join(" "), /preparado|enviado|andamento|agendado|incert|verifica/i);
        });
    }
});
