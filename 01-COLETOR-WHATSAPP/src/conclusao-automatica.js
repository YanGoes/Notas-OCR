"use strict";

// =============================================================================
// CONCLUSAO AUTOMATICA
// =============================================================================
//
// Fecha o ciclo depois que a foto foi encaminhada ao Conta AI:
//
//   1. espera o Conta AI criar o lancamento (o enriquecedor ja faz a busca
//      com retry, entao nao existe sleep fixo aqui);
//   2. complementa centro de custo, forma de pagamento e categoria que o
//      Conta AI nao preencheu, reaproveitando os UUIDs que o pipeline local
//      ja resolveu;
//   3. avisa no WhatsApp o que ficou pronto e o que precisa de acao humana.
//
// Nada aqui roda sem o operador ligar explicitamente em config.json, e o modo
// "simular" (padrao) executa o fluxo inteiro sem alterar nada no Conta Azul.
// =============================================================================

const fs = require("fs");
const path = require("path");
const enriquecedor = require("./enriquecedor-conta-azul");
const notificacoes = require("./notificacoes");

const RAIZ = path.resolve(__dirname, "..");

const ROTULO_PAGAMENTO = {
    DINHEIRO: "dinheiro", CARTAO_DEBITO: "cartao de debito", CARTAO_CREDITO: "cartao de credito",
    PIX: "pix", BOLETO: "boleto", TRANSFERENCIA: "transferencia",
};

/**
 * Monta o contexto do enriquecedor a partir da auditoria local, priorizando
 * os UUIDs ja resolvidos pelo pipeline.
 */
function contextoDaAuditoria(auditoria = {}) {
    const classificacao = auditoria.classificacao || {};
    return {
        categoria: classificacao.tipo || auditoria.operador?.tipo_despesa || null,
        categoriaId: classificacao.categoria_id || null,
        categoriaNome: classificacao.categoria_nome || null,
        centroCustoId: classificacao.centro_custo_id || null,
        centroCustoNome: classificacao.centro_custo_nome || null,
        centroCusto: classificacao.centro_custo_nome || auditoria.operador?.centro_custo_informado || null,
        veiculo: auditoria.dados_abastecimento?.placa || classificacao.placa || null,
        metodoPagamento: auditoria.forma_pagamento?.codigo || null,
    };
}

/**
 * O que o sistema sabe que esta faltando ANTES de falar com a API — sao as
 * informacoes que nem o pipeline nem o Conta AI conseguiriam completar
 * sozinhos e que dependem de uma decisao humana.
 */
function pendenciasLocais(auditoria = {}) {
    const pendencias = [];
    const classificacao = auditoria.classificacao || {};
    if (!classificacao.centro_custo_id) {
        pendencias.push('Centro de custo nao definido — envie "#centro NOME DO PROJETO" no grupo.');
    }
    if (!auditoria.forma_pagamento?.codigo) {
        const candidatos = (auditoria.forma_pagamento?.candidatos || [])
            .map((codigo) => ROTULO_PAGAMENTO[codigo] || codigo).join(" ou ");
        pendencias.push(`Forma de pagamento nao identificada${candidatos ? ` (comprovante sugere ${candidatos})` : ""} — informe com "Conta/cartao:".`);
    }
    if (!classificacao.categoria_id) {
        pendencias.push("Categoria sem mapeamento no Conta Azul — confira configuracao/categorias.json.");
    }
    for (const motivo of auditoria.validacoes?.motivos || []) {
        if (!/centro de custo|forma de pagamento|categoria/i.test(motivo)) pendencias.push(motivo);
    }
    return pendencias;
}

