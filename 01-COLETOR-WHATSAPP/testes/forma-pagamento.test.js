"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { formaPagamentoDoTexto, placaDoTexto, litragemDoTexto } = require("../src/azure-ocr");
const { validar } = require("../src/validador");
const { descricaoContaAzul } = require("../src/detalhes-despesa");

// Texto real de um cupom fiscal de restaurante: o campo fiscal diz debito,
// mas o resumo do POS logo abaixo diz "BK BANK CREDITO" (tipo de liquidacao
// do adquirente, nao a forma como o cliente pagou).
const CUPOM_DEBITO = `PARADA PENHA PONTA GROSSA LTDA
CNPJ: 43.746.248/0001-09
QTD TOTAL DE ITENS 2
VALOR TOTAL R$ 218,00
FORMA PAGAMENTO VALOR PAGO R$
Cartão de Debito 218,00
Troco R$ 0,00
RESUMO PAGAMENTO:
- CARTAO DEBITO: R$ 218,00
RESUMO POS:
- BK BANK CREDITO: R$ 218,00`;

// Cupom de posto com comprovante de cartao grampeado junto: o fiscal diz
// dinheiro, o comprovante diz credito. Conflito real, nao pode ser chutado.
const CUPOM_DIVERGENTE = `Getnet Via Cliente MASTERCARD
04/05/26 15:05:20 ****9482
CREDITO R$ 354,94
CNPJ: 30.025.773/0001-93 PSJ SAO SIMAO COMERCIO DE COMBUSTIVEIS
001 2 GASOLINA COMUM 53,861 L X 6,590 354,94
Valor total R$ 354,94
FORMA DE PAGAMENTO VALOR PAGO RS
Dinheiro 354,94
Placa: OVN5J98 KM: 298050`;

const CUPOM_PIX = `POSTO TESTE LTDA
GASOLINA ADITIVADA 20,026 LT X 5,89
VALOR TOTAL 117,95
FORMA DE PAGAMENTO
PIX 117,95
ABC1D23`;

test("le a forma de pagamento do campo fiscal e ignora o resumo do POS", () => {
    const forma = formaPagamentoDoTexto(CUPOM_DEBITO);
    assert.equal(forma.codigo, "CARTAO_DEBITO");
    assert.equal(forma.evidencia, "campo_fiscal");
});

test("nao escolhe sozinho quando o cupom e o comprovante de cartao discordam", () => {
    const forma = formaPagamentoDoTexto(CUPOM_DIVERGENTE);
    assert.equal(forma.codigo, null);
    assert.equal(forma.evidencia, "divergente");
    assert.deepEqual(forma.candidatos.sort(), ["CARTAO_CREDITO", "DINHEIRO"]);
    assert.equal(forma.bandeira, "MASTERCARD");
    assert.equal(forma.adquirente, "GETNET");
});

test("reconhece pix, dinheiro, boleto e transferencia", () => {
    assert.equal(formaPagamentoDoTexto(CUPOM_PIX).codigo, "PIX");
    assert.equal(formaPagamentoDoTexto("FORMA DE PAGAMENTO\nDinheiro 50,00").codigo, "DINHEIRO");
    assert.equal(formaPagamentoDoTexto("FORMA DE PAGAMENTO\nBoleto 50,00").codigo, "BOLETO");
    assert.equal(formaPagamentoDoTexto("FORMA DE PAGAMENTO\nTransferencia 50,00").codigo, "TRANSFERENCIA");
});

test("comprovante sem forma de pagamento legivel nao inventa um metodo", () => {
    const forma = formaPagamentoDoTexto("PADARIA CENTRAL\nVALOR TOTAL R$ 12,00");
    assert.equal(forma.codigo, null);
    assert.equal(forma.evidencia, null);
    assert.deepEqual(forma.candidatos, []);
});

test("le a placa com e sem o rotulo 'Placa:'", () => {
    assert.equal(placaDoTexto(CUPOM_DIVERGENTE), "OVN-5J98");
    assert.equal(placaDoTexto(CUPOM_PIX), "ABC-1D23", "placa Mercosul sem rotulo");
    assert.equal(placaDoTexto("Placa: ABC1234"), "ABC-1234", "placa antiga com rotulo");
});

test("nao arrisca uma placa quando ha mais de um candidato sem rotulo", () => {
    assert.equal(placaDoTexto("SERIE ABC1D23 PROTOCOLO XYZ9K88"), null);
});

test("le a litragem do texto quando o Azure nao devolve o item estruturado", () => {
    assert.equal(litragemDoTexto(CUPOM_DIVERGENTE), 53.861);
    assert.equal(litragemDoTexto(CUPOM_PIX), 20.026);
    assert.equal(litragemDoTexto("REFRIGERANTE COCA COLA LITRO\n2,000 UN 10,00"), null, "descricao de produto nao e litragem");
});

