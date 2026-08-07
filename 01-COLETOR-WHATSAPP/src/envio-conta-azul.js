"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
    empresaConectada,
    listarContasFinanceiras,
    listarCentrosCusto,
    listarCategoriasDespesa,
    criarCentroCusto: criarCentroCustoRemoto,
    enviarDocumento,
    aguardarCaptura,
    obterPreviaCaptura,
    aceitarCaptura,
    buscarContasPagar,
    obterParcelaFinanceira,
    obterPessoaPorId,
} = require("./conta-azul");

const RAIZ = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(RAIZ, "config.json");
const CENTROS_PATH = path.join(RAIZ, "configuracao", "centros_custo.json");
const AUDITORIA_DIR = path.join(RAIZ, "dados", "auditoria");
const ENVIOS_DIR = path.join(RAIZ, "dados", "conta-azul", "envios");
const extensoes = new Set([".jpg", ".jpeg", ".png", ".bmp", ".pdf"]);
const emExecucao = new Set();
const INSTANCIA_PROCESSO = crypto.randomUUID();
let filaTrabalho = Promise.resolve();

function normalizar(valor) {
    return String(valor || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function somenteDigitos(valor) { return String(valor || "").replace(/\D/g, ""); }
function uuidValido(valor) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(valor || "")); }
function centavos(valor) { const numero = Number(valor); return Number.isFinite(numero) ? Math.round(numero * 100) : null; }

function copiarJson(valor) {
    if (valor == null) return valor;
    return JSON.parse(JSON.stringify(valor));
}

function ordenarParaHash(valor) {
    if (Array.isArray(valor)) return valor.map(ordenarParaHash);
    if (!valor || typeof valor !== "object") return valor;
    return Object.fromEntries(Object.keys(valor).sort().map((chave) => [chave, ordenarParaHash(valor[chave])]));
}

function jsonEstavel(valor) {
    return JSON.stringify(ordenarParaHash(valor));
}

