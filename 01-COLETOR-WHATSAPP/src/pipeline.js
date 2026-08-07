"use strict";

const fs = require("fs");
const path = require("path");
const { analisarDocumento } = require("./azure-ocr");
const { interpretarLegenda, normalizar } = require("./legenda");
const { classificar } = require("./classificador");
const { hashArquivo, chaveFiscal, validar } = require("./validador");
const { sugerir } = require("./aprendizado");
const { dadosAbastecimento, descricaoContaAzul } = require("./detalhes-despesa");

const RAIZ = path.resolve(__dirname, "..");
const extensoes = new Set([".jpg", ".jpeg", ".png", ".bmp", ".pdf"]);
let executando = false;

function garantirPastas() {
    for (const nome of ["dados/entrada", "dados/simulacao", "dados/revisao", "dados/bloqueados", "dados/erros", "dados/auditoria", "dados/ocr-bruto"]) {
        fs.mkdirSync(path.join(RAIZ, nome), { recursive: true });
    }
}

function lerJson(arquivo, padrao = {}) {
    return fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, "utf8")) : padrao;
}

function gravarAtomico(arquivo, dados) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const temporario = `${arquivo}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(dados, null, 2), "utf8");
    fs.renameSync(temporario, arquivo);
}

function aplicarCentroCustoPadrao(operador, meta = {}, centros = []) {
    const resultado = { ...operador };
    if (String(resultado.centro_custo_informado || "").trim()) {
        return { operador: resultado, origem: "legenda", centro: null };
    }
    const salvo = meta.centro_custo_padrao;
    if (!salvo) return { operador: resultado, origem: null, centro: null };
    const idSalvo = typeof salvo === "object" ? String(salvo.id || "") : String(salvo);
    const nomeSalvo = typeof salvo === "object" ? String(salvo.nome || "") : String(salvo);
    const centro = centros.find((item) => idSalvo && String(item.id) === idSalvo)
        || centros.find((item) => nomeSalvo && normalizar(item.nome) === normalizar(nomeSalvo));
    if (!centro) return { operador: resultado, origem: null, centro: null };
    resultado.centro_custo_informado = centro.nome;
    return {
        operador: resultado,
        origem: "grupo_whatsapp",
        centro: { id: String(centro.id), nome: String(centro.nome) },
    };
}

function moverConjunto(imagem, destino) {
    fs.mkdirSync(destino, { recursive: true });
    const base = imagem.replace(/\.[^.]+$/, "");
    for (const arquivo of [imagem, `${base}.txt`, `${base}.json`]) {
        if (fs.existsSync(arquivo)) fs.renameSync(arquivo, path.join(destino, path.basename(arquivo)));
    }
}

function registrarDuplicidade(indicePath, mensagemId, hash, fiscal) {
    const indice = lerJson(indicePath, { mensagens: {}, hashes: {}, fiscais: {} });
    const duplicado = Boolean(indice.mensagens[mensagemId] || indice.hashes[hash] || (fiscal !== "||0.00" && indice.fiscais[fiscal]));
    return { indice, duplicado, confirmar() {
        indice.mensagens[mensagemId] = new Date().toISOString();
        indice.hashes[hash] = new Date().toISOString();
        if (fiscal !== "||0.00") indice.fiscais[fiscal] = new Date().toISOString();
        gravarAtomico(indicePath, indice);
    } };
}

async function processar(imagem, opcoes) {
    const base = imagem.replace(/\.[^.]+$/, "");
    const meta = lerJson(`${base}.json`, {});
    const operadorLegenda = interpretarLegenda(meta.legenda || "");
    const centrosCusto = lerJson(path.join(RAIZ, "configuracao", "centros_custo.json"), []);
    const centroContexto = aplicarCentroCustoPadrao(operadorLegenda, meta, Array.isArray(centrosCusto) ? centrosCusto : []);
    const operador = centroContexto.operador;
    let ocrCompleto;
    try {
        ocrCompleto = await analisarDocumento(imagem, Number(opcoes.timeout_azure_segundos || 180));
    } catch (erro) {
        if (/nao configurado|Azure 401|Azure 403|429|temporariamente|Tempo limite/i.test(erro.message)) throw erro;
        ocrCompleto = {
            fornecedor: null, cnpj: null, data: null, hora: null, valor: null,
            valor_origem: null, data_origem: null, hora_origem: null, confianca: 0, texto_bruto: "",
            modelo: "prebuilt-receipt", erro_leitura: erro.message, resposta_bruta: { erro: erro.message },
        };
    }
    const { resposta_bruta, ...ocr } = ocrCompleto;
    gravarAtomico(path.join(RAIZ, "dados", "ocr-bruto", `${path.parse(imagem).name}.json`), resposta_bruta);
    const classificacao = classificar(operador, ocr);
    if (centroContexto.origem === "grupo_whatsapp" && centroContexto.centro) {
        classificacao.centro_custo_nome = centroContexto.centro.nome;
        classificacao.centro_custo_id = centroContexto.centro.id;
    }
    const contextoAprendizado = [ocr.nome_fantasia, ocr.produto_principal, ...(ocr.itens || []).map((item) => item.descricao), ocr.placa].filter(Boolean).join(" ");
    const aprendizado = sugerir({ legenda: meta.legenda, fornecedor: ocr.fornecedor, textoOcr: contextoAprendizado });
    const regras = lerJson(path.join(RAIZ, "configuracao", "regras.json"));
    const hash = hashArquivo(imagem);
    const fiscal = chaveFiscal(ocr);
    const duplicidade = registrarDuplicidade(path.join(RAIZ, "dados", "auditoria", "indice-duplicidade.json"), String(meta.id_mensagem || "sem-id"), hash, fiscal);
    const validacoes = validar({ operador, ocr, classificacao, regras, duplicado: duplicidade.duplicado });
    const abastecimento = dadosAbastecimento(ocr, classificacao);
    const final = {
        versao: 1, processado_em: new Date().toISOString(), modo: opcoes.modo || "simulacao",
        origem: "whatsapp", mensagem_id: meta.id_mensagem || null,
        recebido_em: meta.recebido_em_ms ? new Date(Number(meta.recebido_em_ms)).toISOString() : (meta.timestamp ? new Date(Number(meta.timestamp) * 1000).toISOString() : null),
        arquivo_imagem: path.basename(imagem), legenda_original: meta.legenda || null,
        operador: { remetente: meta.remetente || null, ...operador, centro_custo_origem: centroContexto.origem }, ocr,
        classificacao: {
            tipo: classificacao.tipo_reconhecido?.nome || null, tipo_origem: classificacao.tipo_origem,
            tipo_detectado_documento: classificacao.tipo_detectado_documento || null,
            tipo_origem_documento: classificacao.tipo_origem_documento || null,
            tipo_conflito: classificacao.tipo_conflito || null,
            evidencia_combustivel_forte: Boolean(classificacao.evidencia_combustivel_forte),
            categoria_nome: classificacao.categoria_nome, categoria_id: classificacao.categoria_id,
            centro_custo_nome: classificacao.centro_custo_nome, centro_custo_id: classificacao.centro_custo_id,
            centro_custo_origem: centroContexto.origem,
            veiculo: classificacao.veiculo?.nome || null, placa: classificacao.veiculo?.placa || ocr.placa || null,
            refeicao: classificacao.refeicao || null,
            hospedagem: classificacao.hospedagem || null,
        },
        aprendizado_historico: aprendizado,
        dados_abastecimento: abastecimento,
        validacoes,
        rastreabilidade: { sha256: hash, chave_fiscal: fiscal },
        conta_azul: { status: "NAO_ENVIADO", protocolo: null, id_confirmado: null, descricao_sugerida: descricaoContaAzul({ legenda: meta.legenda, ocr, classificacao }) },
    };
    const auditoriaPath = path.join(RAIZ, "dados", "auditoria", `${path.parse(imagem).name}.json`);
    gravarAtomico(auditoriaPath, final);
    duplicidade.confirmar();
    const pasta = validacoes.bloqueado ? "bloqueados" : validacoes.revisao_necessaria ? "revisao" : "simulacao";
    moverConjunto(imagem, path.join(RAIZ, "dados", pasta));
    console.log(`Pipeline: ${path.basename(imagem)} -> ${pasta.toUpperCase()}${validacoes.motivos.length ? ` (${validacoes.motivos.join(" ")})` : ""}`);
    return final;
}

async function processarPendentes(pastaEntrada, opcoes) {
    if (executando) return;
    executando = true;
    try {
        garantirPastas();
        const esperaComentarioMs = Math.max(0, Number(opcoes.aguardar_comentario_segundos || 0)) * 1000;
        const arquivos = fs.readdirSync(pastaEntrada).filter((nome) => {
            if (!extensoes.has(path.extname(nome).toLowerCase())) return false;
            const base = path.join(pastaEntrada, nome).replace(/\.[^.]+$/, "");
            const meta = lerJson(`${base}.json`, {});
            const recebidoEm = Number(meta.recebido_em_ms) || fs.statSync(path.join(pastaEntrada, nome)).mtimeMs;
            return Date.now() - recebidoEm >= esperaComentarioMs;
        });
        for (const nome of arquivos) {
            const imagem = path.join(pastaEntrada, nome);
            try { await processar(imagem, opcoes); }
            catch (erro) {
                console.error(`Pipeline: erro em ${nome}: ${erro.message}`);
                const temporario = /429|temporariamente|Tempo limite|nao configurado/i.test(erro.message);
                if (!temporario) {
                    gravarAtomico(path.join(RAIZ, "dados", "auditoria", `${path.parse(nome).name}_erro.json`), {
                        arquivo: nome, ocorrido_em: new Date().toISOString(), erro: erro.message,
                    });
                    moverConjunto(imagem, path.join(RAIZ, "dados", "erros"));
                }
            }
        }
    } finally { executando = false; }
}

function iniciarPipeline(pastaEntrada, opcoes) {
    if (!opcoes?.habilitado) return;
    garantirPastas();
    console.log(`Pipeline Azure ativo em modo ${String(opcoes.modo || "simulacao").toUpperCase()}. Nenhum lancamento financeiro sera criado.`);
    const rodar = () => processarPendentes(pastaEntrada, opcoes).catch((erro) => console.error("Pipeline:", erro.message));
    setTimeout(rodar, 1500);
    setInterval(rodar, Math.max(5, Number(opcoes.intervalo_segundos || 10)) * 1000);
}

module.exports = { iniciarPipeline, processarPendentes, processar, aplicarCentroCustoPadrao };
