"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolverHospedagem, descricaoHospedagem, diariasDoTexto, diariasDosItens, eFreelancer, conferirValor } = require("../src/hospedagem");
const { interpretarLegenda } = require("../src/legenda");
const { classificar } = require("../src/classificador");
const { validar } = require("../src/validador");
const { descricaoContaAzul } = require("../src/detalhes-despesa");
const regras = require("../configuracao/regras.json");

const config = regras.hospedagem;

test("descricao segue o padrao pessoas/diarias com barra", () => {
    assert.equal(descricaoHospedagem(2, 1), "HOSPEDAGEM - 2 PESSOAS/1 DIÁRIA");
    assert.equal(descricaoHospedagem(3, 4), "HOSPEDAGEM - 3 PESSOAS/4 DIÁRIAS");
    assert.equal(descricaoHospedagem(1, 1), "HOSPEDAGEM - 1 PESSOA/1 DIÁRIA");
});

test("degrada sem inventar quando falta uma das quantidades", () => {
    assert.equal(descricaoHospedagem(2, null), "HOSPEDAGEM - 2 PESSOAS");
    assert.equal(descricaoHospedagem(null, 3), "HOSPEDAGEM - 3 DIÁRIAS");
    assert.equal(descricaoHospedagem(null, null), "HOSPEDAGEM");
    assert.equal(descricaoHospedagem(0, 0), "HOSPEDAGEM");
});

test("le diarias de quantidade escrita no documento", () => {
    assert.equal(diariasDoTexto("HOSPEDAGEM 3 DIARIAS", "2026").diarias, 3);
    assert.equal(diariasDoTexto("Diarias: 5", "2026").diarias, 5);
    assert.equal(diariasDoTexto("2 NOITES", "2026").diarias, 2);
    assert.equal(diariasDoTexto("1 diaria", "2026").diarias, 1);
});

test("deriva diarias de check-in e check-out", () => {
    const r = diariasDoTexto("CHECK-IN: 05/08/2026\nCHECK-OUT: 08/08/2026", "2026");
    assert.equal(r.diarias, 3);
    assert.equal(r.origem, "check_in_check_out");
    assert.equal(diariasDoTexto("Entrada 10/08/2026 Saida 11/08/2026", "2026").diarias, 1);
});

test("deriva diarias de periodo, herdando o ano quando falta", () => {
    const r = diariasDoTexto("Periodo: 22/08 a 26/08", "2026");
    assert.equal(r.diarias, 4);
    assert.equal(r.origem, "periodo_no_texto");
});

test("recusa periodo invertido ou absurdo", () => {
    assert.equal(diariasDoTexto("CHECK-IN 10/08/2026 CHECK-OUT 08/08/2026", "2026"), null);
    assert.equal(diariasDoTexto("CHECK-IN 01/01/2026 CHECK-OUT 01/06/2026", "2026"), null);
    assert.equal(diariasDoTexto("CHECK-IN 31/02/2026 CHECK-OUT 03/03/2026", "2026"), null);
    assert.equal(diariasDoTexto("CHECK-IN 31/04/2026 CHECK-OUT 02/05/2026", "2026"), null);
    assert.equal(diariasDoTexto("sem nada aqui", "2026"), null);
});

test("infere virada de ano somente quando o ano final nao foi impresso", () => {
    assert.equal(diariasDoTexto("Periodo: 30/12 a 02/01", "2026").diarias, 3);
    assert.equal(diariasDoTexto("CHECK-IN 31/12/2026 CHECK-OUT 02/01", "2026").diarias, 2);
    assert.equal(diariasDoTexto("30/12/2026 a 02/01/2026", "2026"), null);
});

test("le diarias do item do documento", () => {
    assert.equal(diariasDosItens([{ descricao: "DIARIA APTO DUPLO", quantidade: 2, unidade: "DIARIA" }]).diarias, 2);
    assert.equal(diariasDosItens([{ descricao: "Hospedagem apto 302", quantidade: 3, unidade: "UN" }]).diarias, 3);
    assert.equal(diariasDosItens([{ descricao: "AGUA MINERAL", quantidade: 2, unidade: "UN" }]), null);
});

