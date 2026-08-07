"use strict";

const crypto = require("crypto");
const {
    criarDespesa,
    confirmarDespesa,
    dataIso,
    numeroPositivo,
    uuidValido,
} = require("./despesa-conta-azul");

const PENDENCIAS_DIRETO = Object.freeze([
    "A previa original continua pendente na Conta AI Captura; nao clicar em Criar nela.",
    "Conferir no ERP se o fornecedor e o CNPJ foram vinculados corretamente.",
    "Anexar a imagem do comprovante no lancamento.",
    "Conferir a conta financeira selecionada e informar a forma de pagamento.",
    "Conferir e, quando aplicavel, registrar a baixa do pagamento.",
]);

const ESTADOS_DIRETO = new Set([
    "DIRETO_AGENDADO",
    "DIRETO_ENVIANDO",
    "DIRETO_AGUARDANDO_CONFIRMACAO",
    "DIRETO_INCERTO",
    "DIRETO_CONFIRMADO_PENDENCIAS",
]);

function ordenar(valor) {
    if (Array.isArray(valor)) return valor.map(ordenar);
    if (!valor || typeof valor !== "object") return valor;
    return Object.fromEntries(Object.keys(valor).sort().map((chave) => [chave, ordenar(valor[chave])]));
}

function snapshotDireto(base, auditoria, empresaId) {
    const conta = auditoria?.conta_azul || {};
    const ocr = auditoria?.ocr || {};
    const classificacao = auditoria?.classificacao || {};
    return {
        versao: 1,
        base: String(base || ""),
        empresa_id: String(empresaId || ""),
        origem_capture: {
            documento_id: conta.documento_id || null,
            captura_id: conta.captura_id || null,
            status: conta.status || null,
            divergencias: Array.isArray(conta.divergencias) ? conta.divergencias : [],
        },
        rastreabilidade: {
            sha256: auditoria?.rastreabilidade?.sha256 || null,
            chave_fiscal: auditoria?.rastreabilidade?.chave_fiscal || null,
        },
        esperado: {
            descricao: String(conta.descricao_sugerida || classificacao.categoria_nome || classificacao.tipo || "Despesa").slice(0, 255),
            valor: Number.isFinite(Number(ocr.valor)) ? Number(ocr.valor) : null,
            data: ocr.data || null,
            idCategoria: classificacao.categoria_id || null,
            idCentroCusto: classificacao.centro_custo_id || null,
            idContato: conta.previa?.fornecedor?.id || null,
            cnpjContato: conta.previa?.fornecedor?.documento || null,
        },
    };
}

function tokenDireto(base, auditoria, empresaId) {
    return crypto.createHash("sha256").update(JSON.stringify(ordenar(snapshotDireto(base, auditoria, empresaId)))).digest("hex");
}

