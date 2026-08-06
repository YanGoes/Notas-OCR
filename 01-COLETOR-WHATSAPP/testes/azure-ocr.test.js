"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { analisarDocumento, valorDoTexto, dataDoTexto, nomeFantasiaDoTexto, placaDoTexto, kmDoTexto, itensDosCampos } = require("../src/azure-ocr");

test("usa texto bruto somente quando encontra valor total sem ambiguidade", () => {
    assert.equal(valorDoTexto("SUBTOTAL 20,00\nVALOR TOTAL R$ 25,50\nOBRIGADO"), 25.5);
    assert.equal(valorDoTexto("TOTAL 25,50\nVALOR A PAGAR 30,00"), null);
    assert.equal(dataDoTexto("EMISSAO 04/08/2026"), "2026-08-04");
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
                Total: { valueCurrency: { amount: 25.5 }, confidence: 0.98 },
            } }],
        } });
    };
    try {
        const resultado = await analisarDocumento(imagem, 10);
        assert.equal(resultado.fornecedor, "POSTO TESTE");
        assert.equal(resultado.cnpj, "12345678000190");
        assert.equal(resultado.valor, 25.5);
        assert.equal(resultado.data, "2026-08-04");
    } finally {
        global.fetch = fetchOriginal;
        delete process.env.AZURE_DOCUMENT_ENDPOINT;
        delete process.env.AZURE_DOCUMENT_KEY;
        delete process.env.AZURE_DOCUMENT_MODEL_ID;
        fs.rmSync(pasta, { recursive: true, force: true });
    }
});