test("a legenda tem prioridade sobre o documento", () => {
    const r = resolverHospedagem({ pessoas: 2, diarias: 1, ocr: { texto_bruto: "CHECK-IN 05/08/2026 CHECK-OUT 09/08/2026", data: "2026-08-05" }, config });
    assert.equal(r.diarias, 1);
    assert.equal(r.diarias_origem, "legenda");
});

test("sem legenda cai no check-in do documento", () => {
    const r = resolverHospedagem({ pessoas: 2, ocr: { texto_bruto: "CHECK-IN 05/08/2026 CHECK-OUT 07/08/2026", data: "2026-08-05" }, config });
    assert.equal(r.diarias, 2);
    assert.equal(r.diarias_origem, "check_in_check_out");
    assert.equal(r.descricao, "HOSPEDAGEM - 2 PESSOAS/2 DIÁRIAS");
});

test("reconhece pagamento de freelancer disfarcado de diaria", () => {
    for (const texto of ["Diaria Freelancer - Adonis", "Mao de obra - Wendel", "Freelancer Batedor", "Servicos de Digitacao"]) {
        assert.equal(eFreelancer(texto), true, `nao pegou "${texto}"`);
    }
    for (const texto of ["Hospedagem hotel Ibis", "Diaria - 2 pessoas", "Pousada do Sol"]) {
        assert.equal(eFreelancer(texto), false, `falso positivo em "${texto}"`);
    }
});

test("diaria isolada no OCR nao e suficiente para inventar hospedagem", () => {
    const generica = classificar(interpretarLegenda(""), {
        valor: 1100,
        data: "2026-08-07",
        confianca: 0.99,
        texto_bruto: "PAGAMENTO DE 10 DIARIAS A JOAO",
    });
    assert.equal(generica.tipo_reconhecido, null);

    const hotel = classificar(interpretarLegenda(""), {
        valor: 220,
        data: "2026-08-07",
        confianca: 0.99,
        texto_bruto: "DIARIA APTO DUPLO HOTEL CENTRAL",
    });
    assert.equal(hotel.tipo_reconhecido.nome, "hospedagem");
});

test("procura freelancer no texto bruto e nos itens do documento", () => {
    const textoBruto = resolverHospedagem({
        pessoas: 1,
        diarias: 1,
        ocr: { texto_bruto: "RECIBO DE SERVICOS DE DIGITACAO - FREELANCER", valor: 110 },
        config,
    });
    assert.equal(textoBruto.freelancer, true);

    const item = resolverHospedagem({
        pessoas: 1,
        diarias: 1,
        ocr: { itens: [{ descricao: "DIARIA BATEDOR", quantidade: 1, unidade: "UN" }], valor: 110 },
        config,
    });
    assert.equal(item.freelancer, true);

    const operador = interpretarLegenda("Tipo: Hospedagem\nCentro de custo: CONSOL MG-050\nDiarias: 1");
    const ocr = { valor: 110, data: "2026-08-07", confianca: 0.99, texto_bruto: "PAGAMENTO FREELANCER BATEDOR" };
    const classificacao = classificar(operador, ocr);
    const validacao = validar({ operador, classificacao, regras, duplicado: false, ocr });
    assert.equal(validacao.bloqueado, true);
});

test("confere o valor contra pessoas x diarias x referencia", () => {
    assert.equal(conferirValor({ valor: 230, pessoas: 2, diarias: 1, referencia: 110 }).coerente, true);
    assert.equal(conferirValor({ valor: 1800, pessoas: 3, diarias: 6, referencia: 110 }).coerente, true);
    assert.equal(conferirValor({ valor: 5000, pessoas: 2, diarias: 1, referencia: 110 }).coerente, false);
    assert.equal(conferirValor({ valor: 230, pessoas: null, diarias: 1, referencia: 110 }), null);
});

test("usa a tolerancia de hospedagem configurada", () => {
    const estrita = resolverHospedagem({
        pessoas: 2, diarias: 1, ocr: { valor: 300 },
        config: { valor_referencia_diaria: 110, tolerancia_valor_referencia: 0.1 },
    });
    const ampla = resolverHospedagem({
        pessoas: 2, diarias: 1, ocr: { valor: 300 },
        config: { valor_referencia_diaria: 110, tolerancia_valor_referencia: 0.6 },
    });
    assert.equal(estrita.valor.tolerancia, 0.1);
    assert.equal(estrita.valor.coerente, false);
    assert.equal(ampla.valor.coerente, true);
});