function avaliarElegibilidadeDireta(auditoria, { empresaId, imagemExiste = true } = {}) {
    const impedimentos = [];
    const conta = auditoria?.conta_azul || {};
    const validacoes = auditoria?.validacoes || {};
    const esperado = snapshotDireto("documento", auditoria, empresaId).esperado;
    const empresa = String(empresaId || "");

    if (conta.status !== "PREVIA_DIVERGENTE") impedimentos.push("O lancamento direto assistido so e permitido para uma previa divergente da Conta AI Captura.");
    if (!Array.isArray(conta.divergencias) || !conta.divergencias.length) impedimentos.push("A previa nao possui divergencias registradas.");
    if (!conta.captura_id || !conta.documento_id) impedimentos.push("A origem da previa na Conta AI Captura nao esta completa.");
    if (!empresa || String(conta.empresa_id || "") !== empresa) impedimentos.push("A previa pertence a outra empresa ou nao esta vinculada a empresa confirmada.");
    if (!imagemExiste) impedimentos.push("A imagem local da nota nao foi encontrada.");
    if (validacoes.bloqueado || validacoes.revisao_necessaria || validacoes.duplicado) impedimentos.push("A nota local nao esta totalmente aprovada para lancamento.");
    if (conta.evento_id || conta.confirmado_em || conta.validado_no_erp_em || conta.status_remoto === "ACEITA") {
        impedimentos.push("Ja existe evidencia de aceite ou evento financeiro pela Conta AI Captura.");
    }
    if (conta.direto || conta.modo_lancamento === "DIRETO_ASSISTIDO") impedimentos.push("Esta nota ja iniciou o caminho direto e nunca pode ser reenviada automaticamente.");
    if (!String(esperado.descricao || "").trim()) impedimentos.push("Descricao local ausente.");
    if (numeroPositivo(esperado.valor) === null) impedimentos.push("Valor local invalido.");
    if (!dataIso(esperado.data)) impedimentos.push("Data local invalida.");
    if (!uuidValido(esperado.idCategoria)) impedimentos.push("Categoria do Conta Azul ausente ou invalida.");
    if (!uuidValido(esperado.idCentroCusto)) impedimentos.push("Centro de custo do Conta Azul ausente ou invalido.");
    const cnpjLocal = String(auditoria?.ocr?.cnpj || "").replace(/\D/g, "");
    const cnpjContato = String(esperado.cnpjContato || "").replace(/\D/g, "");
    if (!uuidValido(esperado.idContato) || !cnpjLocal || cnpjLocal !== cnpjContato) {
        impedimentos.push("O contato da previa nao possui UUID e CNPJ iguais aos dados validados localmente.");
    }
    return { permitido: impedimentos.length === 0, impedimentos: [...new Set(impedimentos)], esperado };
}

async function executarCriacaoDireta(esperado, { empresaId, criarFn = criarDespesa } = {}) {
    let resposta;
    try {
        resposta = await criarFn(esperado, { empresaEsperadaId: empresaId });
    } catch (erro) {
        return {
            status: "DIRETO_INCERTO",
            protocolo: null,
            erro: String(erro?.message || erro),
            motivo: "A requisicao de criacao nao teve resposta inequivoca. Nao reenviar automaticamente.",
        };
    }
    const protocolo = String(resposta?.protocolo || "").trim();
    if (!protocolo) {
        return {
            status: "DIRETO_INCERTO",
            protocolo: null,
            resposta,
            erro: "O Conta Azul respondeu sem protocolo.",
            motivo: "Sem protocolo nao ha confirmacao segura e a nota nao pode ser reenviada automaticamente.",
        };
    }
    return {
        status: "DIRETO_AGUARDANDO_CONFIRMACAO",
        protocolo,
        resposta,
        erro: null,
        motivo: "Protocolo recebido; falta localizar e validar o lancamento por protocolo.",
    };
}

async function executarVerificacaoDireta(direto, { confirmarFn = confirmarDespesa } = {}) {
    const protocolo = String(direto?.protocolo || "").trim();
    if (!protocolo) {
        return {
            status: "DIRETO_INCERTO",
            confirmado: false,
            erro: "Protocolo ausente. A verificacao exata nao pode ser executada e o POST nao deve ser repetido.",
        };
    }
    try {
        const resultado = await confirmarFn({ ...(direto.esperado || {}), protocolo });
        if (resultado?.confirmado) {
            return { status: "DIRETO_CONFIRMADO_PENDENCIAS", confirmado: true, resultado, erro: null };
        }
        if (resultado?.ambiguo) {
            return {
                status: "DIRETO_INCERTO",
                confirmado: false,
                resultado,
                erro: "Mais de um lancamento corresponde ao protocolo e aos dados esperados.",
            };
        }
        return {
            status: "DIRETO_AGUARDANDO_CONFIRMACAO",
            confirmado: false,
            resultado,
            erro: "O protocolo ainda nao foi localizado com valor, data, categoria e centro de custo integralmente validos.",
        };
    } catch (erro) {
        return {
            status: "DIRETO_AGUARDANDO_CONFIRMACAO",
            confirmado: false,
            erro: String(erro?.message || erro),
        };
    }
}

module.exports = {
    PENDENCIAS_DIRETO,
    ESTADOS_DIRETO,
    snapshotDireto,
    tokenDireto,
    avaliarElegibilidadeDireta,
    executarCriacaoDireta,
    executarVerificacaoDireta,
};
