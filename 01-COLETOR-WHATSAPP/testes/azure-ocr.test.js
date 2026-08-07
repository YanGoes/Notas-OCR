"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    analisarDocumento, valorCampo, valorDoTexto, detalhesValorDoTexto, dataDoTexto,
    horaDoTexto, nomeFantasiaDoTexto, placaDoTexto, kmDoTexto, itensDosCampos, cnpjDoTexto,
    fornecedorDoTexto, enderecoDoCampo, dadosChaveFiscalDoTexto, normalizarResultadoAzure,
} = require("../src/azure-ocr");

test("usa texto bruto somente quando encontra valor total sem ambiguidade", () => {
    assert.equal(valorDoTexto("SUBTOTAL 20,00\nVALOR TOTAL R$ 25,50\nOBRIGADO"), 25.5);
    assert.equal(valorDoTexto("TOTAL 25,50\nVALOR A PAGAR 30,00"), null);
    assert.equal(dataDoTexto("EMISSAO 04/08/2026"), "2026-08-04");
    assert.equal(valorDoTexto("COMPRA CREDITO MASTERCARD\n23/JUL/2026\nR$65.00\nTOTAL R$"), 65);
    assert.equal(valorDoTexto("VALOR TOTAL R$\n90,99\nTributos aproximados R$ 8,20"), 90.99);
    assert.deepEqual(detalhesValorDoTexto("COMPRA CREDITO\nR$65.00\nTributos R$ 4,00"), {
        valor: 65, confianca: 0.95, origem: "valor_com_cifrao_unico",
    });
});

test("rejeita data estruturada incompleta e recupera a data fiscal do texto", () => {
    assert.equal(valorCampo({ type: "date", content: "29/07/:" }), null);
    assert.equal(valorCampo({ type: "date", content: "29/07/26" }), "2026-07-29");
    assert.equal(dataDoTexto("27/07/2021 · 18:01\nNFC-e Data de emissão: 27/07/2026 18:06\nData de autorização: 27/07/2026"), "2026-07-27");
});

test("recupera horario do texto e registra sua origem quando o campo estruturado falta", () => {
    assert.equal(horaDoTexto("EMISSAO 08/08/2026 09h07\nTOTAL R$ 25,00"), "09:07");
    const bruto = { analyzeResult: {
        content: "EMISSAO 08/08/2026 09h07\nVALOR TOTAL R$ 25,00",
        documents: [{ confidence: 0.99, fields: {
            TransactionDate: { type: "date", valueDate: "2026-08-08", confidence: 0.99 },
            Total: { type: "currency", valueCurrency: { amount: 25 }, confidence: 0.99 },
        } }],
    } };
    const resultado = normalizarResultadoAzure(bruto);
    assert.equal(resultado.hora, "09:07");
    assert.deepEqual(resultado.hora_candidatos, ["09:07"]);
    assert.equal(resultado.hora_origem, "heuristica_texto_azure");
});

test("separa adquirente do fornecedor e associa o CNPJ ao estabelecimento", () => {
    const textoStone = [
        "stone",
        "PANIFICADORA E CONFEITARIA JK LTDA ME - CNPJ:",
        "20.603.589/0001-20",
        "AV JK QD 10 LT 06, SN, PQ DAS AMERICAS",
        "Neropolis, GO",
    ].join("\n");
    assert.equal(fornecedorDoTexto(textoStone, "stone"), "PANIFICADORA E CONFEITARIA JK LTDA ME");
    assert.equal(cnpjDoTexto(textoStone, "PANIFICADORA E CONFEITARIA JK LTDA ME"), "20603589000120");

    const textoDoisCnpjs = [
        "CNPJ 33 031 390/0001-16",
        "RIBEIRAD PRETO/SP",
        "MESA & FORNO ALIMENTACAO LTDA",
        "CNPJ. 64 121.659/0001-89",
    ].join("\n");
    assert.equal(cnpjDoTexto(textoDoisCnpjs, "MESA & FORNO ALIMENTACAO LTDA"), "64121659000189");
});

