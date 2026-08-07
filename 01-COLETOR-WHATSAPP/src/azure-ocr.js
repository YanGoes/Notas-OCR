"use strict";

const fs = require("fs");
const path = require("path");
const { carregarEnv } = require("./env");

const RAIZ = path.resolve(__dirname, "..");
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UFS = "AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO";
const INTERMEDIARIOS_PAGAMENTO = /\b(?:stone|cielo|pagbank|pagseguro|rede|getnet|sumup|safrapay|mercado\s*pago|ton|bin)\b/i;
const CODIGOS_UF_NFE = {
    11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO",
    21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL", 28: "SE", 29: "BA",
    31: "MG", 32: "ES", 33: "RJ", 35: "SP", 41: "PR", 42: "SC", 43: "RS",
    50: "MS", 51: "MT", 52: "GO", 53: "DF",
};

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

function dataExiste(ano, mes, dia) {
    const data = new Date(Date.UTC(ano, mes - 1, dia));
    return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}

function normalizarData(valor) {
    const texto = String(valor || "").trim();
    let achado = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (achado && dataExiste(Number(achado[1]), Number(achado[2]), Number(achado[3]))) return texto;

    achado = texto.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);
    if (achado) {
        const ano = achado[3].length === 2 ? 2000 + Number(achado[3]) : Number(achado[3]);
        const mes = Number(achado[2]);
        const dia = Number(achado[1]);
        if (dataExiste(ano, mes, dia)) return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    }

    const meses = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
    achado = texto.match(/^(\d{1,2})[\/-]([A-Z]{3})[\/-](\d{2}|\d{4})$/i);
    if (achado && meses[achado[2].toLowerCase()]) {
        const ano = achado[3].length === 2 ? 2000 + Number(achado[3]) : Number(achado[3]);
        const mes = meses[achado[2].toLowerCase()];
        const dia = Number(achado[1]);
        if (dataExiste(ano, mes, dia)) return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    }
    return null;
}

function valorCampo(campo) {
    if (!campo) return null;
    if (campo.type === "currency" || campo.valueCurrency !== undefined) {
        const valor = Number(campo.valueCurrency?.amount);
        return Number.isFinite(valor) && valor > 0 ? valor : null;
    }
    if (campo.valueNumber !== undefined) {
        const valor = Number(campo.valueNumber);
        return Number.isFinite(valor) ? valor : null;
    }
    if (campo.type === "date" || campo.valueDate !== undefined) {
        return normalizarData(campo.valueDate) || normalizarData(campo.content);
    }
    if (campo.type === "time" || campo.valueTime !== undefined) {
        const valor = String(campo.valueTime || campo.content || "").trim();
        const partes = valor.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!partes || Number(partes[1]) > 23 || Number(partes[2]) > 59 || Number(partes[3] || 0) > 59) return null;
        return `${String(partes[1]).padStart(2, "0")}:${partes[2]}:${partes[3] || "00"}`;
    }
    for (const chave of ["valueString", "content"]) {
        if (campo[chave] !== undefined && campo[chave] !== null) return campo[chave];
    }
    return null;
}

function confiancaMinima(campos) {
    const confiancas = Object.values(campos || {}).map((campo) => Number(campo?.confidence)).filter(Number.isFinite);
    return confiancas.length ? Math.min(...confiancas) : 0;
}