test("hospedagem completa vira categoria e descricao do Conta Azul", () => {
    const legenda = "Tipo: Hospedagem\nCentro de custo: CONSOL MG-050\nPessoas: 2\nDiarias: 1";
    const operador = interpretarLegenda(legenda);
    assert.equal(operador.diarias, 1);
    const ocr = { valor: 230, data: "2026-08-07", confianca: 0.99, texto_bruto: "HOTEL IBIS GOIANIA" };
    const classificacao = classificar(operador, ocr);
    assert.equal(classificacao.tipo_reconhecido.nome, "hospedagem");
    assert.equal(classificacao.categoria_nome, "HOSPEDAGEM");
    assert.equal(descricaoContaAzul({ legenda, ocr, classificacao }), "HOSPEDAGEM - 2 PESSOAS/1 DIÁRIA");
});

test("hospedagem sem diarias vai para revisao mas mantem a descricao parcial", () => {
    const operador = interpretarLegenda("Tipo: Hospedagem\nCentro de custo: CONSOL MG-050\nPessoas: 2");
    const ocr = { valor: 240, data: "2026-08-07", confianca: 0.99 };
    const classificacao = classificar(operador, ocr);
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr });
    assert.equal(classificacao.hospedagem.descricao, "HOSPEDAGEM - 2 PESSOAS");
    assert.match(resultado.motivos.join(" "), /diarias nao informada/);
    assert.equal(resultado.bloqueado, false);
});

test("freelancer e BLOQUEADO, nao apenas revisado", () => {
    const operador = interpretarLegenda("Tipo: Diaria\nCentro de custo: CONSOL MG-050\nObservacao: Freelancer Daniel batedor");
    const ocr = { valor: 1100, data: "2026-08-07", confianca: 0.99 };
    const classificacao = classificar(operador, ocr);
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr });
    assert.equal(classificacao.hospedagem.freelancer, true);
    assert.equal(resultado.bloqueado, true);
    assert.match(resultado.motivos.join(" "), /DIARIA - FREELANCER/);
});

test("valor incoerente com pessoas x diarias vai para revisao", () => {
    const operador = interpretarLegenda("Tipo: Hospedagem\nCentro de custo: CONSOL MG-050\nPessoas: 2\nDiarias: 1");
    const ocr = { valor: 4800, data: "2026-08-07", confianca: 0.99 };
    const classificacao = classificar(operador, ocr);
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr });
    assert.match(resultado.motivos.join(" "), /nao fecha com 2 pessoa\(s\) x 1 diaria\(s\)/);
});

test("diarias da legenda diferentes do documento vao para revisao", () => {
    const operador = interpretarLegenda("Tipo: Hospedagem\nCentro de custo: CONSOL MG-050\nPessoas: 2\nDiarias: 1");
    const ocr = { valor: 220, data: "2026-08-07", confianca: 0.99, texto_bruto: "HOSPEDAGEM 3 DIARIAS" };
    const classificacao = classificar(operador, ocr);
    const resultado = validar({ operador, classificacao, regras, duplicado: false, ocr });
    assert.equal(classificacao.hospedagem.diarias, 1);
    assert.equal(classificacao.hospedagem.diarias_documento, 3);
    assert.match(resultado.motivos.join(" "), /Quantidade de diarias da legenda/);
});

test("refeicao nao ganha bloco de hospedagem e vice-versa", () => {
    const almoco = classificar(interpretarLegenda("Tipo: Almoco\nPessoas: 2"), { valor: 70, data: "2026-08-07", hora: "12:30", confianca: 0.99 });
    assert.equal(almoco.hospedagem, null);
    const hosp = classificar(interpretarLegenda("Tipo: Hospedagem\nPessoas: 2\nDiarias: 1"), { valor: 230, data: "2026-08-07", confianca: 0.99 });
    assert.equal(hosp.refeicao, null);
});