test("usa o prefixo da chave NFC-e para identificar CNPJ e UF fiscais", () => {
    const chaveSpTruncada = dadosChaveFiscalDoTexto("CHAVE DE ACESSO\n3526 0764 1216 5900 0189 6500 1000 0000 6818 6957");
    assert.equal(chaveSpTruncada.cnpj, "64121659000189");
    assert.equal(chaveSpTruncada.estado, "SP");
    assert.equal(chaveSpTruncada.ano_mes, "2026-07");
    assert.equal(chaveSpTruncada.chave, null);

    const brutoComChaveCorrompida = { analyzeResult: {
        content: [
            "stone", "PANIFICADORA E CONFEITARIA JK LTDA ME - CNPJ:", "20.603.589/0001-20",
            "Neropolis, GO", "VALOR TOTAL R$\n44,00", "NFC-e 27/07/2026",
            "CHAVE DE ACESSO", "6226 0720 6036 8900 0120 6500 1000 0149 3610 0464 0323",
            "Data de autorização: 27/07/2026",
        ].join("\n"),
        documents: [{ confidence: 0.994, fields: {
            MerchantName: { type: "string", valueString: "stone", confidence: 0.736 },
            MerchantAddress: { type: "address", valueAddress: { road: "Gois\nAV JK QD 10 LT 06", city: "Neropolis", state: "GO" } },
            TransactionDate: { type: "date", valueDate: "2026-07-27", confidence: 0.949 },
            Total: { type: "currency", valueCurrency: { amount: 44 }, confidence: 0.938 },
        } }],
    } };
    const resultado = normalizarResultadoAzure(brutoComChaveCorrompida);
    assert.equal(resultado.fornecedor, "PANIFICADORA E CONFEITARIA JK LTDA ME");
    assert.equal(resultado.cnpj, "20603589000120");
    assert.equal(resultado.cnpj_origem, "chave_fiscal_nfce_reconciliada");
    assert.equal(resultado.endereco.rua, "AV JK QD 10 LT 06");
    assert.equal(resultado.confianca, 0.96);
});

test("nao confunde o final de Ribeirao Preto com a UF TO", () => {
    const endereco = enderecoDoCampo({ valueAddress: {
        road: "Avenida Doutor Celso Charun",
        city: "Ribeirão Preto",
    } }, "CNPJ 33 031 390/0001-16\nRIBEIRAD PRETO/SP\nInformação dos Tributos Totais");
    assert.deepEqual(endereco, {
        rua: "Avenida Doutor Celso Charun", cidade: "Ribeirão Preto", estado: "SP", cep: null,
    });
});

test("normaliza os campos dos comprovantes reais com dois documentos na foto", () => {
    const bruto = { analyzeResult: {
        modelId: "prebuilt-receipt",
        content: [
            "VIA CLIENTE\nR$90,99\nCNPJ 33 031 390/0001-16\nRIBEIRAD PRETO/SP",
            "MESA & FORNO ALIMENTACAO LTDA\nCNPJ. 64 121.659/0001-89",
            "Pedido numero 050 29/07/2026\nNFC-e Data de emissão: 29/07/2026 22:52",
        ].join("\n"),
        documents: [{ docType: "receipt.retailMeal", confidence: 0.984, fields: {
            MerchantName: { type: "string", valueString: "MESA & FORNO ALIMENTACAO LTDA", confidence: 0.931 },
            MerchantAddress: { type: "address", valueAddress: { road: "Avenida Doutor Celso Charun", city: "Ribeirão Preto", state: "TO" } },
            TransactionDate: { type: "date", content: "29/07/:", confidence: 0.956 },
            Total: { type: "currency", content: "R$", confidence: 0.598 },
            ReceiptType: { type: "string", valueString: "Meal", confidence: 0.984 },
        } }],
    } };
    bruto.analyzeResult.content += "\nCHAVE DE ACESSO\n3526 0764 1216 5900 0189 6500 1000 0000 6818 6957";
    const resultado = normalizarResultadoAzure(bruto);
    assert.equal(resultado.fornecedor, "MESA & FORNO ALIMENTACAO LTDA");
    assert.equal(resultado.cnpj, "64121659000189");
    assert.deepEqual(resultado.endereco, {
        rua: "Avenida Doutor Celso Charun", cidade: "Ribeirão Preto", estado: "SP", cep: null,
    });
    assert.equal(resultado.data, "2026-07-29");
    assert.equal(resultado.data_origem, "heuristica_texto_azure");
    assert.equal(resultado.valor, 90.99);
    assert.equal(resultado.confianca, 0.95);
});

