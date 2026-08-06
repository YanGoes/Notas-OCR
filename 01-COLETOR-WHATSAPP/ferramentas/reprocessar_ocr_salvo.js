"use strict";

const fs = require("fs");
const path = require("path");
const { valorCampo, cnpjDoTexto, nomeFantasiaDoTexto, placaDoTexto, kmDoTexto, enderecoDoCampo, itensDosCampos } = require("../src/azure-ocr");
const { classificar } = require("../src/classificador");
const { validar } = require("../src/validador");
const { sugerir } = require("../src/aprendizado");
const { dadosAbastecimento, descricaoContaAzul } = require("../src/detalhes-despesa");

const RAIZ = path.resolve(__dirname, "..");
const filtro = process.argv[2] || "";
const pastaBrutos = path.join(RAIZ, "dados", "ocr-bruto");
const pastaAuditoria = path.join(RAIZ, "dados", "auditoria");

function gravarAtomico(arquivo, dados) {
    const temporario = `${arquivo}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(dados, null, 2), "utf8");
    fs.renameSync(temporario, arquivo);
}

let atualizados = 0;
if (fs.existsSync(pastaBrutos)) {
    for (const nome of fs.readdirSync(pastaBrutos).filter((item) => item.endsWith(".json") && (!filtro || item.includes(filtro)))) {
        const auditoriaPath = path.join(pastaAuditoria, nome);
        if (!fs.existsSync(auditoriaPath)) continue;
        const bruto = JSON.parse(fs.readFileSync(path.join(pastaBrutos, nome), "utf8"));
        const auditoria = JSON.parse(fs.readFileSync(auditoriaPath, "utf8"));
        const documento = bruto.analyzeResult?.documents?.[0] || {};
        const campos = documento.fields || {};
        const texto = bruto.analyzeResult?.content || auditoria.ocr?.texto_bruto || "";
        const fornecedor = valorCampo(campos.MerchantName) || valorCampo(campos.VendorName) || auditoria.ocr?.fornecedor;
        const itens = itensDosCampos(campos);
        const ocr = {
            ...auditoria.ocr, fornecedor, nome_fantasia: nomeFantasiaDoTexto(texto, fornecedor),
            cnpj: valorCampo(campos.MerchantTaxId) || auditoria.ocr?.cnpj || cnpjDoTexto(texto),
            endereco: enderecoDoCampo(campos.MerchantAddress, texto), itens,
            produto_principal: itens[0]?.descricao || null,
            litragem: itens.find((item) => /^(l|lt|litro|litros)$/i.test(String(item.unidade || "").trim()))?.quantidade || null,
            placa: placaDoTexto(texto),
            quilometragem: kmDoTexto(texto), texto_bruto: texto,
        };
        const operador = auditoria.operador || {};
        const classificacao = classificar(operador, ocr);
        const regras = JSON.parse(fs.readFileSync(path.join(RAIZ, "configuracao", "regras.json"), "utf8"));
        auditoria.ocr = ocr;
        auditoria.classificacao = {
            tipo: classificacao.tipo_reconhecido?.nome || null, tipo_origem: classificacao.tipo_origem,
            categoria_nome: classificacao.categoria_nome, categoria_id: classificacao.categoria_id,
            centro_custo_nome: classificacao.centro_custo_nome, centro_custo_id: classificacao.centro_custo_id,
            veiculo: classificacao.veiculo?.nome || null, placa: classificacao.veiculo?.placa || ocr.placa || null,
        };
        const contextoAprendizado = [ocr.nome_fantasia, ocr.produto_principal, ...itens.map((item) => item.descricao), ocr.placa].filter(Boolean).join(" ");
        auditoria.aprendizado_historico = sugerir({ legenda: auditoria.legenda_original, fornecedor, textoOcr: contextoAprendizado });
        auditoria.validacoes = validar({ operador, ocr, classificacao, regras, duplicado: Boolean(auditoria.validacoes?.duplicado) });
        auditoria.dados_abastecimento = dadosAbastecimento(ocr, classificacao);
        auditoria.conta_azul = { ...(auditoria.conta_azul || {}), descricao_sugerida: descricaoContaAzul({ legenda: auditoria.legenda_original, ocr, classificacao }) };
        auditoria.reprocessado_em = new Date().toISOString();
        gravarAtomico(auditoriaPath, auditoria);
        atualizados += 1;
    }
}

console.log(`${atualizados} documento(s) atualizado(s) usando o OCR Azure ja salvo.`);