function normalizarBusca(valor) {
    return String(valor || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function digitoCnpj(base) {
    let peso = base.length - 7;
    let soma = 0;
    for (const digito of base) {
        soma += Number(digito) * peso;
        peso -= 1;
        if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
}

function cnpjValido(valor) {
    const cnpj = String(valor || "").replace(/\D/g, "");
    if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
    return Number(cnpj[12]) === digitoCnpj(cnpj.slice(0, 12)) && Number(cnpj[13]) === digitoCnpj(cnpj.slice(0, 13));
}

function candidatosCnpj(texto) {
    const candidatos = [];
    const regex = /\b\d{2}(?:[.\t ]?\d{3}){2}[\t ]*\/?[\t ]*\d{4}[\t ]*(?:-|[\t ])?[\t ]*\d{2}\b/g;
    for (const achado of String(texto || "").matchAll(regex)) {
        const valor = achado[0].replace(/\D/g, "");
        if (valor.length === 14) candidatos.push({ valor, indice: achado.index, valido: cnpjValido(valor) });
    }
    return candidatos;
}

function cnpjDoTexto(texto, fornecedor = "") {
    const candidatos = candidatosCnpj(texto);
    if (!candidatos.length) return null;
    const validos = candidatos.some((item) => item.valido) ? candidatos.filter((item) => item.valido) : candidatos;
    const referencia = String(fornecedor || "").trim();
    if (!referencia) return validos[0].valor;

    const textoMinusculo = String(texto || "").toLocaleLowerCase("pt-BR");
    const referenciaMinuscula = referencia.toLocaleLowerCase("pt-BR");
    const posicoes = [];
    let inicio = 0;
    while ((inicio = textoMinusculo.indexOf(referenciaMinuscula, inicio)) !== -1) {
        posicoes.push(inicio);
        inicio += Math.max(referenciaMinuscula.length, 1);
    }
    if (!posicoes.length) return validos[0].valor;

    return validos.map((candidato) => {
        let score = candidato.valido ? 1000 : 0;
        for (const posicao of posicoes) {
            const fimFornecedor = posicao + referencia.length;
            const distancia = candidato.indice - fimFornecedor;
            if (distancia >= 0 && distancia <= 250) score = Math.max(score, 1500 - distancia);
            else if (distancia < 0 && distancia >= -150) score = Math.max(score, 1250 + distancia);
        }
        return { ...candidato, score };
    }).sort((a, b) => b.score - a.score || a.indice - b.indice)[0].valor;
}

function chaveNfeValida(chave) {
    const digitos = String(chave || "").replace(/\D/g, "");
    if (digitos.length !== 44) return false;
    let peso = 2;
    let soma = 0;
    for (let indice = 42; indice >= 0; indice -= 1) {
        soma += Number(digitos[indice]) * peso;
        peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    const verificador = resto === 0 || resto === 1 ? 0 : 11 - resto;
    return Number(digitos[43]) === verificador;
}

function dadosChaveFiscalDoTexto(texto) {
    const candidatos = [];
    const regexAgrupada = /\b(?:\d{4}[\t ]*){5,11}\b/g;
    const regexContinua = /\b\d{20,44}\b/g;
    for (const regex of [regexAgrupada, regexContinua]) {
        for (const achado of String(texto || "").matchAll(regex)) {
            const digitos = achado[0].replace(/\D/g, "");
            if (digitos.length < 20 || digitos.length > 44) continue;
            const estado = CODIGOS_UF_NFE[digitos.slice(0, 2)];
            const mes = Number(digitos.slice(4, 6));
            const cnpjLido = digitos.slice(6, 20);
            const contexto = String(texto || "").slice(Math.max(0, achado.index - 180), achado.index).toLowerCase();
            const contextoFiscal = /chave\s+de\s+acesso|nf-?c?e/.test(contexto);
            if (mes < 1 || mes > 12 || (!contextoFiscal && !estado && !cnpjValido(cnpjLido))) continue;
            const score = (contextoFiscal ? 100 : 0) + digitos.length;
            candidatos.push({
                chave: chaveNfeValida(digitos) ? digitos : null,
                chave_prefixo: digitos,
                cnpj: cnpjValido(cnpjLido) ? cnpjLido : null,
                cnpj_lido: cnpjLido,
                estado: estado || null,
                ano_mes: `20${digitos.slice(2, 4)}-${digitos.slice(4, 6)}`,
                score,
            });
        }
    }
    return candidatos.sort((a, b) => b.score - a.score || b.chave_prefixo.length - a.chave_prefixo.length)[0] || null;
}

function cnpjReconciliadoComChave(texto, chaveFiscal) {
    if (chaveFiscal?.cnpj) return chaveFiscal.cnpj;
    const lido = String(chaveFiscal?.cnpj_lido || "");
    if (lido.length !== 14) return null;
    const candidatos = candidatosCnpj(texto).filter((item) => item.valido).map((item) => ({
        ...item,
        diferencas: [...item.valor].filter((digito, indice) => digito !== lido[indice]).length,
    })).sort((a, b) => a.diferencas - b.diferencas || a.indice - b.indice);
    return candidatos[0]?.diferencas <= 2 ? candidatos[0].valor : null;
}

function limparNomeEmpresa(linha) {
    return String(linha || "")
        .replace(/\s*[-–—]?\s*CNPJ\s*[:.]?.*$/i, "")
        .replace(/^[^\p{L}]*/u, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function nomeEmpresaDoTexto(texto, cnpjReferencia = "") {
    const linhas = String(texto || "").split(/\r?\n/);
    const candidatos = [];
    let deslocamento = 0;
    for (const linha of linhas) {
        const nome = limparNomeEmpresa(linha);
        const possuiFormaSocietaria = /\b(?:LTDA|EIRELI|EPP|ME|S\/?A)\b/i.test(nome);
        const possuiRamo = /\b(?:panificadora|confeitaria|restaurante|lanchonete|hotel|pousada|drogaria|farmacia|posto)\b/i.test(nome);
        const boilerplate = /documento\s+emitido|simples\s+nacional|consumidor|nota\s+fiscal|forma\s+de\s+pagamento/i.test(nome);
        if (nome.length >= 4 && nome.length <= 100 && !boilerplate && (possuiFormaSocietaria || possuiRamo)) {
            let score = (possuiFormaSocietaria ? 5 : 0) + (possuiRamo ? 3 : 0) + (/CNPJ/i.test(linha) ? 4 : 0);
            const cnpjsProximos = candidatosCnpj(String(texto || "").slice(deslocamento, deslocamento + linha.length + 180));
            if (cnpjsProximos.length) score += 2;
            if (cnpjReferencia && cnpjsProximos.some((item) => item.valor === cnpjReferencia)) score += 10;
            candidatos.push({ nome, score, indice: deslocamento });
        }
        deslocamento += linha.length + 1;
    }
    return candidatos.sort((a, b) => b.score - a.score || a.indice - b.indice)[0]?.nome || null;
}

function fornecedorDoTexto(texto, fornecedorEstruturado = "", cnpjFiscal = "") {
    const estruturado = String(fornecedorEstruturado || "").replace(/\s+/g, " ").trim();
    if (estruturado && !INTERMEDIARIOS_PAGAMENTO.test(normalizarBusca(estruturado))) return estruturado;
    return nomeEmpresaDoTexto(texto, cnpjFiscal) || estruturado || null;
}

function numeroMonetario(texto) {
    const limpo = String(texto).replace(/[^\d,.-]/g, "");
    const normalizado = limpo.includes(",") ? limpo.replace(/\./g, "").replace(",", ".") : limpo;
    const valor = Number(normalizado);
    return Number.isFinite(valor) && valor > 0 ? valor : null;
}

function detalhesValorDoTexto(texto) {
    const candidatos = [];
    const linhas = String(texto || "").split(/\r?\n/);
    for (let indice = 0; indice < linhas.length; indice += 1) {
        const linha = linhas[indice];
        if (!/(valor\s*(total|a\s*pagar|pago)|\btotal\b\s*(geral|a\s*pagar)?|vlr\s*total)/i.test(linha)) continue;
        if (/tribut|impost|troco|desconto|taxa|ibpt/i.test(linha)) continue;
        const valores = linha.match(/(?:R\$\s*)?\d{1,3}(?:\.\d{3})*,\d{2}|R\$\s*\d+(?:[.,]\d{2})?/gi) || [];
        for (const encontrado of valores) {
            const valor = numeroMonetario(encontrado);
            if (valor !== null) candidatos.push(valor);
        }
        if (!valores.length && indice + 1 < linhas.length && !/tribut|impost|troco|desconto|taxa|ibpt/i.test(linhas[indice + 1])) {
            const valorSeguinte = linhas[indice + 1].match(/^(?:R\$\s*)?(\d{1,7}(?:[.,]\d{2}))\s*$/i);
            const valor = valorSeguinte ? numeroMonetario(valorSeguinte[1]) : null;
            if (valor !== null) candidatos.push(valor);
        }
    }
    const unicos = [...new Set(candidatos.map((valor) => valor.toFixed(2)))];
    if (unicos.length === 1) return { valor: Number(unicos[0]), confianca: 0.97, origem: "rotulo_total" };
    if (unicos.length > 1) return { valor: null, confianca: 0, origem: null };

    const valoresComCifrao = [];
    for (const linha of linhas) {
        if (/tribut|impost|troco|desconto|taxa|ibpt|acrescimo|juros/i.test(linha)) continue;
        const regex = /R\$\s*(\d{1,7}(?:[.,]\d{2}))/gi;
        for (const achado of linha.matchAll(regex)) {
            const valor = numeroMonetario(achado[1]);
            if (valor !== null) valoresComCifrao.push(valor);
        }
    }
    const unicosComCifrao = [...new Set(valoresComCifrao.map((valor) => valor.toFixed(2)))];
    return unicosComCifrao.length === 1
        ? { valor: Number(unicosComCifrao[0]), confianca: 0.95, origem: "valor_com_cifrao_unico" }
        : { valor: null, confianca: 0, origem: null };
}

function valorDoTexto(texto) {
    return detalhesValorDoTexto(texto).valor;
}

function dataDoTexto(texto) {
    const conteudo = String(texto || "");
    const candidatos = [];
    const regex = /\b\d{1,2}[\/-](?:\d{1,2}|[A-Z]{3})[\/-](?:\d{2}|\d{4})\b/gi;
    for (const achado of conteudo.matchAll(regex)) {
        const data = normalizarData(achado[0]);
        if (!data) continue;
        const contexto = conteudo.slice(Math.max(0, achado.index - 60), achado.index + achado[0].length + 60);
        let score = achado[0].match(/\d{4}\b/) ? 3 : 1;
        if (/emiss[aã]o|autoriza[cç][aã]o|nf-?c?e|pedido|compra/i.test(contexto)) score += 3;
        candidatos.push({ data, score, indice: achado.index });
    }
    const agrupados = new Map();
    for (const candidato of candidatos) {
        const atual = agrupados.get(candidato.data) || { ...candidato, ocorrencias: 0, score: 0 };
        atual.ocorrencias += 1;
        atual.score += candidato.score;
        atual.indice = Math.min(atual.indice, candidato.indice);
        agrupados.set(candidato.data, atual);
    }
    return [...agrupados.values()].sort((a, b) => b.score - a.score || b.ocorrencias - a.ocorrencias || a.indice - b.indice)[0]?.data || null;
}

function ocorrenciasDataNoTexto(texto, dataReferencia) {
    let ocorrencias = 0;
    const regex = /\b\d{1,2}[\/-](?:\d{1,2}|[A-Z]{3})[\/-](?:\d{2}|\d{4})\b/gi;
    for (const achado of String(texto || "").matchAll(regex)) {
        if (normalizarData(achado[0]) === dataReferencia) ocorrencias += 1;
    }
    return ocorrencias;
}

function nomeFantasiaDoTexto(texto, fornecedor = "") {
    const linhas = String(texto || "").split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean);
    const padrao = /^(?:p?osto|hotel|pousada|restaurante|churrascaria|padaria|panificadora|confeitaria|lanchonete|drogaria|farmacia)\b/i;
    let nome = linhas.map(limparNomeEmpresa).find((linha) => padrao.test(linha) && normalizarBusca(linha) !== normalizarBusca(fornecedor)) || null;
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

function candidatosCidadeEstado(texto) {
    const candidatos = [];
    const regexUf = new RegExp(`(.+?)[,/\\-]\\s*(${UFS})\\b`, "i");
    for (const linhaOriginal of String(texto || "").split(/\r?\n/)) {
        const achado = linhaOriginal.match(regexUf);
        if (!achado) continue;
        const partes = achado[1].split(/[,/-]/).map((parte) => parte.trim()).filter(Boolean);
        const cidade = partes.at(-1)?.replace(/^(?:cidade|munic[ií]pio)\s*:?\s*/i, "").trim();
        if (cidade && /\p{L}/u.test(cidade)) candidatos.push({ cidade, estado: achado[2].toUpperCase() });
    }
    return candidatos;
}

function limparRua(valor) {
    const linhas = String(valor || "").split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean);
    return linhas.find((linha) => /^(?:RUA|R\.|AV\.?|AVENIDA|ROD\.?|RODOVIA|ALAMEDA|TRAVESSA|ESTRADA|PRA[CÇ]A)\b/i.test(linha)) || linhas.at(-1) || null;
}

function enderecoDoCampo(campo, texto, estadoFiscal = "") {
    const valor = campo?.valueAddress || {};
    const candidatos = candidatosCidadeEstado(texto);
    const cidadeEstruturada = String(valor.city || "").trim();
    const palavrasCidade = new Set(normalizarBusca(cidadeEstruturada).split(" ").filter((item) => item.length > 2));
    const cidadeUf = candidatos.map((item) => {
        const palavras = normalizarBusca(item.cidade).split(" ").filter((palavra) => palavra.length > 2);
        const coincidencias = palavras.filter((palavra) => palavrasCidade.has(palavra)).length;
        return { ...item, score: cidadeEstruturada ? coincidencias / Math.max(palavras.length, palavrasCidade.size, 1) : 0 };
    }).sort((a, b) => b.score - a.score)[0];
    return {
        rua: limparRua(valor.road || valor.addressLine),
        cidade: cidadeEstruturada || cidadeUf?.cidade || null,
        estado: String(estadoFiscal || valor.state || cidadeUf?.estado || "").toUpperCase() || null,
        cep: valor.postalCode || null,
    };
}

function itensDosCampos(campos) {
    return (campos.Items?.valueArray || []).map((item) => {
        const objeto = item?.valueObject || {};
        const conteudo = String(item?.content || "");
        const unidadeTexto = conteudo.match(/\b(UN|UND|UNID|KG|G|L|LT|LITRO|LITROS)\b/i)?.[1] || null;
        return {
            descricao: String(valorCampo(objeto.Description) || "").replace(/\s+/g, " ").trim() || null,
            codigo: valorCampo(objeto.ProductCode),
            quantidade: valorCampo(objeto.Quantity),
            unidade: valorCampo(objeto.QuantityUnit) || unidadeTexto,
            valor_unitario: valorCampo(objeto.Price),
            valor_total: valorCampo(objeto.TotalPrice),
            confianca: Number(item?.confidence || objeto.Description?.confidence || 0),
        };
    }).filter((item) => item.descricao || item.codigo);
}

function tipoSugeridoAzure(documento, campos) {
    const tipoDocumento = String(documento?.docType || "").toLowerCase();
    const tipoRecibo = String(valorCampo(campos?.ReceiptType) || "").toLowerCase();
    if (tipoDocumento.includes("retailmeal") || /meal|restaurant|food/.test(tipoRecibo)) return "alimentacao";
    if (/gas|fuel/.test(tipoRecibo)) return "combustivel";
    return null;
}

function confiancaLeitura(documento, campos, valorEstruturado, valorFinal, opcoes = {}) {
    const confiancas = [Number(documento?.confidence)];
    const campoFornecedor = campos.MerchantName || campos.VendorName;
    const campoData = campos.TransactionDate || campos.InvoiceDate;
    if (Number.isFinite(Number(opcoes.confiancaFornecedor))) confiancas.push(Number(opcoes.confiancaFornecedor));
    else if (opcoes.fornecedorHeuristico) confiancas.push(0.88);
    else if (Number.isFinite(Number(campoFornecedor?.confidence))) confiancas.push(Number(campoFornecedor.confidence));
    if (Number.isFinite(Number(opcoes.confiancaData))) confiancas.push(Number(opcoes.confiancaData));
    else if (opcoes.dataHeuristica) confiancas.push(0.92);
    else if (Number.isFinite(Number(campoData?.confidence))) confiancas.push(Number(campoData.confidence));
    if (Number.isFinite(Number(valorEstruturado)) && Number(valorEstruturado) > 0 && Number.isFinite(Number((campos.Total || campos.InvoiceTotal)?.confidence))) {
        confiancas.push(Number(opcoes.confiancaValorEstruturado || (campos.Total || campos.InvoiceTotal).confidence));
    } else if (Number.isFinite(Number(valorFinal)) && Number(valorFinal) > 0) {
        confiancas.push(Number(opcoes.confiancaValorTexto || 0.85));
    } else {
        confiancas.push(0);
    }
    return Math.min(...confiancas.filter(Number.isFinite));
}

function normalizarResultadoAzure(bruto, modelId = "prebuilt-receipt") {
    const documento = bruto?.analyzeResult?.documents?.[0] || {};
    const campos = documento.fields || {};
    const texto = bruto?.analyzeResult?.content || "";
    const valorEstruturado = valorCampo(campos.Total) ?? valorCampo(campos.InvoiceTotal);
    const detalhesValor = detalhesValorDoTexto(texto);
    const valorFinal = valorEstruturado ?? detalhesValor.valor;
    const dataEstruturada = valorCampo(campos.TransactionDate) || valorCampo(campos.InvoiceDate);
    const dataTexto = dataDoTexto(texto);
    const dataFinal = dataEstruturada || dataTexto;
    const chaveFiscal = dadosChaveFiscalDoTexto(texto);
    const cnpjChave = cnpjReconciliadoComChave(texto, chaveFiscal);
    const fornecedorEstruturado = valorCampo(campos.MerchantName) || valorCampo(campos.VendorName);
    const fornecedor = fornecedorDoTexto(texto, fornecedorEstruturado, cnpjChave);
    const fornecedorHeuristico = Boolean(fornecedor && normalizarBusca(fornecedor) !== normalizarBusca(fornecedorEstruturado));
    const cnpjEstruturado = String(valorCampo(campos.MerchantTaxId) || "").replace(/\D/g, "");
    const cnpj = cnpjChave || (cnpjValido(cnpjEstruturado) ? cnpjEstruturado : cnpjDoTexto(texto, fornecedor));
    const fornecedorAssociadoAoCnpj = Boolean(
        fornecedor && cnpj && String(texto).toLocaleLowerCase("pt-BR").includes(String(fornecedor).toLocaleLowerCase("pt-BR"))
        && cnpjDoTexto(texto, fornecedor) === cnpj
    );
    const dataRepetidaCoerente = Boolean(
        dataFinal && chaveFiscal?.ano_mes && dataFinal.startsWith(chaveFiscal.ano_mes)
        && ocorrenciasDataNoTexto(texto, dataFinal) >= 2
    );
    const valorEstruturadoConfirmado = Boolean(
        Number.isFinite(Number(valorEstruturado)) && detalhesValor.valor !== null
        && Number(valorEstruturado).toFixed(2) === Number(detalhesValor.valor).toFixed(2)
    );
    const itens = itensDosCampos(campos);
    const itemLitros = itens.find((item) => /^(l|lt|litro|litros)$/i.test(String(item.unidade || "").trim()) && Number(item.quantidade) > 0);
    const endereco = enderecoDoCampo(campos.MerchantAddress, texto, chaveFiscal?.estado);
    return {
        fornecedor,
        fornecedor_origem: fornecedorHeuristico ? "heuristica_texto_azure" : fornecedor ? "campo_estruturado_azure" : null,
        nome_fantasia: nomeFantasiaDoTexto(texto, fornecedor),
        cnpj,
        cnpj_origem: chaveFiscal?.cnpj ? "chave_fiscal_nfce" : cnpjChave ? "chave_fiscal_nfce_reconciliada" : cnpjValido(cnpjEstruturado) ? "campo_estruturado_azure" : cnpj ? "heuristica_texto_azure" : null,
        chave_fiscal: chaveFiscal?.chave,
        chave_fiscal_prefixo: chaveFiscal?.chave_prefixo || null,
        endereco,
        data: dataFinal,
        hora: valorCampo(campos.TransactionTime),
        valor: valorFinal,
        itens,
        litragem: itemLitros ? Number(itemLitros.quantidade) : null,
        produto_principal: itens[0]?.descricao || null,
        placa: placaDoTexto(texto),
        quilometragem: kmDoTexto(texto),
        tipo_recibo_azure: valorCampo(campos.ReceiptType),
        tipo_despesa_sugerido: tipoSugeridoAzure(documento, campos),
        valor_origem: valorEstruturado !== null && valorEstruturado !== undefined ? "campo_estruturado_azure" : detalhesValor.valor !== null ? "heuristica_texto_azure" : null,
        valor_evidencia: valorEstruturado !== null && valorEstruturado !== undefined ? "campo_estruturado" : detalhesValor.origem,
        data_origem: dataEstruturada ? "campo_estruturado_azure" : dataTexto ? "heuristica_texto_azure" : null,
        confianca_documento: Number(documento.confidence ?? confiancaMinima(campos)),
        confianca: confiancaLeitura(documento, campos, valorEstruturado, valorFinal, {
            fornecedorHeuristico,
            confiancaFornecedor: fornecedorAssociadoAoCnpj ? (cnpjChave === cnpj ? 0.96 : 0.95) : undefined,
            dataHeuristica: Boolean(!dataEstruturada && dataTexto),
            confiancaData: dataRepetidaCoerente ? 0.97 : undefined,
            confiancaValorTexto: detalhesValor.confianca,
            confiancaValorEstruturado: valorEstruturadoConfirmado ? 0.97 : undefined,
        }),
        texto_bruto: texto,
        modelo: modelId,
        resposta_bruta: bruto,
    };
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
    return normalizarResultadoAzure(bruto, modelId);
}

module.exports = {
    analisarDocumento, configuracaoAzure, valorCampo, cnpjDoTexto, cnpjValido, chaveNfeValida, dadosChaveFiscalDoTexto, fornecedorDoTexto,
    valorDoTexto, detalhesValorDoTexto, normalizarData, dataDoTexto, nomeFantasiaDoTexto,
    placaDoTexto, kmDoTexto, enderecoDoCampo, itensDosCampos, tipoSugeridoAzure,
    confiancaLeitura, normalizarResultadoAzure,
};
