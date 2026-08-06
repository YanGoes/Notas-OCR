"use strict";

const fs = require("fs");
const path = require("path");
const { carregarEnv } = require("./env");

const RAIZ = path.resolve(__dirname, "..");
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configuracaoAzure() {
    const env = carregarEnv(RAIZ);
    const endpoint = String(env.AZURE_DOCUMENT_ENDPOINT || "").replace(/\/$/, "");
    const key = env.AZURE_DOCUMENT_KEY;
    const modelId = env.AZURE_DOCUMENT_MODEL_ID || "prebuilt-receipt";
    if (!endpoint || !key || endpoint.includes("seu-recurso") || key.startsWith("cole_")) throw new Error("Azure nao configurado: preencha AZURE_DOCUMENT_ENDPOINT e AZURE_DOCUMENT_KEY no .env.");
    return { endpoint, key, modelId, apiVersion: "2024-11-30" };
}

async function fetchComRetry(url, opcoes, tentativas = 5) {
    let ultimoErro;
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
        try {
            const resposta = await fetch(url, opcoes);
            if (resposta.status !== 429 && resposta.status < 500) return resposta;
            const retryAfter = Number(resposta.headers.get("retry-after") || tentativa * 2);
            ultimoErro = new Error(`Azure temporariamente indisponivel (${resposta.status}).`);
            await esperar(Math.min(retryAfter, 30) * 1000);
        } catch (erro) {
            ultimoErro = erro;
            if (tentativa < tentativas) await esperar(tentativa * 2000);
        }
    }
    throw ultimoErro;
}

function valorCampo(campo) {
    if (!campo) return null;
    for (const chave of ["valueString", "valueNumber", "valueDate", "valueTime", "valueCurrency", "content"]) {
        if (campo[chave] !== undefined && campo[chave] !== null) {
            if (chave === "valueCurrency") return campo[chave]?.amount ?? null;
            return campo[chave];
        }
    }
    return null;
}

function confiancaMinima(campos) {
    const confiancas = Object.values(campos || {}).map((campo) => Number(campo?.confidence)).filter(Number.isFinite);
    return confiancas.length ? Math.min(...confiancas) : 0;
}

function cnpjDoTexto(texto) {
    const achado = String(texto || "").match(/\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/]?\d{4}[-\s]?\d{2}\b/);
    return achado ? achado[0].replace(/\D/g, "") : null;
}

function numeroMonetario(texto) {
    const limpo = String(texto).replace(/[^\d,.-]/g, "");
    const normalizado = limpo.includes(",") ? limpo.replace(/\./g, "").replace(",", ".") : limpo;
    const valor = Number(normalizado);
    return Number.isFinite(valor) && valor > 0 ? valor : null;
}

function valorDoTexto(texto) {
    const candidatos = [];
    for (const linha of String(texto || "").split(/\r?\n/)) {
        if (!/(valor\s*(total|a\s*pagar)|\btotal\b\s*(geral|a\s*pagar)?|vlr\s*total)/i.test(linha)) continue;
        const valores = linha.match(/(?:R\$\s*)?\d{1,3}(?:\.\d{3})*,\d{2}|R\$\s*\d+(?:[.,]\d{2})?/gi) || [];
        for (const encontrado of valores) {
            const valor = numeroMonetario(encontrado);
            if (valor !== null) candidatos.push(valor);
        }
    }
    const unicos = [...new Set(candidatos.map((valor) => valor.toFixed(2)))];
    return unicos.length === 1 ? Number(unicos[0]) : null;
}

function dataDoTexto(texto) {
    const match = String(texto || "").match(/\b(\d{2})[\/-](\d{2})[\/-](\d{4})\b/);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function nomeFantasiaDoTexto(texto, fornecedor = "") {
    const linhas = String(texto || "").split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean);
    const padrao = /^(?:p?osto|hotel|pousada|restaurante|churrascaria|padaria|drogaria|farmacia)\b/i;
    let nome = linhas.find((linha) => padrao.test(linha) && linha.toLowerCase() !== String(fornecedor).toLowerCase()) || null;
    if (/^osto\b/i.test(nome || "")) nome = `P${nome}`;
    return nome;
}

function placaDoTexto(texto) {
    const achado = String(texto || "").match(/\bplaca\s*:?\s*([A-Z]{3})[-\s]?([0-9][A-Z0-9][0-9]{2})\b/i);
    return achado ? `${achado[1].toUpperCase()}-${achado[2].toUpperCase()}` : null;
}

function kmDoTexto(texto) {
    const achado = String(texto || "").match(/\bkm\s*:?\s*([\d.]{2,})\b/i);
    return achado ? Number(achado[1].replace(/\D/g, "")) : null;
}