test("forma de pagamento incerta manda o documento para revisao com o motivo explicito", () => {
    const resultado = validar({
        operador: { centro_custo_informado: "CONSOL MG-050" },
        ocr: { valor: 354.94, data: "2026-05-04", confianca: 0.99 },
        classificacao: { tipo_reconhecido: { nome: "alimentacao" }, categoria_id: "uuid-1", centro_custo_id: "uuid-2" },
        regras: { confianca_minima: 0.94, tolerancia_valor: 0.05 },
        duplicado: false,
        pagamento: { codigo: null, incerto: true, candidatos: ["DINHEIRO", "CARTAO_CREDITO"] },
    });
    assert.equal(resultado.bloqueado, false);
    assert.equal(resultado.revisao_necessaria, true);
    assert.match(resultado.motivos.join(" "), /Forma de pagamento incerta.*dinheiro ou credito/i);
});

test("forma de pagamento resolvida entra na descricao enviada ao Conta Azul", () => {
    const descricao = descricaoContaAzul({
        legenda: "Tipo: Alimentacao",
        ocr: {},
        classificacao: { tipo: "alimentacao" },
        pagamento: { codigo: "CARTAO_DEBITO", conta_cartao: "Inter" },
    });
    assert.match(descricao, /Pagamento: Cartao de debito \(Inter\)/);
});

// ---------------------------------------------------------------------------
// Casos reais observados em campo (13/08/2026)
// ---------------------------------------------------------------------------

const { interpretarLegenda, placaDaLegenda } = require("../src/legenda");
const { classificar } = require("../src/classificador");

test("le a placa escrita na legenda sem o formato 'Veiculo:'", () => {
    // Legenda real que o programa ignorou por completo antes da correcao
    const operador = interpretarLegenda("Abastecimento\nCONSOL MG-050\nPlaca JKM0I96\n15/02/25");
    assert.equal(operador.veiculo_informado, "JKM0I96");
    assert.equal(placaDaLegenda("placa: abc1d23"), "ABC1D23", "aceita minusculo e dois-pontos");
    assert.equal(placaDaLegenda("Veiculo RLQ-4C16"), "RLQ4C16", "aceita hifen");
    assert.equal(placaDaLegenda("Almoco CONSOL MG-050"), null, "centro de custo nao pode virar placa");
});

test("reconhece o tipo escrito solto na legenda, sem 'Tipo:'", () => {
    const semOcr = { produto_principal: null, nome_fantasia: null, texto_bruto: "" };
    const abastecimento = classificar(interpretarLegenda("Abastecimento\nCONSOL MG-050\nPlaca JKM0I96"), semOcr);
    assert.equal(abastecimento.tipo_reconhecido?.nome, "combustivel");
    assert.equal(abastecimento.tipo_origem, "legenda_texto_livre");
    assert.equal(abastecimento.veiculo?.placa, "JKM0I96", "a placa da legenda identifica o veiculo");

    // Refeicoes tem tipo proprio: "Janta" vai para Refeicao - Jantar, e nao
    // para a categoria generica de lanches.
    const janta = classificar(interpretarLegenda("Janta\nCONSOL MG-050"), semOcr);
    assert.equal(janta.tipo_reconhecido?.nome, "jantar");
    assert.equal(janta.categoria_nome, "JANTAR");
});

test("data lida no futuro vai para revisao em vez de virar competencia errada", () => {
    const futuro = new Date();
    futuro.setFullYear(futuro.getFullYear() + 9);
    const resultado = validar({
        operador: { centro_custo_informado: "CONSOL MG-050" },
        ocr: { valor: 204.11, data: futuro.toISOString().slice(0, 10), confianca: 0.99 },
        classificacao: { tipo_reconhecido: { nome: "alimentacao" }, categoria_id: "uuid-1", centro_custo_id: "uuid-2" },
        regras: { confianca_minima: 0.94, tolerancia_valor: 0.05 },
        duplicado: false,
    });
    assert.equal(resultado.revisao_necessaria, true);
    assert.match(resultado.motivos.join(" "), /esta no futuro/i);
});

test("data de hoje continua sendo aceita normalmente", () => {
    const resultado = validar({
        operador: { centro_custo_informado: "CONSOL MG-050" },
        ocr: { valor: 44, data: new Date().toISOString().slice(0, 10), confianca: 0.99 },
        classificacao: { tipo_reconhecido: { nome: "alimentacao" }, categoria_id: "uuid-1", centro_custo_id: "uuid-2" },
        regras: { confianca_minima: 0.94, tolerancia_valor: 0.05 },
        duplicado: false,
    });
    assert.equal(resultado.motivos.filter((m) => /futuro/i.test(m)).length, 0);
});

const { localizarVeiculo, normalizarPlaca } = require("../src/classificador");