function valorFormatado(valor) {
    return Number(valor || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Texto da notificacao enviada ao operador. Sempre diz o que aconteceu e,
 * quando algo falta, exatamente o que fazer.
 */
function montarNotificacao({ auditoria, resultado, pendencias, simulado }) {
    const arquivo = auditoria?.arquivo_imagem || "documento";
    const valor = valorFormatado(auditoria?.ocr?.valor);
    const fornecedor = auditoria?.ocr?.fornecedor || "fornecedor nao identificado";
    const linhas = [];

    if (resultado?.sucesso && !pendencias.length) {
        linhas.push(simulado ? "🧪 *Simulacao concluida*" : "✅ *Despesa completa no Conta Azul*");
    } else if (resultado?.sucesso) {
        linhas.push(simulado ? "🧪 *Simulacao concluida com pendencias*" : "⚠️ *Despesa lancada, mas falta informacao*");
    } else {
        linhas.push("❌ *Nao consegui concluir esta despesa*");
    }

    linhas.push("");
    linhas.push(`📄 ${fornecedor} — R$ ${valor}`);
    if (auditoria?.ocr?.data) linhas.push(`📅 ${auditoria.ocr.data}`);

    const classificacao = auditoria?.classificacao || {};
    if (classificacao.centro_custo_nome) linhas.push(`🏗️ Centro de custo: ${classificacao.centro_custo_nome}`);
    if (classificacao.categoria_nome) linhas.push(`🏷️ Categoria: ${classificacao.categoria_nome}`);
    const pagamento = auditoria?.forma_pagamento?.codigo;
    if (pagamento) linhas.push(`💳 Pagamento: ${ROTULO_PAGAMENTO[pagamento] || pagamento}`);

    const mantidos = resultado?.etapas?.campos_mantidos;
    if (mantidos && Object.values(mantidos).some(Boolean)) {
        const nomes = Object.entries(mantidos).filter(([, jaTinha]) => jaTinha).map(([campo]) => campo.replace(/_/g, " "));
        linhas.push(`ℹ️ O Conta AI ja tinha preenchido: ${nomes.join(", ")}`);
    }

    // Conferencia do lancamento inteiro, nao so dos campos que este modulo preenche
    const faltantes = resultado?.etapas?.campos_faltantes || [];
    const naoPreenchiveis = faltantes.filter((item) => !item.preenchivel);
    if (naoPreenchiveis.length) {
        linhas.push(`⚠️ Continua vazio no lancamento: ${naoPreenchiveis.map((item) => item.rotulo).join(", ")}.`);
    }

    for (const pendencia of resultado?.pendencias || []) {
        if (pendencia === "centro_de_custo_nao_aplicado_via_api") {
            linhas.push("⚠️ O centro de custo precisa ser ajustado na tela do Conta Azul (a API recusou a alteracao).");
        }
        if (pendencia === "metodo_pagamento_nao_aplicado_via_api") {
            linhas.push("⚠️ A forma de pagamento precisa ser ajustada na tela do Conta Azul.");
        }
    }

    if (pendencias.length) {
        linhas.push("");
        linhas.push("*Precisa de voce:*");
        for (const pendencia of pendencias) linhas.push(`• ${pendencia}`);
    }

    if (resultado?.erro) {
        linhas.push("");
        linhas.push(`Detalhe tecnico: ${resultado.erro}`);
    }

    if (simulado) {
        linhas.push("");
        linhas.push("_Modo simulacao: nada foi alterado no Conta Azul._");
    }

    linhas.push("");
    linhas.push(`_${arquivo}_`);
    return linhas.join("\n");
}

function gravarAuditoria(auditoriaPath, alteracoes) {
    if (!fs.existsSync(auditoriaPath)) return;
    try {
        const auditoria = JSON.parse(fs.readFileSync(auditoriaPath, "utf8"));
        Object.assign(auditoria, alteracoes);
        fs.writeFileSync(auditoriaPath, JSON.stringify(auditoria, null, 2), "utf8");
    } catch (_) { /* auditoria ilegivel nao pode derrubar o fluxo */ }
}

/**
 * Executa a conclusao de um documento ja encaminhado ao Conta AI.
 *
 * @param {string} baseDocumento — nome base do arquivo (sem extensao)
 * @param {object} opcoes
 * @param {boolean} [opcoes.simular=true] — nao altera nada no Conta Azul
 * @param {Function} [opcoes.notificar] — async (texto) => void
 * @param {Function} [opcoes.log]
 * @param {object} [opcoes.retry] — repassado ao enriquecedor (tentativas/intervalo)
 */
async function concluirDocumento(baseDocumento, opcoes = {}) {
    const { simular = true, notificar = null, log = console.log, retry = {} } = opcoes;
    const auditoriaPath = path.join(RAIZ, "dados", "auditoria", `${baseDocumento}.json`);

    if (!fs.existsSync(auditoriaPath)) {
        log(`[Conclusao] Auditoria nao encontrada para ${baseDocumento}; nada a fazer.`);
        return { executado: false, motivo: "auditoria_ausente" };
    }

    const auditoria = JSON.parse(fs.readFileSync(auditoriaPath, "utf8"));

    if (auditoria.validacoes?.bloqueado) {
        log(`[Conclusao] ${baseDocumento} esta bloqueado (${auditoria.validacoes.motivos.join(" ")}); nao sera concluido.`);
        return { executado: false, motivo: "documento_bloqueado" };
    }
    if (auditoria.conclusao_automatica?.status === "CONCLUIDO") {
        log(`[Conclusao] ${baseDocumento} ja foi concluido antes; ignorando para nao duplicar.`);
        return { executado: false, motivo: "ja_concluido" };
    }

    const valor = Number(auditoria.ocr?.valor);
    const data = auditoria.ocr?.data;
    if (!Number.isFinite(valor) || valor <= 0 || !data) {
        const pendencias = ["Valor ou data nao foram lidos com seguranca; confira a foto."];
        const aviso = montarNotificacao({ auditoria, resultado: null, pendencias, simulado: simular });
        notificacoes.registrar({
            titulo: "Nao consegui concluir esta despesa",
            texto: aviso, nivel: "erro", base: baseDocumento, pendencias,
        });
        if (notificar) await notificar(aviso);
        gravarAuditoria(auditoriaPath, {
            conclusao_automatica: { status: "SEM_DADOS", em: new Date().toISOString(), pendencias },
        });
        return { executado: false, motivo: "sem_valor_ou_data" };
    }

    const contexto = contextoDaAuditoria(auditoria);
    log(`[Conclusao] ${baseDocumento}: procurando o lancamento do Conta AI (R$ ${valor} em ${data})...`);

    const resultado = await enriquecedor.enriquecer(valor, data, contexto, {
        ...retry,
        dryRun: simular,
        chaveIdempotencia: baseDocumento,
        fornecedorCnpj: auditoria.ocr?.cnpj || null,
        log,
    });

    const pendencias = pendenciasLocais(auditoria);
    if (!resultado.sucesso && resultado.erro) pendencias.push("O lancamento nao foi localizado no Conta Azul — confira se o Conta AI processou a foto.");
    for (const faltante of resultado.etapas?.campos_faltantes || []) {
        if (!faltante.preenchivel) pendencias.push(`${faltante.rotulo} continua vazio no Conta Azul — preencha na tela do ERP.`);
    }

    gravarAuditoria(auditoriaPath, {
        conclusao_automatica: {
            status: resultado.sucesso ? (pendencias.length ? "CONCLUIDO_COM_PENDENCIAS" : "CONCLUIDO") : "FALHOU",
            em: new Date().toISOString(),
            simulado: simular,
            lancamento_id: resultado.etapas?.lancamento?.id || null,
            parcela_id: resultado.etapas?.parcela?.id || null,
            campos_mantidos: resultado.etapas?.campos_mantidos || null,
            pendencias,
            erro: resultado.erro || null,
        },
    });

    const texto = montarNotificacao({ auditoria, resultado, pendencias, simulado: simular });

    // O painel e o canal principal: o WhatsApp pode estar fora do ar, o aviso nao pode se perder.
    notificacoes.registrar({
        titulo: resultado.sucesso
            ? (pendencias.length ? "Despesa lancada, mas falta informacao" : "Despesa completa no Conta Azul")
            : "Nao consegui concluir esta despesa",
        texto,
        nivel: resultado.sucesso ? (pendencias.length ? "atencao" : "sucesso") : "erro",
        base: baseDocumento,
        pendencias,
    });

    if (notificar) await notificar(texto);

    return { executado: true, resultado, pendencias };
}

module.exports = {
    concluirDocumento,
    contextoDaAuditoria,
    pendenciasLocais,
    montarNotificacao,
};