test("aproveita detalhes de abastecimento que o Azure leu", () => {
    const texto = "CNPJ: 02.084.283/0001-22\nOSTO ALVORADA\nNEROPOLIS GO\nDIESEL S10 ADITIVADO\nPlaca: REP-7B39 Km: 213624";
    assert.equal(nomeFantasiaDoTexto(texto, "MARQUEZ E CUNHA LTDA"), "POSTO ALVORADA");
    assert.equal(placaDoTexto(texto), "REP-7B39");
    assert.equal(kmDoTexto(texto), 213624);
    const itens = itensDosCampos({ Items: { valueArray: [{ confidence: 0.98, valueObject: {
        Description: { valueString: "DIESEL S10 ADITIVADO" }, Quantity: { valueNumber: 38.401 },
        QuantityUnit: { valueString: "LT" }, Price: { valueCurrency: { amount: 6.54 } },
    } }] } });
    assert.deepEqual(itens[0], { descricao: "DIESEL S10 ADITIVADO", codigo: null, quantidade: 38.401, unidade: "LT", valor_unitario: 6.54, valor_total: null, confianca: 0.98 });
});

test("envia documento, consulta operacao e normaliza recibo Azure", async () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "azure-ocr-test-"));
    const imagem = path.join(pasta, "recibo.jpg");
    fs.writeFileSync(imagem, Buffer.from([1, 2, 3]));
    const fetchOriginal = global.fetch;
    process.env.AZURE_DOCUMENT_ENDPOINT = "https://teste.cognitiveservices.azure.com";
    process.env.AZURE_DOCUMENT_KEY = "chave-teste";
    process.env.AZURE_DOCUMENT_MODEL_ID = "prebuilt-receipt";
    let chamadas = 0;
    global.fetch = async () => {
        chamadas += 1;
        if (chamadas === 1) return new Response(null, { status: 202, headers: { "operation-location": "https://operacao/1" } });
        return Response.json({ status: "succeeded", analyzeResult: {
            content: "POSTO TESTE CNPJ 12.345.678/0001-90 TOTAL 25,50",
            documents: [{ confidence: 0.98, fields: {
                MerchantName: { valueString: "POSTO TESTE", confidence: 0.99 },
                TransactionDate: { valueDate: "2026-08-04", confidence: 0.99 },
                Total: { type: "currency", valueCurrency: { amount: 25.5 }, confidence: 0.98 },
                ReceiptType: { valueString: "Gas", confidence: 0.97 },
            } }],
        } });
    };
    try {
        const resultado = await analisarDocumento(imagem, 10);
        assert.equal(resultado.fornecedor, "POSTO TESTE");
        assert.equal(resultado.cnpj, "12345678000190");
        assert.equal(resultado.valor, 25.5);
        assert.equal(resultado.data, "2026-08-04");
        assert.equal(resultado.tipo_despesa_sugerido, "combustivel");
    } finally {
        global.fetch = fetchOriginal;
        delete process.env.AZURE_DOCUMENT_ENDPOINT;
        delete process.env.AZURE_DOCUMENT_KEY;
        delete process.env.AZURE_DOCUMENT_MODEL_ID;
        fs.rmSync(pasta, { recursive: true, force: true });
    }
});