test("aceita placa antiga e Mercosul, com rotulo explicito e sem", () => {
    // Padrao antigo: ABC1234
    assert.equal(placaDaLegenda("Placa: ABC1234"), "ABC1234");
    assert.equal(placaDaLegenda("placa abc1234"), "ABC1234");
    assert.equal(placaDaLegenda("Veiculo ABC-1234"), "ABC1234");
    assert.equal(placaDaLegenda("Abastecimento ABC1234 CONSOL"), "ABC1234", "sem rotulo nenhum");

    // Padrao Mercosul: ABC1D23
    assert.equal(placaDaLegenda("Placa: JKM0I96"), "JKM0I96");
    assert.equal(placaDaLegenda("placa jkm0i96"), "JKM0I96");
    assert.equal(placaDaLegenda("Veiculo RLQ-4C16"), "RLQ4C16");
    assert.equal(placaDaLegenda("Abastecimento RLQ4C16 obra"), "RLQ4C16", "sem rotulo nenhum");
});

test("placa lida casa com o cadastro mesmo com hifen, espaco ou caixa diferente", () => {
    const veiculos = [{ nome: "FIAT SCUDO - SGR4B54", placa: "SGR4B54", apelidos: ["scudo"], categoria_id: "cat-1" }];
    for (const escrita of ["SGR4B54", "SGR-4B54", "sgr 4b54", "scudo"]) {
        assert.equal(localizarVeiculo(veiculos, escrita)?.placa, "SGR4B54", `falhou para "${escrita}"`);
    }
    assert.equal(normalizarPlaca("SGR-4B54"), "SGR4B54");
    assert.equal(localizarVeiculo(veiculos, "XXX9Z99"), null, "placa desconhecida nao casa com ninguem");
});

test("nomes de centro de custo e rodovia nunca viram placa", () => {
    for (const texto of ["Almoco CONSOL MG-050", "Janta obra BR-153", "Cafe 4 pessoas", "Hospedagem MG050"]) {
        assert.equal(placaDaLegenda(texto), null, `interpretou placa em "${texto}"`);
    }
});

test("nome do estabelecimento vence o tipo semantico do Azure", () => {
    // Caso real: 6 hoteis foram classificados como alimentacao porque o Azure
    // marca o recibo como "Meal" (por causa do restaurante interno do hotel).
    const comAzureDizendoRefeicao = (fornecedor) => classificar(
        interpretarLegenda("CONSOL MG-050"),
        { fornecedor, nome_fantasia: fornecedor, tipo_despesa_sugerido: "alimentacao", texto_bruto: fornecedor }
    );
    for (const hotel of ["HOTEL DECK RIO", "IRAJA HOTEL", "HOTEL E RESTAURANTE DO JAPAO", "RESTAURANTE E POUSADA IRMAOS"]) {
        const r = comAzureDizendoRefeicao(hotel);
        assert.equal(r.tipo_reconhecido?.nome, "hospedagem", `errou em "${hotel}"`);
        assert.equal(r.tipo_origem, "nome_do_estabelecimento");
    }
    // e nao pode quebrar quem realmente e alimentacao
    assert.equal(comAzureDizendoRefeicao("RESTAURANTE ESTILO MINEIRO").tipo_reconhecido?.nome, "alimentacao");
    assert.equal(comAzureDizendoRefeicao("PANIFICADORA JK").tipo_reconhecido?.nome, "alimentacao");
    assert.equal(comAzureDizendoRefeicao("JUATUBA BATERIAS COMERCIO").tipo_reconhecido?.nome, "manutencao");
});

test("a legenda do operador continua vencendo o nome do estabelecimento", () => {
    // Hotel onde a despesa foi so o almoco: quem estava la sabe, e manda.
    const r = classificar(
        interpretarLegenda("Almoco CONSOL MG-050"),
        { fornecedor: "HOTEL DECK RIO", nome_fantasia: "HOTEL DECK RIO", tipo_despesa_sugerido: "alimentacao", texto_bruto: "HOTEL DECK RIO" }
    );
    assert.equal(r.tipo_reconhecido?.nome, "almoco", "a legenda manda, mesmo sendo um hotel");
    assert.equal(r.tipo_origem, "legenda_texto_livre");
});

test("cada refeicao vai para a sua categoria, e o generico continua existindo", () => {
    const semOcr = { fornecedor: null, nome_fantasia: null, texto_bruto: "" };
    const cat = (legenda) => classificar(interpretarLegenda(legenda), semOcr).categoria_nome;

    assert.equal(cat("Almoco CONSOL MG-050"), "ALMOCO");
    assert.equal(cat("Janta CONSOL MG-050"), "JANTAR");
    assert.equal(cat("Cafe da manha CONSOL MG-050"), "CAFE DA MANHA");
    assert.equal(cat("Pedagio CONSOL MG-050"), "PEDAGIO");
    assert.equal(cat("Estacionamento CONSOL MG-050"), "ESTACIONAMENTO");

    // Sem dizer qual refeicao, cai na categoria generica
    const generico = classificar(interpretarLegenda("CONSOL MG-050"),
        { fornecedor: "RESTAURANTE ESTILO MINEIRO", nome_fantasia: "RESTAURANTE ESTILO MINEIRO", texto_bruto: "RESTAURANTE" });
    assert.equal(generico.categoria_nome, "ALIMENTACAO EM CAMPO");
});