function enderecoDoCampo(campo, texto) {
    const valor = campo?.valueAddress || {};
    const cidadeUf = String(texto || "").match(/\b([A-ZÀ-Ú][A-ZÀ-Ú\s]{2,})\s*[-/]?\s*(GO|DF|MG|SP|RJ|PR|RS|SC|BA|MT|MS|TO|PA|MA|PI|CE|RN|PB|PE|AL|SE|ES|AC|AM|AP|RO|RR)\b/);
    return {
        rua: valor.road || valor.addressLine || null,
        cidade: valor.city || cidadeUf?.[1]?.trim() || null,
        estado: valor.state || cidadeUf?.[2] || null,
        cep: valor.postalCode || null,
    };
}

function itensDosCampos(campos) {
    return (campos.Items?.valueArray || []).map((item) => {
        const objeto = item?.valueObject || {};
        return {
            descricao: valorCampo(objeto.Description),
            codigo: valorCampo(objeto.ProductCode),
            quantidade: valorCampo(objeto.Quantity),
            unidade: valorCampo(objeto.QuantityUnit),
            valor_unitario: valorCampo(objeto.Price),
            valor_total: valorCampo(objeto.TotalPrice),
            confianca: Number(item?.confidence || objeto.Description?.confidence || 0),
        };
    }).filter((item) => item.descricao || item.codigo);
}

async function analisarDocumento(arquivo, timeoutSegundos = 180) {
    const { endpoint, key, modelId, apiVersion } = configuracaoAzure();
    const url = `${endpoint}/documentintelligence/documentModels/${encodeURIComponent(modelId)}:analyze?api-version=${apiVersion}`;
    const resposta = await fetchComRetry(url, {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/octet-stream" },
        body: fs.readFileSync(arquivo),
    });
    if (!resposta.ok) throw new Error(`Azure ${resposta.status}: ${await resposta.text()}`);
    const operacao = resposta.headers.get("operation-location");
    if (!operacao) throw new Error("Azure nao retornou operation-location.");

    const inicio = Date.now();
    let bruto;
    while ((Date.now() - inicio) / 1000 < timeoutSegundos) {
        await esperar(2000);
        const consulta = await fetchComRetry(operacao, { headers: { "Ocp-Apim-Subscription-Key": key } });
        bruto = await consulta.json().catch(() => ({}));
        if (!consulta.ok) throw new Error(`Azure ${consulta.status}: ${JSON.stringify(bruto)}`);
        if (bruto.status === "succeeded") break;
        if (bruto.status === "failed") throw new Error(`Azure falhou: ${JSON.stringify(bruto.error || bruto)}`);
    }
    if (bruto?.status !== "succeeded") throw new Error("Tempo limite do OCR Azure excedido.");

    const documento = bruto.analyzeResult?.documents?.[0] || {};
    const campos = documento.fields || {};
    const texto = bruto.analyzeResult?.content || "";
    const valorEstruturado = valorCampo(campos.Total) ?? valorCampo(campos.InvoiceTotal);
    const dataEstruturada = valorCampo(campos.TransactionDate) || valorCampo(campos.InvoiceDate);
    const fornecedor = valorCampo(campos.MerchantName) || valorCampo(campos.VendorName);
    const itens = itensDosCampos(campos);
    const itemLitros = itens.find((item) => /^(l|lt|litro|litros)$/i.test(String(item.unidade || "").trim()) && Number(item.quantidade) > 0);
    const endereco = enderecoDoCampo(campos.MerchantAddress, texto);
    return {
        fornecedor,
        nome_fantasia: nomeFantasiaDoTexto(texto, fornecedor),
        cnpj: valorCampo(campos.MerchantTaxId) || cnpjDoTexto(texto),
        endereco,
        data: dataEstruturada || dataDoTexto(texto),
        hora: valorCampo(campos.TransactionTime),
        valor: valorEstruturado ?? valorDoTexto(texto),
        itens,
        litragem: itemLitros ? Number(itemLitros.quantidade) : null,
        produto_principal: itens[0]?.descricao || null,
        placa: placaDoTexto(texto),
        quilometragem: kmDoTexto(texto),
        valor_origem: valorEstruturado !== null && valorEstruturado !== undefined ? "campo_estruturado_azure" : valorDoTexto(texto) !== null ? "heuristica_texto_azure" : null,
        data_origem: dataEstruturada ? "campo_estruturado_azure" : dataDoTexto(texto) ? "heuristica_texto_azure" : null,
        confianca: Number(documento.confidence ?? confiancaMinima(campos)),
        texto_bruto: texto,
        modelo: modelId,
        resposta_bruta: bruto,
    };
}

module.exports = { analisarDocumento, configuracaoAzure, valorCampo, cnpjDoTexto, valorDoTexto, dataDoTexto, nomeFantasiaDoTexto, placaDoTexto, kmDoTexto, enderecoDoCampo, itensDosCampos };
