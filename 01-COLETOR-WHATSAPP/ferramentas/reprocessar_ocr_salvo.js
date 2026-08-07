"use strict";

const fs = require("fs");
const path = require("path");
const { normalizarResultadoAzure } = require("../src/azure-ocr");
const { classificar } = require("../src/classificador");
const { validar } = require("../src/validador");
const { sugerir } = require("../src/aprendizado");
const { dadosAbastecimento, descricaoContaAzul } = require("../src/detalhes-despesa");
const { aplicarCentroCustoPadrao } = require("../src/pipeline");

const RAIZ = path.resolve(__dirname, "..");
const filtro = process.argv[2] || "";
const pastaBrutos = path.join(RAIZ, "dados", "ocr-bruto");
const pastaAuditoria = path.join(RAIZ, "dados", "auditoria");
const pastasMetadados = ["entrada", "simulacao", "revisao", "bloqueados", "erros"];

function lerJsonSeExistir(arquivo, padrao = {}) {
    return fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, "utf8")) : padrao;
}

function localizarMetadados(base) {
    for (const pasta of pastasMetadados) {
        const arquivo = path.join(RAIZ, "dados", pasta, `${base}.json`);
        if (fs.existsSync(arquivo)) return lerJsonSeExistir(arquivo);
    }
    return {};
}

function moverParaFilaCorreta(base, validacoes) {
    const destinoNome = validacoes.bloqueado ? "bloqueados" : validacoes.revisao_necessaria ? "revisao" : "simulacao";
    const origemNome = pastasMetadados.find((pasta) => {
        const diretorio = path.join(RAIZ, "dados", pasta);
        return fs.existsSync(diretorio) && fs.readdirSync(diretorio).some((arquivo) => path.parse(arquivo).name === base && /\.(?:jpe?g|png|bmp|pdf)$/i.test(arquivo));
    });
    if (!origemNome || origemNome === destinoNome) return;
    const origem = path.join(RAIZ, "dados", origemNome);
    const destino = path.join(RAIZ, "dados", destinoNome);
    fs.mkdirSync(destino, { recursive: true });
    for (const arquivo of fs.readdirSync(origem).filter((item) => path.parse(item).name === base)) {
        const atual = path.join(origem, arquivo);
        const novo = path.join(destino, arquivo);
        if (fs.existsSync(novo)) throw new Error(`Reprocessamento nao sobrescreveu arquivo existente: ${novo}`);
        fs.renameSync(atual, novo);
    }
}

const configuracao = lerJsonSeExistir(path.join(RAIZ, "config.json"));
const centrosCusto = lerJsonSeExistir(path.join(RAIZ, "configuracao", "centros_custo.json"), []);

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
        const base = path.parse(nome).name;
        const meta = localizarMetadados(base);
        const centroIdGrupo = configuracao.centros_custo_por_grupo?.[meta.id_grupo];
        const centroGrupo = Array.isArray(centrosCusto) ? centrosCusto.find((item) => String(item.id) === String(centroIdGrupo || "")) : null;
        const operadorAnterior = { ...(auditoria.operador || {}) };
        if (operadorAnterior.centro_custo_origem === "grupo_whatsapp") operadorAnterior.centro_custo_informado = null;
        const centroContexto = aplicarCentroCustoPadrao(operadorAnterior, {
            ...meta,
            centro_custo_padrao: centroGrupo || meta.centro_custo_padrao || null,
        }, Array.isArray(centrosCusto) ? centrosCusto : []);
        const modelo = bruto.analyzeResult?.modelId || auditoria.ocr?.modelo || "prebuilt-receipt";
        const { resposta_bruta: _respostaBruta, ...normalizado } = normalizarResultadoAzure(bruto, modelo);
        const ocr = { ...auditoria.ocr, ...normalizado };
        const fornecedor = ocr.fornecedor;
        const itens = ocr.itens;
        const operador = centroContexto.operador;
        const classificacao = classificar(operador, ocr);
        const regras = JSON.parse(fs.readFileSync(path.join(RAIZ, "configuracao", "regras.json"), "utf8"));
        auditoria.ocr = ocr;
        auditoria.operador = { ...operador, centro_custo_origem: centroContexto.origem };
        auditoria.classificacao = {
            tipo: classificacao.tipo_reconhecido?.nome || null, tipo_origem: classificacao.tipo_origem,
            categoria_nome: classificacao.categoria_nome, categoria_id: classificacao.categoria_id,
            centro_custo_nome: classificacao.centro_custo_nome, centro_custo_id: classificacao.centro_custo_id,
            centro_custo_origem: centroContexto.origem,
            veiculo: classificacao.veiculo?.nome || null, placa: classificacao.veiculo?.placa || ocr.placa || null,
        };
        const contextoAprendizado = [ocr.nome_fantasia, ocr.produto_principal, ...itens.map((item) => item.descricao), ocr.placa].filter(Boolean).join(" ");
        auditoria.aprendizado_historico = sugerir({ legenda: auditoria.legenda_original, fornecedor, textoOcr: contextoAprendizado });
        auditoria.validacoes = validar({ operador, ocr, classificacao, regras, duplicado: Boolean(auditoria.validacoes?.duplicado) });
        auditoria.dados_abastecimento = dadosAbastecimento(ocr, classificacao);
        auditoria.conta_azul = { ...(auditoria.conta_azul || {}), descricao_sugerida: descricaoContaAzul({ legenda: auditoria.legenda_original, ocr, classificacao }) };
        auditoria.reprocessado_em = new Date().toISOString();
        gravarAtomico(auditoriaPath, auditoria);
        moverParaFilaCorreta(base, auditoria.validacoes);
        atualizados += 1;
    }
}

console.log(`${atualizados} documento(s) atualizado(s) usando o OCR Azure ja salvo.`);