function dataIsoValida(valor) {
    const texto = String(valor || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
    const data = new Date(`${texto}T12:00:00Z`);
    return !Number.isNaN(data.getTime()) && data.toISOString().slice(0, 10) === texto;
}

function lerJson(arquivo, padrao = null) {
    if (!fs.existsSync(arquivo)) return padrao;
    return JSON.parse(fs.readFileSync(arquivo, "utf8"));
}

function gravarAtomico(arquivo, dados) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const temporario = `${arquivo}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporario, `${JSON.stringify(dados, null, 2)}\n`, "utf8");
    fs.renameSync(temporario, arquivo);
}

function baseSegura(base) {
    const texto = String(base || "");
    if (!texto || path.basename(texto) !== texto || !/^[\w.-]+$/u.test(texto)) throw new Error("Documento invalido.");
    return texto;
}

function caminhoAuditoria(base) { return path.join(AUDITORIA_DIR, `${baseSegura(base)}.json`); }

function carregarAuditoria(base) {
    const arquivo = caminhoAuditoria(base);
    const auditoria = lerJson(arquivo);
    if (!auditoria) throw new Error("Auditoria do documento nao encontrada.");
    return { arquivo, auditoria };
}

function localizarImagem(base, pastas = ["simulacao", "enviados"]) {
    const nomeBase = baseSegura(base);
    for (const pasta of pastas) {
        const diretorio = path.join(RAIZ, "dados", pasta);
        if (!fs.existsSync(diretorio)) continue;
        const nome = fs.readdirSync(diretorio).find((arquivo) => path.parse(arquivo).name === nomeBase && extensoes.has(path.extname(arquivo).toLowerCase()));
        if (nome) return { caminho: path.join(diretorio, nome), pasta, nome };
    }
    return null;
}

function atualizarAuditoria(base, alteracoes) {
    const { arquivo, auditoria } = carregarAuditoria(base);
    const contaAnterior = auditoria.conta_azul || {};
    const contaNova = typeof alteracoes === "function" ? alteracoes(contaAnterior, auditoria) : { ...contaAnterior, ...alteracoes };
    auditoria.conta_azul = contaNova;
    gravarAtomico(arquivo, auditoria);
    return auditoria;
}

function registrarTentativa(conta, etapa, resultado, erro = null) {
    const tentativas = Array.isArray(conta.tentativas) ? conta.tentativas.slice(-49) : [];
    tentativas.push({ etapa, resultado, em: new Date().toISOString(), erro: erro ? String(erro).slice(0, 500) : null });
    return tentativas;
}

function erroPreparacaoPermiteNovaTentativa(erro) {
    return /Conta Azul (400|401|403|404|409|422|429):|Falha OAuth|Credenciais ausentes|ainda nao conectada|Formato nao aceito|maior que 10 MB/i.test(String(erro?.message || erro || ""));
}

function avaliarProntidao(auditoria, { imagemExiste = true, confiancaMinima = 0.95, statusPermitidos = [] } = {}) {
    const impedimentos = [];
    const conta = auditoria?.conta_azul || {};
    const validacoes = auditoria?.validacoes || {};
    const ocr = auditoria?.ocr || {};
    const classificacao = auditoria?.classificacao || {};
    const statusNaoReenviavel = new Set([
        "PREPARACAO_AGENDADA", "PREPARANDO", "PREPARACAO_INCERTA",
        "PREVIA_CONFERIDA", "PREVIA_DIVERGENTE",
        "CONFIRMACAO_AGENDADA", "CONFIRMANDO", "CONFIRMACAO_INCERTA",
        "CONFIRMADO", "PILOTO_VALIDADO_NO_ERP",
    ]);
    const permitidos = new Set(statusPermitidos.map(String));

    if (!imagemExiste) impedimentos.push("Imagem local nao encontrada na fila aprovada.");
    if (statusNaoReenviavel.has(String(conta.status || "")) && !permitidos.has(String(conta.status || ""))) {
        impedimentos.push("Documento ja foi preparado, enviado, agendado ou esta em estado incerto; continue pela verificacao existente.");
    }
    if (validacoes.escopo_permitido === false) impedimentos.push("Despesa fora do escopo permitido.");
    if (validacoes.bloqueado) impedimentos.push("Documento bloqueado.");
    if (validacoes.revisao_necessaria) impedimentos.push("Documento ainda requer revisao humana.");
    if (validacoes.duplicado) impedimentos.push("Possivel documento duplicado.");
    if (Array.isArray(validacoes.motivos) && validacoes.motivos.length) impedimentos.push(...validacoes.motivos);
    if (!Number.isFinite(Number(ocr.valor)) || Number(ocr.valor) <= 0) impedimentos.push("Valor invalido.");
    if (!dataIsoValida(ocr.data)) impedimentos.push("Data de competencia invalida.");
    if (Number(ocr.confianca || 0) < Number(confiancaMinima || 0.95)) impedimentos.push("Confianca do OCR abaixo do minimo.");
    if (!uuidValido(classificacao.categoria_id)) impedimentos.push("Categoria do Conta Azul nao configurada.");
    if (!uuidValido(classificacao.centro_custo_id)) impedimentos.push("Centro de custo do Conta Azul nao configurado.");
    if (classificacao.tipo === "combustivel") {
        if (!(classificacao.placa || ocr.placa)) impedimentos.push("Placa obrigatoria nao identificada.");
        if (!Number.isFinite(Number(ocr.litragem)) || Number(ocr.litragem) <= 0) impedimentos.push("Litragem obrigatoria nao identificada.");
    }
    return { pronto: impedimentos.length === 0, impedimentos: [...new Set(impedimentos)] };
}

function resumirPrevia(resposta) {
    const previa = resposta?.previa_evento_financeiro || {};
    return {
        tipo: previa.tipo || null,
        valor: Number.isFinite(Number(previa.valor)) ? Number(previa.valor) : null,
        data_competencia: previa.data_competencia || null,
        referencia_externa: previa.referencia_externa || null,
        descricao: previa.descricao || null,
        observacao: previa.observacao || null,
        fornecedor: previa.fornecedor ? {
            id: previa.fornecedor.id || null,
            nome: previa.fornecedor.nome || null,
            documento: previa.fornecedor.documento || null,
        } : null,
        categoria: previa.categoria ? { id: previa.categoria.id || null, nome: previa.categoria.nome || null } : null,
        centro_custo: previa.centro_custo ? {
            id: previa.centro_custo.id || null,
            nome: previa.centro_custo.nome || null,
            codigo: previa.centro_custo.codigo || null,
        } : null,
        parcelas: Array.isArray(previa.parcelas) ? previa.parcelas.map((parcela) => ({
            data_vencimento: parcela.data_vencimento || null,
            metodo_pagamento: parcela.metodo_pagamento || null,
            valor_bruto: Number(parcela.composicao_valor?.valor_bruto || 0),
        })) : [],
    };
}

function compararPrevia(auditoria, previa) {
    const divergencias = [];
    const ocr = auditoria?.ocr || {};
    const classificacao = auditoria?.classificacao || {};
    if (previa.tipo !== "DESPESA") divergencias.push("A Conta Azul nao classificou o documento como DESPESA.");
    const indiceValor = centavos(previa.valor) !== centavos(ocr.valor) ? divergencias.length : -1;
    if (indiceValor >= 0) divergencias.push(`Valor diferente: programa R$ ${Number(ocr.valor || 0).toFixed(2)}; Conta Azul R$ ${Number(previa.valor || 0).toFixed(2)}.`);
    if (String(previa.data_competencia || "") !== String(ocr.data || "")) divergencias.push(`Data diferente: programa ${ocr.data || "-"}; Conta Azul ${previa.data_competencia || "-"}.`);
    if (String(previa.categoria?.id || "") !== String(classificacao.categoria_id || "")) divergencias.push(`Categoria diferente ou ausente na previa do Conta Azul (esperada: ${classificacao.categoria_nome || classificacao.categoria_id || "-"}).`);
    if (String(previa.centro_custo?.id || "") !== String(classificacao.centro_custo_id || "")) divergencias.push(`Centro de custo diferente ou ausente na previa do Conta Azul (esperado: ${classificacao.centro_custo_nome || classificacao.centro_custo_id || "-"}).`);
    const cnpjLocal = somenteDigitos(ocr.cnpj);
    const cnpjContaAzul = somenteDigitos(previa.fornecedor?.documento);
    if (!cnpjLocal) divergencias.push("A auditoria local nao possui CNPJ do fornecedor para uma confirmacao segura.");
    else if (!cnpjContaAzul) divergencias.push("A previa do Conta Azul nao vinculou o CNPJ do fornecedor.");
    else if (cnpjLocal !== cnpjContaAzul) divergencias.push("CNPJ do fornecedor diverge entre o programa e o Conta Azul.");

    const parcelas = Array.isArray(previa.parcelas) ? previa.parcelas : [];
    const problemasParcelas = [];
    if (!parcelas.length) problemasParcelas.push("a previa nao possui parcelas");
    const somaParcelas = parcelas.reduce((total, parcela) => total + (centavos(parcela.valor_bruto) || 0), 0);
    if (parcelas.length && somaParcelas !== centavos(previa.valor)) problemasParcelas.push("a soma das parcelas nao corresponde ao valor da previa");
    if (parcelas.some((parcela) => !dataIsoValida(parcela.data_vencimento))) problemasParcelas.push("ha vencimento de parcela invalido");
    if (dataIsoValida(previa.data_competencia)
        && parcelas.some((parcela) => dataIsoValida(parcela.data_vencimento) && parcela.data_vencimento < previa.data_competencia)) {
        problemasParcelas.push("ha vencimento anterior a competencia");
    }
    if (problemasParcelas.length) {
        const complemento = ` Parcelas invalidas: ${problemasParcelas.join("; ")}.`;
        if (indiceValor >= 0) divergencias[indiceValor] += complemento;
        else divergencias.push(complemento.trim());
    }
    return divergencias;
}

function snapshotConfirmacao(base, auditoria) {
    const conta = auditoria?.conta_azul || {};
    const ocr = auditoria?.ocr || {};
    const classificacao = auditoria?.classificacao || {};
    return {
        versao: 2,
        base: baseSegura(base),
        empresa_id: conta.empresa_id || null,
        documento_id: conta.documento_id || null,
        captura_id: conta.captura_id || null,
        rastreabilidade: {
            sha256: auditoria?.rastreabilidade?.sha256 || null,
            chave_fiscal: auditoria?.rastreabilidade?.chave_fiscal || null,
        },
        esperado: {
            arquivo_imagem: auditoria?.arquivo_imagem || null,
            mensagem_id: auditoria?.mensagem_id || null,
            origem: auditoria?.origem || null,
            ocr: {
                fornecedor: ocr.fornecedor || null,
                nome_fantasia: ocr.nome_fantasia || null,
                cnpj: ocr.cnpj || null,
                valor: Number.isFinite(Number(ocr.valor)) ? Number(ocr.valor) : null,
                data: ocr.data || null,
                confianca: Number.isFinite(Number(ocr.confianca)) ? Number(ocr.confianca) : null,
                placa: ocr.placa || null,
                litragem: Number.isFinite(Number(ocr.litragem)) ? Number(ocr.litragem) : null,
            },
            classificacao: {
                tipo: classificacao.tipo || null,
                categoria_id: classificacao.categoria_id || null,
                categoria_nome: classificacao.categoria_nome || null,
                centro_custo_id: classificacao.centro_custo_id || null,
                centro_custo_nome: classificacao.centro_custo_nome || null,
                placa: classificacao.placa || null,
            },
            validacoes: copiarJson(auditoria?.validacoes || {}),
        },
        previa: copiarJson(conta.previa || null),
    };
}

function tokenConfirmacao(base, auditoria) {
    return crypto.createHash("sha256").update(jsonEstavel(snapshotConfirmacao(base, auditoria))).digest("hex");
}

function empresaPreparacaoCompativel(auditoria, empresaId) {
    const preparada = String(auditoria?.conta_azul?.empresa_id || "");
    const atual = String(empresaId || "");
    return Boolean(preparada && atual && preparada === atual);
}

const ESTADOS_PILOTO_ATIVO = new Set([
    "PREPARACAO_AGENDADA", "PREPARANDO", "PREPARACAO_INCERTA",
    "PREVIA_CONFERIDA", "PREVIA_DIVERGENTE",
    "CONFIRMACAO_AGENDADA", "CONFIRMANDO", "CONFIRMACAO_INCERTA", "CONFIRMADO",
]);

function avaliarControlePiloto({ itens = [], base, empresaId, loteLiberado = false } = {}) {
    if (loteLiberado) return { permitido: true, piloto_ativo: null };
    const empresa = String(empresaId || "");
    const candidato = String(base || "");
    const ativo = (itens || []).find((item) => String(item?.conta_azul?.empresa_id || "") === empresa
        && ESTADOS_PILOTO_ATIVO.has(String(item?.conta_azul?.status || "")));
    const pilotoAtivo = ativo?.base || null;
    return {
        permitido: !pilotoAtivo || String(pilotoAtivo) === candidato,
        piloto_ativo: pilotoAtivo,
    };
}

function loteLiberadoParaEmpresa(itens = [], empresaId) {
    const empresa = String(empresaId || "");
    if (!empresa) return false;
    return (itens || []).some((item) => {
        const conta = item?.conta_azul || {};
        return String(conta.empresa_id || "") === empresa
            && conta.status === "PILOTO_VALIDADO_NO_ERP"
            && Boolean(conta.validado_no_erp_em)
            && !Number.isNaN(Date.parse(conta.validado_no_erp_em));
    });
}

function lerConfig() { return lerJson(CONFIG_PATH, {}); }
function salvarConfig(config) { gravarAtomico(CONFIG_PATH, config); }

function resumoEmpresa(empresa) {
    return {
        id: String(empresa?.id_empresa || empresa?.id || ""),
        razao_social: String(empresa?.razao_social || empresa?.nome || ""),
        nome_fantasia: String(empresa?.nome_fantasia || empresa?.razao_social || empresa?.nome || ""),
        documento: String(empresa?.documento || ""),
    };
}

async function obterEstadoContaAzul() {
    const [empresaBruta, contas, centros] = await Promise.all([empresaConectada(), listarContasFinanceiras(), listarCentrosCusto()]);
    const empresa = resumoEmpresa(empresaBruta);
    const config = lerConfig();
    const confirmadoId = String(config?.conta_azul?.empresa_confirmada_id || "");
    return {
        conectada: true,
        empresa,
        empresa_confirmada: Boolean(confirmadoId && confirmadoId === empresa.id),
        empresa_confirmada_id: confirmadoId || null,
        contas_financeiras: contas.filter((item) => item.ativo !== false).map((item) => ({
            id: String(item.id), nome: String(item.nome), tipo: item.tipo || null, conta_padrao: Boolean(item.conta_padrao),
        })),
        centros_custo: centros.filter((item) => item.ativo !== false).map((item) => ({
            id: String(item.id), nome: String(item.nome), codigo: item.codigo || null, ativo: item.ativo !== false,
        })),
    };
}

async function confirmarEmpresa(idEmpresa) {
    const empresa = resumoEmpresa(await empresaConectada());
    if (!empresa.id || String(idEmpresa || "") !== empresa.id) throw new Error("A empresa conectada mudou. Atualize o painel antes de confirmar.");
    const config = lerConfig();
    config.conta_azul = config.conta_azul || {};
    config.conta_azul.empresa_confirmada_id = empresa.id;
    config.conta_azul.empresa_confirmada_nome = empresa.nome_fantasia || empresa.razao_social;
    salvarConfig(config);
    return empresa;
}

async function exigirEmpresaConfirmada(idInformado = null) {
    const empresa = resumoEmpresa(await empresaConectada());
    const config = lerConfig();
    const confirmado = String(config?.conta_azul?.empresa_confirmada_id || "");
    if (!confirmado || confirmado !== empresa.id) throw new Error("Confirme no painel qual empresa do Conta Azul esta conectada antes de continuar.");
    if (idInformado && String(idInformado) !== empresa.id) throw new Error("Confirmacao pertence a outra empresa do Conta Azul.");
    return empresa;
}

function sincronizarCentrosLocais(centrosRemotos) {
    const anteriores = lerJson(CENTROS_PATH, []);
    const porId = new Map((Array.isArray(anteriores) ? anteriores : []).map((item) => [String(item.id), item]));
    const centros = centrosRemotos.filter((item) => item?.id && item?.nome && item.ativo !== false).map((item) => ({
        nome: String(item.nome), id: String(item.id), codigo: item.codigo || undefined,
        apelidos: porId.get(String(item.id))?.apelidos || [],
    }));
    gravarAtomico(CENTROS_PATH, centros);
    return centros;
}

async function sincronizarCentrosCusto(idEmpresa) {
    await exigirEmpresaConfirmada(idEmpresa);
    return sincronizarCentrosLocais(await listarCentrosCusto());
}

async function criarCentroCusto({ nome, codigo = null, idEmpresa }) {
    await exigirEmpresaConfirmada(idEmpresa);
    const nomeLimpo = String(nome || "").trim().replace(/\s+/g, " ");
    const codigoLimpo = String(codigo || "").trim().replace(/\s+/g, " ");
    if (nomeLimpo.length < 2 || nomeLimpo.length > 120) throw new Error("Informe um nome entre 2 e 120 caracteres.");
    if (codigoLimpo.length > 40) throw new Error("O codigo deve ter no maximo 40 caracteres.");
    const atuais = await listarCentrosCusto();
    if (atuais.some((item) => normalizar(item.nome) === normalizar(nomeLimpo))) throw new Error("Ja existe um centro de custo com esse nome no Conta Azul.");
    if (codigoLimpo && atuais.some((item) => normalizar(item.codigo) === normalizar(codigoLimpo))) throw new Error("Ja existe um centro de custo com esse codigo no Conta Azul.");
    const criado = await criarCentroCustoRemoto({ nome: nomeLimpo, codigo: codigoLimpo || null });
    const centros = await sincronizarCentrosCusto(idEmpresa);
    return { criado: { id: criado.id, nome: criado.nome, codigo: criado.codigo || null, ativo: criado.ativo !== false }, centros };
}

function regrasAtuais() { return lerJson(path.join(RAIZ, "configuracao", "regras.json"), {}); }

async function validarCatalogosRemotos(auditoria) {
    const [categorias, centros] = await Promise.all([listarCategoriasDespesa(), listarCentrosCusto()]);
    const categoriaId = String(auditoria.classificacao?.categoria_id || "");
    const centroId = String(auditoria.classificacao?.centro_custo_id || "");
    if (!categorias.some((item) => String(item.id) === categoriaId && item.ativo !== false)) throw new Error("A categoria configurada nao existe ou nao esta ativa na empresa conectada.");
    if (!centros.some((item) => String(item.id) === centroId && item.ativo !== false)) throw new Error("O centro de custo configurado nao existe ou nao esta ativo na empresa conectada.");
}

function salvarResposta(base, sufixo, resposta) {
    gravarAtomico(path.join(ENVIOS_DIR, `${baseSegura(base)}_${sufixo}.json`), resposta);
}

function conferirRespostaPrevia(base, auditoria, resposta, empresaId) {
    if (!empresaPreparacaoCompativel(auditoria, empresaId)) {
        throw new Error("A previa foi preparada em outra empresa do Conta Azul ou nao possui empresa vinculada.");
    }
    const previa = resumirPrevia(resposta);
    const candidata = copiarJson(auditoria);
    candidata.conta_azul = { ...(candidata.conta_azul || {}), empresa_id: String(empresaId), previa };
    const divergencias = compararPrevia(candidata, previa);
    const snapshot = snapshotConfirmacao(base, candidata);
    const token = crypto.createHash("sha256").update(jsonEstavel(snapshot)).digest("hex");
    return { previa, divergencias, snapshot, token };
}

function eventoAceitoInequivoco(resposta, auditoria) {
    const evento = resposta?.evento_financeiro || null;
    const motivos = [];
    if (resposta?.status !== "ACEITA") motivos.push("O status remoto nao confirmou o aceite da captura.");
    if (!evento?.id) motivos.push("O Conta Azul nao devolveu o ID do evento financeiro criado.");
    if (evento?.tipo !== "DESPESA") motivos.push("O evento financeiro devolvido nao e uma DESPESA.");
    if (centavos(evento?.valor) !== centavos(auditoria?.ocr?.valor)) motivos.push("O valor do evento financeiro criado nao confere com a auditoria.");
    if (String(evento?.data_competencia || "") !== String(auditoria?.ocr?.data || "")) motivos.push("A competencia do evento financeiro criado nao confere com a auditoria.");
    return { confirmado: motivos.length === 0, evento: evento || {}, motivos };
}

function dataComparavel(valor) {
    const texto = String(valor || "").trim();
    if (dataIsoValida(texto)) return texto;
    const brasileira = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto);
    if (!brasileira) return null;
    const iso = `${brasileira[3]}-${brasileira[2]}-${brasileira[1]}`;
    return dataIsoValida(iso) ? iso : null;
}

function referenciaExternaDaAuditoria(auditoria, referenciaInformada = null) {
    const conta = auditoria?.conta_azul || {};
    const previa = conta.previa || conta.snapshot_confirmacao?.previa || {};
    const candidatos = [
        referenciaInformada, previa.referencia_externa, conta.referencia_externa,
        auditoria?.ocr?.referencia_externa, auditoria?.ocr?.codigo_referencia,
    ];
    for (const valor of candidatos) {
        const texto = String(valor ?? "").trim();
        if (texto) return texto;
    }
    return null;
}

function construirContextoReconciliacao(auditoria, { empresaId, referenciaExterna = null } = {}) {
    const conta = auditoria?.conta_azul || {};
    const previa = conta.previa || conta.snapshot_confirmacao?.previa || {};
    const parcelas = Array.isArray(previa.parcelas) ? previa.parcelas : [];
    const contexto = {
        empresa_id: String(empresaId || ""),
        empresa_preparacao_id: String(conta.empresa_id || ""),
        tipo: String(previa.tipo || "DESPESA"),
        valor_centavos: centavos(auditoria?.ocr?.valor),
        data_competencia: dataComparavel(auditoria?.ocr?.data),
        data_vencimento: dataComparavel(parcelas[0]?.data_vencimento || auditoria?.ocr?.data),
        quantidade_parcelas: parcelas.length || null,
        fornecedor_id: String(previa.fornecedor?.id || ""),
        fornecedor_cnpj: somenteDigitos(auditoria?.ocr?.cnpj),
        categoria_id: String(auditoria?.classificacao?.categoria_id || ""),
        centro_custo_id: String(auditoria?.classificacao?.centro_custo_id || ""),
        referencia_externa: referenciaExternaDaAuditoria(auditoria, referenciaExterna),
    };
    const impedimentos = [];
    if (!contexto.empresa_id || contexto.empresa_id !== contexto.empresa_preparacao_id) {
        impedimentos.push("A empresa conectada nao corresponde a empresa em que a captura foi preparada.");
    }
    if (contexto.tipo !== "DESPESA") impedimentos.push("O contexto local nao identifica uma DESPESA.");
    if (contexto.valor_centavos == null || contexto.valor_centavos <= 0) impedimentos.push("O valor local nao e valido.");
    if (!contexto.data_competencia) impedimentos.push("A competencia local nao e valida.");
    if (!contexto.data_vencimento) impedimentos.push("O vencimento local nao e valido.");
    if (contexto.quantidade_parcelas !== 1) impedimentos.push("A reconciliacao automatica exige exatamente uma parcela esperada.");
    if (!uuidValido(contexto.fornecedor_id)) impedimentos.push("O contato/fornecedor esperado nao possui UUID valido.");
    if (!contexto.fornecedor_cnpj) impedimentos.push("O CNPJ local do fornecedor esta ausente.");
    if (!uuidValido(contexto.categoria_id)) impedimentos.push("A categoria local nao possui UUID valido.");
    if (!uuidValido(contexto.centro_custo_id)) impedimentos.push("O centro de custo local nao possui UUID valido.");
    return { ...contexto, impedimentos };
}

function construirFiltrosReconciliacao(contexto) {
    if (contexto?.impedimentos?.length) return null;
    const valor = (Number(contexto.valor_centavos) / 100).toFixed(2);
    return {
        pagina: 1,
        tamanho_pagina: 100,
        data_vencimento_de: contexto.data_vencimento,
        data_vencimento_ate: contexto.data_vencimento,
        data_competencia_de: contexto.data_competencia,
        data_competencia_ate: contexto.data_competencia,
        valor_de: valor,
        valor_ate: valor,
        ids_categorias: [contexto.categoria_id],
        ids_centros_de_custo: [contexto.centro_custo_id],
    };
}

function idsUnicos(lista, chaves) {
    const resultado = [];
    for (const item of Array.isArray(lista) ? lista : []) {
        for (const chave of chaves) {
            const valor = String(item?.[chave] || "").trim();
            if (valor) { resultado.push(valor); break; }
        }
    }
    return [...new Set(resultado)].sort();
}

function conjuntoExato(valores, esperado) {
    const unicos = [...new Set((valores || []).map(String).filter(Boolean))];
    return unicos.length === 1 && unicos[0] === String(esperado || "");
}

function somaCentavos(lista, obterValor) {
    return (lista || []).reduce((total, item) => {
        const valor = centavos(obterValor(item));
        return valor == null ? Number.NaN : total + valor;
    }, 0);
}

function anexosDoDetalhe(detalhe) {
    const diretos = Array.isArray(detalhe?.anexos) ? detalhe.anexos : [];
    const baixas = (Array.isArray(detalhe?.baixas) ? detalhe.baixas : [])
        .flatMap((baixa) => Array.isArray(baixa?.anexos) ? baixa.anexos : []);
    return [...diretos, ...baixas];
}

function avaliarCandidatoReconciliacao(contexto, candidato = {}) {
    const resumo = candidato.resumo || {};
    const detalhe = candidato.detalhe || {};
    const pessoa = candidato.pessoa || {};
    const evento = detalhe.evento || {};
    const motivos = [...(contexto?.impedimentos || [])];
    if (candidato.erro_consulta) motivos.push(`Nao foi possivel consultar todos os detalhes: ${candidato.erro_consulta}`);

    const parcelaId = String(resumo.id || "");
    if (!uuidValido(parcelaId) || String(detalhe.id || "") !== parcelaId) {
        motivos.push("O ID da parcela do resumo nao confere com o detalhe retornado.");
    }
    if (!uuidValido(evento.id)) motivos.push("O detalhe nao possui um ID de evento financeiro valido.");
    if (evento.tipo !== "DESPESA") motivos.push("O evento encontrado nao e uma DESPESA.");
    if (["CANCELADO", "CANCELLED", "EXCLUIDO"].includes(String(detalhe.status || resumo.status || "").toUpperCase())) {
        motivos.push("A parcela encontrada esta cancelada ou excluida.");
    }
    if (centavos(resumo.total) !== contexto.valor_centavos
        || centavos(detalhe?.valor_composicao?.valor_bruto) !== contexto.valor_centavos) {
        motivos.push("O valor da despesa/parcela encontrada nao confere com o valor local.");
    }
    if (dataComparavel(resumo.data_competencia) !== contexto.data_competencia
        || dataComparavel(evento.data_competencia) !== contexto.data_competencia) {
        motivos.push("A competencia da despesa encontrada nao confere com a competencia local.");
    }
    if (dataComparavel(resumo.data_vencimento) !== contexto.data_vencimento
        || dataComparavel(detalhe.data_vencimento) !== contexto.data_vencimento) {
        motivos.push("O vencimento da parcela encontrada nao confere com o esperado.");
    }

    const fornecedor = resumo.fornecedor || resumo.contato || evento.fornecedor || evento.contato || {};
    const fornecedorId = String(fornecedor.id || fornecedor.id_pessoa || fornecedor.id_contato || "");
    if (fornecedorId !== contexto.fornecedor_id) motivos.push("O contato/fornecedor da despesa nao confere com a previa.");
    if (String(pessoa.id || "") !== fornecedorId || somenteDigitos(pessoa.documento) !== contexto.fornecedor_cnpj) {
        motivos.push("O cadastro do fornecedor nao confere com o CNPJ local.");
    }
    if (Array.isArray(pessoa.perfis) && pessoa.perfis.length
        && !pessoa.perfis.some((perfil) => normalizar(typeof perfil === "string" ? perfil : (perfil?.tipo_perfil || perfil?.tipo)) === "fornecedor")) {
        motivos.push("O contato encontrado nao possui perfil de fornecedor.");
    }

    const rateios = Array.isArray(evento.rateio) ? evento.rateio : [];
    const categoriasResumo = idsUnicos(resumo.categorias, ["id", "id_categoria"]);
    const categoriasDetalhe = idsUnicos(rateios, ["id_categoria", "id"]);
    if (!conjuntoExato(categoriasResumo, contexto.categoria_id)
        || !conjuntoExato(categoriasDetalhe, contexto.categoria_id)
        || somaCentavos(rateios, (rateio) => rateio.valor_bruto ?? rateio.valor) !== contexto.valor_centavos) {
        motivos.push("A categoria ou o valor de seu rateio nao confere com a classificacao local.");
    }

    const centrosRateio = rateios.flatMap((rateio) => Array.isArray(rateio.rateio_centro_custo) ? rateio.rateio_centro_custo : []);
    const centrosResumo = idsUnicos(resumo.centros_de_custo || resumo.centros_custo, ["id", "id_centro_custo"]);
    const centrosDetalhe = idsUnicos(centrosRateio, ["id_centro_custo", "id"]);
    if (!conjuntoExato(centrosResumo, contexto.centro_custo_id)
        || !conjuntoExato(centrosDetalhe, contexto.centro_custo_id)
        || somaCentavos(centrosRateio, (centro) => centro.valor_bruto ?? centro.valor) !== contexto.valor_centavos) {
        motivos.push("O centro de custo ou o valor de seu rateio nao confere com a classificacao local.");
    }

    const referenciaRemota = String(evento.codigo_referencia
        ?? detalhe.codigo_referencia
        ?? (typeof detalhe.referencia === "string" ? detalhe.referencia : "")
        ?? "").trim();
    if (contexto.referencia_externa && referenciaRemota !== contexto.referencia_externa) {
        motivos.push("O codigo de referencia externo nao confere com a captura.");
    }

    const anexos = anexosDoDetalhe(detalhe);
    const avisos = ["A reconciliacao automatica nao libera o lote; o lancamento ainda deve ser aberto e conferido no ERP."];
    if (!anexos.length) avisos.push("A API financeira nao informou anexo nesta consulta; confirme a imagem visualmente no Conta Azul.");
    return {
        valido: motivos.length === 0,
        motivos,
        avisos,
        parcela_id: parcelaId || null,
        evento_id: evento.id || null,
        evento_tipo: evento.tipo || null,
        evento_valor: contexto.valor_centavos == null ? null : contexto.valor_centavos / 100,
        evento_data_competencia: dataComparavel(evento.data_competencia),
        fornecedor_id: fornecedorId || null,
        referencia_externa: referenciaRemota || null,
        anexo_localizado_na_api: anexos.length > 0,
    };
}

function selecionarReconciliacaoInequivoca(contexto, candidatos = [], { totalRemoto = null } = {}) {
    const avaliados = candidatos.map((candidato) => ({
        candidato,
        avaliacao: candidato.avaliacao || avaliarCandidatoReconciliacao(contexto, candidato),
    }));
    const validos = avaliados.filter((item) => item.avaliacao.valido);
    const motivos = [];
    if (contexto?.impedimentos?.length) motivos.push(...contexto.impedimentos);
    if (avaliados.some((item) => Boolean(item.candidato.erro_consulta))) {
        motivos.push("Ao menos um candidato nao teve seus detalhes completamente consultados.");
    }
    if (Number.isFinite(Number(totalRemoto)) && Number(totalRemoto) > candidatos.length) {
        motivos.push("A resposta da busca foi paginada e nem todos os candidatos puderam ser avaliados.");
    }
    if (validos.length === 0) motivos.push("Nenhuma conta a pagar correspondeu integralmente ao contexto local.");
    if (validos.length > 1) motivos.push("Mais de uma conta a pagar correspondeu integralmente ao contexto local.");
    const confirmado = motivos.length === 0 && validos.length === 1;
    return {
        confirmado,
        motivos: [...new Set(motivos)],
        candidatos_encontrados: candidatos.length,
        candidatos_validos: validos.length,
        avaliacoes: avaliados.map((item) => ({
            parcela_id: item.avaliacao.parcela_id,
            evento_id: item.avaliacao.evento_id,
            valido: item.avaliacao.valido,
            motivos: item.avaliacao.motivos,
        })),
        ...(confirmado ? validos[0].avaliacao : {}),
    };
}

async function reconciliarContaPagarAceita(auditoria, opcoes = {}) {
    const contexto = construirContextoReconciliacao(auditoria, opcoes);
    const filtros = construirFiltrosReconciliacao(contexto);
    if (!filtros) return selecionarReconciliacaoInequivoca(contexto, []);
    const buscar = opcoes.buscar || buscarContasPagar;
    const obterParcela = opcoes.obterParcela || obterParcelaFinanceira;
    const obterPessoa = opcoes.obterPessoa || obterPessoaPorId;
    const resposta = await buscar(filtros);
    const itensBrutos = resposta?.itens || resposta?.items || (Array.isArray(resposta) ? resposta : []);
    const itens = [...new Map(itensBrutos.filter((item) => item?.id).map((item) => [String(item.id), item])).values()];
    const candidatos = await Promise.all(itens.map(async (resumo) => {
        try {
            const detalhe = await obterParcela(resumo.id);
            const fornecedor = resumo.fornecedor || resumo.contato || detalhe?.evento?.fornecedor || detalhe?.evento?.contato || {};
            const fornecedorId = fornecedor.id || fornecedor.id_pessoa || fornecedor.id_contato;
            if (!fornecedorId) return { resumo, detalhe, pessoa: {}, erro_consulta: "Fornecedor sem identificador na resposta financeira." };
            const pessoa = await obterPessoa(fornecedorId);
            return { resumo, detalhe, pessoa };
        } catch (erro) {
            return { resumo, detalhe: {}, pessoa: {}, erro_consulta: String(erro?.message || erro).slice(0, 300) };
        }
    }));
    const totalRemoto = Number(resposta?.itens_totais ?? resposta?.items_total ?? itens.length);
    return { ...selecionarReconciliacaoInequivoca(contexto, candidatos, { totalRemoto }), filtros };
}

function referenciaExternaPersistida(base, auditoria) {
    const direta = referenciaExternaDaAuditoria(auditoria);
    if (direta) return direta;
    for (const sufixo of ["previa_revalidada", "previa", "verificacao"]) {
        const resposta = lerJson(path.join(ENVIOS_DIR, `${baseSegura(base)}_${sufixo}.json`), null);
        const referencia = String(resposta?.previa_evento_financeiro?.referencia_externa || "").trim();
        if (referencia) return referencia;
    }
    return null;
}

function novoAgendamento(tipo, empresaId) {
    return {
        id: crypto.randomUUID(),
        tipo,
        empresa_id: String(empresaId || ""),
        instancia_id: INSTANCIA_PROCESSO,
        processo_id: process.pid,
        criado_em: new Date().toISOString(),
    };
}

function agendamentoCompativel(conta, tipo, empresaId, agendamentoId) {
    const agendamento = conta?.agendamento || {};
    return Boolean(agendamentoId
        && String(agendamento.id || "") === String(agendamentoId)
        && agendamento.tipo === tipo
        && String(agendamento.empresa_id || "") === String(empresaId || "")
        && String(agendamento.instancia_id || "") === INSTANCIA_PROCESSO);
}

async function prepararDocumento(base, idEmpresa, contexto = {}) {
    const nomeBase = baseSegura(base);
    if (emExecucao.has(nomeBase)) return;
    emExecucao.add(nomeBase);
    let iniciouPreparacao = false;
    try {
        const empresa = await exigirEmpresaConfirmada(idEmpresa);
        const empresaId = String(empresa.id);
        const imagem = localizarImagem(nomeBase, ["simulacao"]);
        const { auditoria } = carregarAuditoria(nomeBase);
        const contaInicial = auditoria.conta_azul || {};
        if (contaInicial.empresa_id && String(contaInicial.empresa_id) !== empresaId) {
            throw new Error("Este documento foi preparado ou agendado em outra empresa do Conta Azul.");
        }
        const veioDaFila = contaInicial.status === "PREPARACAO_AGENDADA";
        if (veioDaFila && !agendamentoCompativel(contaInicial, "PREPARAR", empresaId, contexto.agendamentoId)) {
            throw new Error("O agendamento persistido da preparacao nao corresponde a este trabalho.");
        }
        const prontidao = avaliarProntidao(auditoria, {
            imagemExiste: Boolean(imagem),
            confiancaMinima: Number(regrasAtuais().confianca_minima || 0.95),
            statusPermitidos: veioDaFila ? ["PREPARACAO_AGENDADA"] : [],
        });
        if (!prontidao.pronto) throw new Error(prontidao.impedimentos.join(" "));

        atualizarAuditoria(nomeBase, (anterior) => ({
            ...anterior,
            empresa_id: empresaId,
            status: "PREPARANDO",
            execucao_instancia: INSTANCIA_PROCESSO,
            erro: null,
            preparado_em: null,
            token_confirmacao: null,
            snapshot_confirmacao: null,
            tentativas: registrarTentativa(anterior, "PREPARAR", "INICIADO"),
        }));
        iniciouPreparacao = true;
        await validarCatalogosRemotos(auditoria);

        let conta = carregarAuditoria(nomeBase).auditoria.conta_azul || {};
        let documentoId = conta.documento_id;
        if (!documentoId) {
            const upload = await enviarDocumento(imagem.caminho);
            if (!upload?.id) throw new Error("O Conta Azul nao devolveu o ID do documento enviado.");
            documentoId = upload.id;
            salvarResposta(nomeBase, "upload", upload);
            conta = atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior, status: "PREPARANDO", empresa_id: empresaId, documento_id: documentoId,
                execucao_instancia: INSTANCIA_PROCESSO,
                tentativas: registrarTentativa(anterior, "UPLOAD", "CONCLUIDO"),
            })).conta_azul;
        }
        const capturaId = conta.captura_id || await aguardarCaptura(documentoId, 300);
        if (!capturaId) throw new Error("O Conta Azul nao devolveu o ID da captura.");
        atualizarAuditoria(nomeBase, (anterior) => ({ ...anterior, empresa_id: empresaId, captura_id: capturaId }));
        const resposta = await obterPreviaCaptura(capturaId);
        salvarResposta(nomeBase, "previa", resposta);
        const atual = carregarAuditoria(nomeBase).auditoria;
        if (resposta?.status !== "PENDENTE") {
            throw new Error(`A captura nao esta pendente para conferencia (status: ${resposta?.status || "DESCONHECIDO"}).`);
        }
        const conferencia = conferirRespostaPrevia(nomeBase, atual, resposta, empresaId);
        const preparadoEm = new Date().toISOString();
        const gravada = atualizarAuditoria(nomeBase, (anterior) => ({
            ...anterior,
            empresa_id: empresaId,
            status: conferencia.divergencias.length ? "PREVIA_DIVERGENTE" : "PREVIA_CONFERIDA",
            captura_id: capturaId,
            status_remoto: resposta.status,
            previa: conferencia.previa,
            divergencias: conferencia.divergencias,
            snapshot_confirmacao: conferencia.snapshot,
            token_confirmacao: conferencia.divergencias.length ? null : conferencia.token,
            preparado_em: preparadoEm,
            agendamento: null,
            execucao_instancia: null,
            erro: null,
            tentativas: registrarTentativa(anterior, "PREVIA", conferencia.divergencias.length ? "DIVERGENTE" : "CONFERIDA"),
        }));
        return gravada.conta_azul;
    } catch (erro) {
        try {
            const atual = carregarAuditoria(nomeBase).auditoria.conta_azul || {};
            if (!iniciouPreparacao && atual.status !== "PREPARACAO_AGENDADA") throw erro;
            atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior,
                status: anterior.documento_id || !erroPreparacaoPermiteNovaTentativa(erro) ? "PREPARACAO_INCERTA" : "ERRO_PREPARACAO",
                erro: erro.message,
                agendamento: null,
                execucao_instancia: null,
                token_confirmacao: null,
                tentativas: registrarTentativa(anterior, "PREPARAR", "ERRO", erro.message),
            }));
        } catch (_) { /* falha ocorreu antes de iniciar a preparacao */ }
        throw erro;
    } finally {
        emExecucao.delete(nomeBase);
    }
}

function moverParaEnviados(base) {
    const imagem = localizarImagem(base, ["simulacao"]);
    if (!imagem) return;
    const destino = path.join(RAIZ, "dados", "enviados");
    fs.mkdirSync(destino, { recursive: true });
    const origemBase = imagem.caminho.replace(/\.[^.]+$/, "");
    for (const arquivo of [imagem.caminho, `${origemBase}.txt`, `${origemBase}.json`]) {
        if (fs.existsSync(arquivo)) fs.renameSync(arquivo, path.join(destino, path.basename(arquivo)));
    }
}

async function confirmarDocumento(base, { idEmpresa, token, agendamentoId = null }) {
    const nomeBase = baseSegura(base);
    if (emExecucao.has(nomeBase)) throw new Error("Este documento ja esta sendo processado.");
    emExecucao.add(nomeBase);
    try {
        const empresa = await exigirEmpresaConfirmada(idEmpresa);
        const empresaId = String(empresa.id);
        let { auditoria } = carregarAuditoria(nomeBase);
        const contaInicial = auditoria.conta_azul || {};
        if (!empresaPreparacaoCompativel(auditoria, empresaId)) throw new Error("A previa pertence a outra empresa do Conta Azul ou nao possui empresa vinculada.");
        const veioDaFila = contaInicial.status === "CONFIRMACAO_AGENDADA";
        if (veioDaFila && !agendamentoCompativel(contaInicial, "CONFIRMAR", empresaId, agendamentoId)) {
            throw new Error("O agendamento persistido da confirmacao nao corresponde a este trabalho.");
        }
        if (!veioDaFila && contaInicial.status !== "PREVIA_CONFERIDA") throw new Error("A previa ainda nao foi conferida ou possui divergencias.");
        const tokenAtual = tokenConfirmacao(nomeBase, auditoria);
        if (!token || token !== tokenAtual || token !== contaInicial.token_confirmacao) {
            atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior, status: "PREVIA_CONFERIDA", agendamento: null, execucao_instancia: null,
                token_confirmacao: tokenAtual, snapshot_confirmacao: snapshotConfirmacao(nomeBase, auditoria),
                erro: "O snapshot local mudou antes da confirmacao.",
                tentativas: registrarTentativa(anterior, "REVALIDAR_PREVIA", "TOKEN_LOCAL_ALTERADO"),
            }));
            throw new Error("A previa ou a auditoria local mudou. Atualize o painel e confirme novamente.");
        }
        const capturaId = contaInicial.captura_id;
        if (!capturaId) throw new Error("ID da captura ausente.");

        const respostaPrevia = await obterPreviaCaptura(capturaId);
        salvarResposta(nomeBase, "previa_revalidada", respostaPrevia);
        if (respostaPrevia?.status !== "PENDENTE") {
            const statusLocal = respostaPrevia?.status === "REJEITADA" ? "REJEITADO" : "CONFIRMACAO_INCERTA";
            atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior, status: statusLocal, status_remoto: respostaPrevia?.status || null,
                agendamento: null, token_confirmacao: null,
                execucao_instancia: null,
                erro: `A captura deixou de estar PENDENTE antes do aceite (status: ${respostaPrevia?.status || "DESCONHECIDO"}).`,
                tentativas: registrarTentativa(anterior, "REVALIDAR_PREVIA", respostaPrevia?.status || "DESCONHECIDO"),
            }));
            throw new Error("O estado remoto mudou antes do aceite. Use Verificar status e confira o Conta Azul.");
        }

        auditoria = carregarAuditoria(nomeBase).auditoria;
        const conferencia = conferirRespostaPrevia(nomeBase, auditoria, respostaPrevia, empresaId);
        const tokenAnterior = contaInicial.token_confirmacao;
        if (conferencia.divergencias.length) {
            atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior, status: "PREVIA_DIVERGENTE", status_remoto: respostaPrevia.status,
                previa: conferencia.previa, divergencias: conferencia.divergencias,
                snapshot_confirmacao: conferencia.snapshot, token_confirmacao: null,
                previa_revalidada_em: new Date().toISOString(), agendamento: null,
                execucao_instancia: null,
                erro: "A previa remota divergiu na revalidacao anterior ao aceite.",
                tentativas: registrarTentativa(anterior, "REVALIDAR_PREVIA", "DIVERGENTE"),
            }));
            throw new Error("A previa do Conta Azul mudou ou possui divergencias. Revise antes de confirmar.");
        }
        if (conferencia.token !== token || conferencia.token !== tokenAnterior) {
            atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior, status: "PREVIA_CONFERIDA", status_remoto: respostaPrevia.status,
                previa: conferencia.previa, divergencias: [],
                snapshot_confirmacao: conferencia.snapshot, token_confirmacao: conferencia.token,
                previa_revalidada_em: new Date().toISOString(), agendamento: null,
                execucao_instancia: null,
                erro: "A previa remota mudou sem gerar divergencia; uma nova confirmacao humana e obrigatoria.",
                tentativas: registrarTentativa(anterior, "REVALIDAR_PREVIA", "SNAPSHOT_ALTERADO"),
            }));
            throw new Error("A previa remota foi atualizada. Confira o novo snapshot e confirme novamente.");
        }

        atualizarAuditoria(nomeBase, (anterior) => ({
            ...anterior, status: "CONFIRMANDO", status_remoto: respostaPrevia.status,
            execucao_instancia: INSTANCIA_PROCESSO,
            previa: conferencia.previa, divergencias: [], snapshot_confirmacao: conferencia.snapshot,
            previa_revalidada_em: new Date().toISOString(), erro: null,
            tentativas: registrarTentativa(anterior, "CONFIRMAR", "INICIADO"),
        }));
        let resposta;
        try {
            resposta = await aceitarCaptura(capturaId);
        } catch (erro) {
            atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior, status: "CONFIRMACAO_INCERTA", erro: erro.message,
                agendamento: null, execucao_instancia: null, token_confirmacao: null,
                tentativas: registrarTentativa(anterior, "CONFIRMAR", "INCERTO", erro.message),
            }));
            throw new Error("A resposta do Conta Azul foi incerta. Nao clique novamente; use Verificar status.");
        }
        salvarResposta(nomeBase, "confirmacao", resposta);
        auditoria = carregarAuditoria(nomeBase).auditoria;
        const aceite = eventoAceitoInequivoco(resposta, auditoria);
        if (!aceite.confirmado) {
            atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior, status: "CONFIRMACAO_INCERTA", status_remoto: resposta?.status || null,
                erro: aceite.motivos.join(" "), agendamento: null, token_confirmacao: null,
                execucao_instancia: null,
                tentativas: registrarTentativa(anterior, "CONFIRMAR", "RESPOSTA_NAO_INEQUIVOCA", aceite.motivos.join(" ")),
            }));
            throw new Error("O Conta Azul nao devolveu uma confirmacao inequivoca do evento. Confira no ERP e use a validacao manual do piloto.");
        }
        const evento = aceite.evento;
        auditoria = atualizarAuditoria(nomeBase, (anterior) => ({
            ...anterior,
            status: "CONFIRMADO",
            empresa_id: empresaId,
            status_remoto: resposta.status,
            confirmado_em: new Date().toISOString(),
            evento_id: evento.id,
            evento_tipo: evento.tipo,
            evento_valor: Number(evento.valor),
            evento_data_competencia: evento.data_competencia,
            agendamento: null,
            execucao_instancia: null,
            token_confirmacao: null,
            erro: null,
            tentativas: registrarTentativa(anterior, "CONFIRMAR", "CONFIRMADO"),
        }));
        moverParaEnviados(nomeBase);
        return auditoria.conta_azul;
    } finally {
        emExecucao.delete(nomeBase);
    }
}

async function verificarDocumento(base, idEmpresa) {
    const nomeBase = baseSegura(base);
    if (emExecucao.has(nomeBase)) throw new Error("Este documento ja esta sendo processado.");
    emExecucao.add(nomeBase);
    try {
        const empresa = await exigirEmpresaConfirmada(idEmpresa);
        const empresaId = String(empresa.id);
        let { auditoria } = carregarAuditoria(nomeBase);
        if (!empresaPreparacaoCompativel(auditoria, empresaId)) throw new Error("Este envio pertence a outra empresa do Conta Azul ou nao possui empresa vinculada.");
        if (["CONFIRMADO", "PILOTO_VALIDADO_NO_ERP"].includes(auditoria.conta_azul?.status)) return auditoria.conta_azul;

        let capturaId = auditoria.conta_azul?.captura_id;
        if (!capturaId && auditoria.conta_azul?.documento_id) {
            capturaId = await aguardarCaptura(auditoria.conta_azul.documento_id, 120);
            atualizarAuditoria(nomeBase, (anterior) => ({ ...anterior, empresa_id: empresaId, captura_id: capturaId }));
        }
        if (!capturaId) throw new Error("Nao foi possivel localizar o upload. Confira a Conta AI Captura antes de tentar novamente.");
        const resposta = await obterPreviaCaptura(capturaId);
        salvarResposta(nomeBase, "verificacao", resposta);
        auditoria = carregarAuditoria(nomeBase).auditoria;

        if (resposta?.status === "ACEITA") {
            const aceite = eventoAceitoInequivoco(resposta, auditoria);
            if (aceite.confirmado) {
                const evento = aceite.evento;
                const atualizado = atualizarAuditoria(nomeBase, (anterior) => ({
                    ...anterior, status: "CONFIRMADO", status_remoto: resposta.status,
                    confirmado_em: anterior.confirmado_em || new Date().toISOString(),
                    evento_id: evento.id, evento_tipo: evento.tipo, evento_valor: Number(evento.valor),
                    evento_data_competencia: evento.data_competencia,
                    erro: null, agendamento: null, token_confirmacao: null,
                    execucao_instancia: null,
                    tentativas: registrarTentativa(anterior, "VERIFICAR", "CONFIRMADO_INEQUIVOCO"),
                }));
                moverParaEnviados(nomeBase);
                return atualizado.conta_azul;
            }
            if (!resposta?.evento_financeiro?.id) {
                let reconciliacao;
                try {
                    reconciliacao = await reconciliarContaPagarAceita(auditoria, {
                        empresaId,
                        referenciaExterna: referenciaExternaPersistida(nomeBase, auditoria),
                    });
                } catch (erro) {
                    reconciliacao = {
                        confirmado: false,
                        motivos: [`Falha ao consultar as contas a pagar para reconciliacao: ${String(erro?.message || erro).slice(0, 400)}`],
                        candidatos_encontrados: 0,
                        candidatos_validos: 0,
                    };
                }
                salvarResposta(nomeBase, "reconciliacao", reconciliacao);
                if (reconciliacao.confirmado) {
                    const atualizado = atualizarAuditoria(nomeBase, (anterior) => ({
                        ...anterior,
                        status: "CONFIRMADO",
                        status_remoto: resposta.status,
                        confirmado_em: anterior.confirmado_em || new Date().toISOString(),
                        evento_id: reconciliacao.evento_id,
                        parcela_id: reconciliacao.parcela_id,
                        evento_tipo: reconciliacao.evento_tipo,
                        evento_valor: Number(reconciliacao.evento_valor),
                        evento_data_competencia: reconciliacao.evento_data_competencia,
                        reconciliacao_financeira: {
                            metodo: "BUSCA_E_DETALHE_CONTA_A_PAGAR",
                            empresa_id: empresaId,
                            parcela_id: reconciliacao.parcela_id,
                            evento_id: reconciliacao.evento_id,
                            fornecedor_id: reconciliacao.fornecedor_id,
                            referencia_externa: reconciliacao.referencia_externa,
                            anexo_localizado_na_api: reconciliacao.anexo_localizado_na_api,
                            avisos: reconciliacao.avisos,
                            reconciliado_em: new Date().toISOString(),
                            exige_conferencia_visual_no_erp: true,
                            libera_lote_automaticamente: false,
                        },
                        erro: null,
                        agendamento: null,
                        token_confirmacao: null,
                        execucao_instancia: null,
                        tentativas: registrarTentativa(anterior, "VERIFICAR", "RECONCILIADO_CONTAS_A_PAGAR"),
                    }));
                    moverParaEnviados(nomeBase);
                    return atualizado.conta_azul;
                }
                const mensagem = (reconciliacao.motivos || []).join(" ")
                    || "Nao foi possivel associar de forma inequivoca a captura aceita a uma conta a pagar.";
                return atualizarAuditoria(nomeBase, (anterior) => ({
                    ...anterior,
                    status: "CONFIRMACAO_INCERTA",
                    status_remoto: resposta.status,
                    reconciliacao_financeira: {
                        metodo: "BUSCA_E_DETALHE_CONTA_A_PAGAR",
                        empresa_id: empresaId,
                        candidatos_encontrados: reconciliacao.candidatos_encontrados || 0,
                        candidatos_validos: reconciliacao.candidatos_validos || 0,
                        avaliacoes: reconciliacao.avaliacoes || [],
                        verificado_em: new Date().toISOString(),
                        exige_conferencia_visual_no_erp: true,
                        libera_lote_automaticamente: false,
                    },
                    erro: mensagem,
                    agendamento: null,
                    token_confirmacao: null,
                    execucao_instancia: null,
                    tentativas: registrarTentativa(anterior, "VERIFICAR", "RECONCILIACAO_NAO_INEQUIVOCA", mensagem),
                })).conta_azul;
            }
            return atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior, status: "CONFIRMACAO_INCERTA", status_remoto: resposta.status,
                erro: aceite.motivos.join(" "), agendamento: null, token_confirmacao: null,
                execucao_instancia: null,
                tentativas: registrarTentativa(anterior, "VERIFICAR", "ACEITA_SEM_EVENTO_INEQUIVOCO", aceite.motivos.join(" ")),
            })).conta_azul;
        }

        if (resposta?.status === "PENDENTE" && auditoria.conta_azul?.status === "CONFIRMACAO_INCERTA") {
            const previa = resumirPrevia(resposta);
            return atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior, status: "CONFIRMACAO_INCERTA", status_remoto: resposta.status,
                previa_verificada_apos_incerteza: previa, agendamento: null, token_confirmacao: null,
                execucao_instancia: null,
                erro: anterior.erro || "A confirmacao anterior continua incerta; PENDENTE nao prova que o POST nao criou o evento.",
                tentativas: registrarTentativa(anterior, "VERIFICAR", "PENDENTE_MANTEVE_INCERTEZA"),
            })).conta_azul;
        }

        if (resposta?.status === "PENDENTE") {
            const conferencia = conferirRespostaPrevia(nomeBase, auditoria, resposta, empresaId);
            return atualizarAuditoria(nomeBase, (anterior) => ({
                ...anterior,
                empresa_id: empresaId,
                status: conferencia.divergencias.length ? "PREVIA_DIVERGENTE" : "PREVIA_CONFERIDA",
                status_remoto: resposta.status,
                previa: conferencia.previa,
                divergencias: conferencia.divergencias,
                snapshot_confirmacao: conferencia.snapshot,
                token_confirmacao: conferencia.divergencias.length ? null : conferencia.token,
                preparado_em: anterior.preparado_em || new Date().toISOString(),
                previa_revalidada_em: new Date().toISOString(),
                agendamento: null,
                execucao_instancia: null,
                erro: null,
                tentativas: registrarTentativa(anterior, "VERIFICAR", conferencia.divergencias.length ? "DIVERGENTE" : "CONFERIDA"),
            })).conta_azul;
        }

        return atualizarAuditoria(nomeBase, (anterior) => ({
            ...anterior,
            status: resposta?.status === "REJEITADA" ? "REJEITADO" : anterior.status,
            status_remoto: resposta?.status || null,
            agendamento: null,
            execucao_instancia: null,
            token_confirmacao: resposta?.status === "REJEITADA" ? null : anterior.token_confirmacao,
            tentativas: registrarTentativa(anterior, "VERIFICAR", resposta?.status || "DESCONHECIDO"),
        })).conta_azul;
    } finally {
        emExecucao.delete(nomeBase);
    }
}

function recuperarEstadoInterrompido(base, auditoria) {
    const conta = auditoria?.conta_azul || {};
    const status = String(conta.status || "");
    const agendamentoOutraInstancia = ["PREPARACAO_AGENDADA", "CONFIRMACAO_AGENDADA"].includes(status)
        && String(conta.agendamento?.instancia_id || "") !== INSTANCIA_PROCESSO;
    const execucaoOutraInstancia = ["PREPARANDO", "CONFIRMANDO"].includes(status)
        && String(conta.execucao_instancia || "") !== INSTANCIA_PROCESSO;
    if (!agendamentoOutraInstancia && !execucaoOutraInstancia) return auditoria;

    let novoStatus = status;
    let mensagem = "";
    if (status === "PREPARACAO_AGENDADA") {
        novoStatus = conta.documento_id ? "PREPARACAO_INCERTA" : "ERRO_PREPARACAO";
        mensagem = conta.documento_id
            ? "O processo reiniciou depois de existir um documento remoto; verifique a captura antes de continuar."
            : "O agendamento de preparacao foi interrompido antes de registrar um documento remoto e pode ser reagendado.";
    } else if (status === "CONFIRMACAO_AGENDADA") {
        novoStatus = "CONFIRMACAO_INCERTA";
        mensagem = "O processo reiniciou com uma confirmacao agendada; confira o ERP antes de qualquer nova tentativa.";
    } else if (status === "PREPARANDO") {
        novoStatus = "PREPARACAO_INCERTA";
        mensagem = "O processo reiniciou durante a preparacao; o upload pode ter ocorrido e precisa ser verificado.";
    } else if (status === "CONFIRMANDO") {
        novoStatus = "CONFIRMACAO_INCERTA";
        mensagem = "O processo reiniciou durante o aceite; o resultado precisa ser conferido no ERP.";
    } else {
        return auditoria;
    }

    return atualizarAuditoria(base, (anterior) => ({
        ...anterior,
        status: novoStatus,
        erro: mensagem,
        agendamento: null,
        execucao_instancia: null,
        token_confirmacao: novoStatus === "ERRO_PREPARACAO" ? anterior.token_confirmacao : null,
        tentativas: registrarTentativa(anterior, "RECUPERAR_REINICIO", novoStatus, mensagem),
    }));
}

function itemFila(base, auditoria) {
    const imagem = localizarImagem(base, ["simulacao", "enviados"]);
    const prontidao = avaliarProntidao(auditoria, {
        imagemExiste: Boolean(imagem && imagem.pasta === "simulacao"),
        confiancaMinima: Number(regrasAtuais().confianca_minima || 0.95),
    });
    return {
        base,
        arquivo: auditoria.arquivo_imagem || imagem?.nome || `${base}`,
        pasta: imagem?.pasta || null,
        fornecedor: auditoria.ocr?.fornecedor || null,
        cnpj: auditoria.ocr?.cnpj || null,
        confianca: Number.isFinite(Number(auditoria.ocr?.confianca)) ? Number(auditoria.ocr.confianca) : null,
        valor: Number(auditoria.ocr?.valor || 0),
        data: auditoria.ocr?.data || null,
        categoria: auditoria.classificacao?.categoria_nome || null,
        centro_custo: auditoria.classificacao?.centro_custo_nome || null,
        hash_imagem: auditoria.rastreabilidade?.sha256 || null,
        snapshot_confirmacao: auditoria.conta_azul?.snapshot_confirmacao || null,
        pronto: prontidao.pronto,
        impedimentos: prontidao.impedimentos,
        conta_azul: auditoria.conta_azul || { status: "NAO_ENVIADO" },
    };
}

function listarFila(idEmpresa = null) {
    if (!fs.existsSync(AUDITORIA_DIR)) return { itens: [], lote_liberado: false, piloto_ativo: null, processando: [...emExecucao] };
    const itens = [];
    for (const nome of fs.readdirSync(AUDITORIA_DIR).filter((item) => item.endsWith(".json") && item !== "indice-duplicidade.json" && !item.endsWith("_erro.json"))) {
        try {
            const base = path.parse(nome).name;
            const auditoria = recuperarEstadoInterrompido(base, lerJson(path.join(AUDITORIA_DIR, nome), {}));
            itens.push(itemFila(base, auditoria));
        } catch (_) { /* ignora auditoria incompleta */ }
    }
    itens.sort((a, b) => String(b.data || "").localeCompare(String(a.data || "")));
    const config = lerConfig();
    const empresaAtual = String(idEmpresa || config?.conta_azul?.empresa_confirmada_id || "");
    const loteLiberado = loteLiberadoParaEmpresa(itens, empresaAtual);
    const controle = avaliarControlePiloto({ itens, base: "", empresaId: empresaAtual, loteLiberado });
    return {
        itens,
        lote_liberado: loteLiberado,
        piloto_ativo: controle.piloto_ativo,
        empresa_lote_id: loteLiberado ? empresaAtual : null,
        processando: [...emExecucao],
    };
}

function agendarPreparacao(bases, idEmpresa) {
    const unicos = [...new Set((bases || []).map(baseSegura))];
    if (!unicos.length) throw new Error("Nenhum documento selecionado.");
    const empresaId = String(idEmpresa || "");
    if (!empresaId) throw new Error("Empresa do Conta Azul nao informada.");
    const fila = listarFila(empresaId);
    const porBase = new Map(fila.itens.map((item) => [item.base, item]));
    if (unicos.length > 1 && !fila.lote_liberado) throw new Error("Valide primeiro um piloto individual no ERP antes de liberar o lote.");
    for (const base of unicos) {
        const item = porBase.get(base);
        if (!item) throw new Error(`Documento ${base} nao encontrado.`);
        const controle = avaliarControlePiloto({ itens: fila.itens, base, empresaId, loteLiberado: fila.lote_liberado });
        if (!controle.permitido) throw new Error(`O piloto ${controle.piloto_ativo} ainda esta ativo. Valide-o no ERP antes de iniciar outro documento.`);
        if (!item.pronto || !["NAO_ENVIADO", "ERRO_PREPARACAO"].includes(item.conta_azul?.status || "NAO_ENVIADO")) {
            throw new Error(`Documento ${base} ainda nao esta pronto para preparar.`);
        }
        if (item.conta_azul?.empresa_id && String(item.conta_azul.empresa_id) !== empresaId) {
            throw new Error(`Documento ${base} pertence a outra empresa do Conta Azul.`);
        }
    }

    const trabalhos = unicos.map((base) => {
        const agendamento = novoAgendamento("PREPARAR", empresaId);
        atualizarAuditoria(base, (anterior) => ({
            ...anterior,
            status: "PREPARACAO_AGENDADA",
            empresa_id: empresaId,
            agendamento,
            execucao_instancia: null,
            erro: null,
            tentativas: registrarTentativa(anterior, "AGENDAR_PREPARACAO", "AGENDADO"),
        }));
        return { base, agendamentoId: agendamento.id };
    });
    filaTrabalho = filaTrabalho.then(async () => {
        for (const trabalho of trabalhos) {
            try { await prepararDocumento(trabalho.base, empresaId, { agendamentoId: trabalho.agendamentoId }); }
            catch (erro) { console.error(`Conta Azul - preparar ${trabalho.base}: ${erro.message}`); }
        }
    });
    return { agendados: unicos.length, ids_agendamento: trabalhos.map((item) => item.agendamentoId) };
}

function agendarConfirmacao(itens, idEmpresa) {
    const unicos = [...new Map((itens || []).map((item) => [baseSegura(item.base), item])).values()];
    if (!unicos.length) throw new Error("Nenhuma previa conferida selecionada.");
    const empresaId = String(idEmpresa || "");
    if (!empresaId) throw new Error("Empresa do Conta Azul nao informada.");
    const fila = listarFila(empresaId);
    const porBase = new Map(fila.itens.map((item) => [item.base, item]));
    if (unicos.length > 1 && !fila.lote_liberado) throw new Error("Valide primeiro um piloto individual no ERP antes de liberar o lote.");
    for (const item of unicos) {
        const salvo = porBase.get(item.base);
        if (salvo?.conta_azul?.status !== "PREVIA_CONFERIDA" || !item.token || item.token !== salvo.conta_azul.token_confirmacao) {
            throw new Error(`A previa de ${item.base} nao esta pronta ou mudou. Atualize o painel.`);
        }
        if (String(salvo.conta_azul.empresa_id || "") !== empresaId) throw new Error(`A previa de ${item.base} pertence a outra empresa do Conta Azul.`);
        const auditoria = carregarAuditoria(item.base).auditoria;
        if (item.token !== tokenConfirmacao(item.base, auditoria)) throw new Error(`O snapshot de ${item.base} mudou. Atualize o painel.`);
        const controle = avaliarControlePiloto({ itens: fila.itens, base: item.base, empresaId, loteLiberado: fila.lote_liberado });
        if (!controle.permitido) throw new Error(`O piloto ${controle.piloto_ativo} ainda esta ativo. Valide-o no ERP antes de confirmar outro documento.`);
    }

    const trabalhos = unicos.map((item) => {
        const agendamento = novoAgendamento("CONFIRMAR", empresaId);
        atualizarAuditoria(item.base, (anterior) => ({
            ...anterior,
            status: "CONFIRMACAO_AGENDADA",
            empresa_id: empresaId,
            agendamento,
            execucao_instancia: null,
            erro: null,
            tentativas: registrarTentativa(anterior, "AGENDAR_CONFIRMACAO", "AGENDADO"),
        }));
        return { ...item, agendamentoId: agendamento.id };
    });
    filaTrabalho = filaTrabalho.then(async () => {
        for (const item of trabalhos) {
            try { await confirmarDocumento(item.base, { idEmpresa: empresaId, token: item.token, agendamentoId: item.agendamentoId }); }
            catch (erro) { console.error(`Conta Azul - confirmar ${item.base}: ${erro.message}`); }
        }
    });
    return { agendados: unicos.length, ids_agendamento: trabalhos.map((item) => item.agendamentoId) };
}

async function marcarConfirmacaoManualPiloto(base, opcoes = {}) {
    const nomeBase = baseSegura(base);
    const idEmpresa = opcoes.idEmpresa || opcoes.id_empresa;
    const eventoInformado = String(opcoes.eventoId || opcoes.evento_id || "").trim();
    if (opcoes.confirmacao !== "CONFIRMEI_NO_ERP") {
        throw new Error("Confirme explicitamente que o lançamento foi aberto e conferido no ERP.");
    }
    if (!eventoInformado) throw new Error("Informe o ID do evento financeiro conferido no ERP.");
    if (emExecucao.has(nomeBase)) throw new Error("Este documento ainda esta sendo processado.");

    const empresa = await exigirEmpresaConfirmada(idEmpresa);
    const empresaId = String(empresa.id);
    const { auditoria } = carregarAuditoria(nomeBase);
    const conta = auditoria.conta_azul || {};
    if (!empresaPreparacaoCompativel(auditoria, empresaId)) throw new Error("O piloto pertence a outra empresa do Conta Azul.");
    if (conta.status === "PILOTO_VALIDADO_NO_ERP") {
        if (String(conta.evento_id || "") !== eventoInformado) throw new Error("O evento informado difere do piloto ja validado.");
        return conta;
    }
    if (!["CONFIRMADO", "CONFIRMACAO_INCERTA"].includes(conta.status)) {
        throw new Error("O piloto ainda nao chegou a um estado que possa ser conferido manualmente no ERP.");
    }
    if (conta.status === "CONFIRMADO" && String(conta.evento_id || "") !== eventoInformado) {
        throw new Error("O ID conferido no ERP difere do evento devolvido pela API.");
    }

    const fila = listarFila(empresaId);
    const controle = avaliarControlePiloto({ itens: fila.itens, base: nomeBase, empresaId, loteLiberado: false });
    if (!controle.permitido || (controle.piloto_ativo && controle.piloto_ativo !== nomeBase)) {
        throw new Error(`O piloto ativo desta empresa e ${controle.piloto_ativo || "outro documento"}.`);
    }
    const agora = new Date().toISOString();
    const atualizado = atualizarAuditoria(nomeBase, (anterior) => ({
        ...anterior,
        status: "PILOTO_VALIDADO_NO_ERP",
        empresa_id: empresaId,
        evento_id: eventoInformado,
        validado_no_erp_em: agora,
        validado_no_erp_por: String(opcoes.confirmadoPor || opcoes.confirmado_por || "usuario_local").slice(0, 120),
        confirmacao_manual_erp: {
            empresa_id: empresaId,
            evento_id: eventoInformado,
            confirmado_em: agora,
        },
        agendamento: null,
        execucao_instancia: null,
        token_confirmacao: null,
        erro: null,
        tentativas: registrarTentativa(anterior, "VALIDAR_PILOTO_NO_ERP", "CONFIRMADO_MANUALMENTE"),
    }));
    moverParaEnviados(nomeBase);
    return atualizado.conta_azul;
}

const marcarPilotoValidadoNoErp = marcarConfirmacaoManualPiloto;

module.exports = {
    normalizar, uuidValido, dataIsoValida, centavos, avaliarProntidao, resumirPrevia, compararPrevia,
    snapshotConfirmacao, tokenConfirmacao, empresaPreparacaoCompativel, avaliarControlePiloto, loteLiberadoParaEmpresa,
    dataComparavel, construirContextoReconciliacao, construirFiltrosReconciliacao,
    avaliarCandidatoReconciliacao, selecionarReconciliacaoInequivoca, reconciliarContaPagarAceita,
    obterEstadoContaAzul, confirmarEmpresa, sincronizarCentrosCusto, criarCentroCusto,
    prepararDocumento, confirmarDocumento, verificarDocumento, listarFila, agendarPreparacao, agendarConfirmacao,
    marcarConfirmacaoManualPiloto, marcarPilotoValidadoNoErp,
};
