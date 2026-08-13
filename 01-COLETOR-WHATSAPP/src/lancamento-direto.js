"use strict";

// =============================================================================
// LANCAMENTO DIRETO NO CONTA AZUL
// =============================================================================
//
// Cria a despesa diretamente pela API financeira, com categoria e centro de
// custo ja preenchidos.
//
// Por que este caminho existe:
//   O Conta AI (WhatsApp) le a imagem, mas recusa a mensagem de texto com os
//   dados complementares e entrega o resultado em "Importacoes", que ainda
//   depende de uma pessoa abrir e salvar. Ou seja, por aquele caminho a
//   categoria e o centro de custo nunca chegam sozinhos ao lancamento.
//   Criando direto, nos controlamos exatamente esses campos.
//
// O que este caminho NAO faz (limitacao conhecida da API):
//   - nao vincula o fornecedor (o lancamento nasce com fornecedor vazio);
//   - nao anexa a imagem do comprovante.
//   A imagem continua guardada localmente e rastreavel pela auditoria.
//
// Seguranca: a criacao so acontece quando a nota passou em todas as validacoes
// e tem categoria e centro de custo resolvidos. A API nao permite excluir
// lancamento, entao na duvida o modulo recusa criar.
// =============================================================================

const fs = require("fs");
const path = require("path");
const contaAzul = require("./conta-azul");

const RAIZ = path.resolve(__dirname, "..");
const emExecucao = new Set();

function uuidValido(valor) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(valor || ""));
}

function centavos(valor) {
    return Math.round(Number(valor || 0) * 100);
}

/**
 * Confere se a nota pode virar lancamento. Devolve a lista de impedimentos —
 * vazia significa liberado.
 */
function impedimentosParaLancar(auditoria = {}) {
    const impedimentos = [];
    const classificacao = auditoria.classificacao || {};
    const valor = Number(auditoria.ocr?.valor);

    if (auditoria.validacoes?.bloqueado) {
        impedimentos.push(`Documento bloqueado: ${(auditoria.validacoes.motivos || []).join(" ")}`);
    }
    if (!Number.isFinite(valor) || valor <= 0) impedimentos.push("Valor nao foi lido com seguranca.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(auditoria.ocr?.data || ""))) impedimentos.push("Data nao foi lida com seguranca.");
    if (!uuidValido(classificacao.categoria_id)) impedimentos.push("Categoria sem UUID valido do Conta Azul.");
    if (!uuidValido(classificacao.centro_custo_id)) impedimentos.push("Centro de custo sem UUID valido do Conta Azul.");
    if (auditoria.lancamento_direto?.status === "CRIADO") impedimentos.push("Esta nota ja foi lancada no Conta Azul.");
    return impedimentos;
}

/**
 * Monta o corpo do POST. Formato confirmado na conta real: o centro de custo
 * vai DENTRO do rateio, como lista, e a composicao de valor da parcela chama
 * `detalhe_valor` (ver API-CONTA-AZUL.md).
 */
/**
 * Observacao do lancamento: como a API nao vincula fornecedor nem anexa a
 * imagem, e aqui que fica a rastreabilidade — quem e o fornecedor, o CNPJ, a
 * chave da nota fiscal e o arquivo da foto guardado localmente.
 */
function montarObservacao(auditoria = {}) {
    const ocr = auditoria.ocr || {};
    const abastecimento = auditoria.dados_abastecimento || {};
    const linhas = [];

    if (ocr.fornecedor) linhas.push(`Fornecedor: ${ocr.fornecedor}`);
    if (ocr.cnpj) linhas.push(`CNPJ: ${ocr.cnpj}`);
    const local = [ocr.endereco?.cidade, ocr.endereco?.estado].filter(Boolean).join("/");
    if (local) linhas.push(`Local: ${local}`);

    if (abastecimento.placa) linhas.push(`Placa: ${abastecimento.placa}`);
    if (abastecimento.litragem) linhas.push(`Litragem: ${abastecimento.litragem} ${abastecimento.unidade || "L"}`);
    if (abastecimento.combustivel) linhas.push(`Produto: ${abastecimento.combustivel}`);
    if (abastecimento.valor_unitario) linhas.push(`Valor por litro: R$ ${abastecimento.valor_unitario}`);
    if (abastecimento.quilometragem) linhas.push(`Km: ${abastecimento.quilometragem}`);

    if (auditoria.operador?.pessoas) linhas.push(`Pessoas: ${auditoria.operador.pessoas}`);
    if (auditoria.operador?.observacao) linhas.push(`Observacao do operador: ${auditoria.operador.observacao}`);
    if (auditoria.legenda_original) linhas.push(`Legenda: ${String(auditoria.legenda_original).replace(/\s*\n\s*/g, " | ")}`);

    if (ocr.chave_fiscal) linhas.push(`Chave NFC-e: ${ocr.chave_fiscal}`);
    if (auditoria.arquivo_imagem) linhas.push(`Comprovante: ${auditoria.arquivo_imagem}`);
    if (auditoria.rastreabilidade?.sha256) linhas.push(`SHA-256: ${auditoria.rastreabilidade.sha256.slice(0, 16)}`);
    linhas.push("Lancado automaticamente pela Central de Despesas.");

    return linhas.join("\n").slice(0, 1000);
}

function montarPayload(auditoria = {}, { incluirMetodoPagamento = true, incluirObservacao = true } = {}) {
    const valor = Number(auditoria.ocr.valor);
    const data = auditoria.ocr.data;
    const classificacao = auditoria.classificacao || {};
    const descricao = String(auditoria.conta_azul?.descricao_sugerida || classificacao.tipo || "Despesa")
        .replace(/\s+/g, " ").trim().slice(0, 255);

    const parcela = {
        data_vencimento: data,
        // A busca de contas a pagar exibe a descricao da PARCELA, nao a do evento.
        // Repetir a descricao aqui e o que faz o lancamento ficar legivel na lista
        // do Conta Azul (senao aparece so "Parcela 1/1").
        descricao: descricao,
        detalhe_valor: { valor_bruto: valor, valor_liquido: valor, desconto: 0, taxa: 0, multa: 0, juros: 0 },
    };
    const metodo = auditoria.forma_pagamento?.codigo;
    if (incluirMetodoPagamento && metodo) parcela.metodo_pagamento = metodo;

    const corpo = {
        descricao,
        valor,
        data_competencia: data,
        condicao_pagamento: { tipo: "A_VISTA", parcelas: [parcela] },
        rateio: [{
            id_categoria: classificacao.categoria_id,
            valor,
            rateio_centro_custo: [{ id_centro_custo: classificacao.centro_custo_id, valor }],
        }],
    };
    if (incluirObservacao) corpo.observacao = montarObservacao(auditoria);
    return corpo;
}

/**
 * Procura um lancamento ja existente com o mesmo valor, data e categoria.
 * Serve para dois momentos: antes de criar (nao duplicar) e depois de criar
 * (confirmar que nasceu — a API responde PENDING sem garantir a criacao).
 */
async function procurarLancamento(auditoria, { log = console.log } = {}) {
    const valor = Number(auditoria.ocr.valor);
    const data = auditoria.ocr.data;
    const filtros = {
        data_competencia_de: data,
        data_competencia_ate: data,
        data_vencimento_de: data,
        data_vencimento_ate: data,
        valor_de: valor.toFixed(2),
        valor_ate: valor.toFixed(2),
        ids_categorias: [auditoria.classificacao.categoria_id],
        tamanho_pagina: 20,
    };
    try {
        const resposta = await contaAzul.buscarContasPagar(filtros);
        return resposta?.itens || resposta?.items || [];
    } catch (erro) {
        log(`[Lancamento] Falha ao consultar lancamentos existentes: ${erro.message}`);
        return null; // null = nao foi possivel consultar (diferente de "nao existe")
    }
}

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/**
 * Cria a despesa no Conta Azul com categoria e centro de custo preenchidos.
 *
 * @param {string} base — nome base do documento (identifica a auditoria)
 * @param {object} opcoes
 * @param {boolean} [opcoes.dryRun=true] — nao envia nada, so mostra o payload
 * @param {Function} [opcoes.log]
 * @returns {Promise<object>} resultado com status, payload e confirmacao
 */
async function lancarDespesa(base, opcoes = {}) {
    const { dryRun = true, log = console.log } = opcoes;
    const auditoriaPath = path.join(RAIZ, "dados", "auditoria", `${base}.json`);
    const resultado = { base, criado: false, dryRun, impedimentos: [], erro: null };

    if (!fs.existsSync(auditoriaPath)) {
        resultado.erro = "Auditoria nao encontrada.";
        return resultado;
    }
    if (emExecucao.has(base)) {
        resultado.erro = "Ja existe um lancamento em andamento para esta nota.";
        return resultado;
    }
    emExecucao.add(base);

    try {
        const auditoria = JSON.parse(fs.readFileSync(auditoriaPath, "utf8"));
        resultado.impedimentos = impedimentosParaLancar(auditoria);
        if (resultado.impedimentos.length) {
            log(`[Lancamento] ${base} nao pode ser lancado: ${resultado.impedimentos.join(" | ")}`);
            return resultado;
        }

        const payload = montarPayload(auditoria);
        resultado.payload = payload;
        log(`[Lancamento] ${base}: R$ ${payload.valor} em ${payload.data_competencia}`);
        log(`[Lancamento]   categoria=${payload.rateio[0].id_categoria}`);
        log(`[Lancamento]   centro de custo=${payload.rateio[0].rateio_centro_custo[0].id_centro_custo}`);

        if (dryRun) {
            log("[Lancamento] *** SIMULACAO: nada foi enviado ao Conta Azul ***");
            resultado.simulado = true;
            return resultado;
        }

        // Antes de criar: se ja existe um lancamento igual, nao cria outro.
        const existentes = await procurarLancamento(auditoria, { log });
        if (existentes === null) {
            resultado.erro = "Nao consegui consultar o Conta Azul para checar duplicidade; nada foi criado.";
            return resultado;
        }
        if (existentes.length) {
            resultado.erro = `Ja existe lancamento com este valor, data e categoria (id ${existentes[0].id}). Nada foi criado.`;
            resultado.duplicado = true;
            return resultado;
        }

        // Observacao e metodo de pagamento sao campos opcionais: se a API recusar
        // algum deles, tenta de novo sem ele. Categoria e centro de custo — que
        // sao o motivo deste caminho existir — nunca saem do payload.
        const tentativas = [
            { nome: "completo", opcoes: { incluirMetodoPagamento: true, incluirObservacao: true } },
            { nome: "sem_observacao", opcoes: { incluirMetodoPagamento: true, incluirObservacao: false } },
            { nome: "sem_metodo_pagamento", opcoes: { incluirMetodoPagamento: false, incluirObservacao: true } },
            { nome: "minimo", opcoes: { incluirMetodoPagamento: false, incluirObservacao: false } },
        ];

        let resposta = null;
        let ultimoErro = null;
        for (const tentativa of tentativas) {
            const corpo = montarPayload(auditoria, tentativa.opcoes);
            try {
                resposta = await contaAzul.criarContaPagar(corpo);
                resultado.payload = corpo;
                resultado.tentativa_aceita = tentativa.nome;
                resultado.observacao_aplicada = Boolean(corpo.observacao);
                resultado.metodo_pagamento_aplicado = Boolean(corpo.condicao_pagamento.parcelas[0].metodo_pagamento);
                if (tentativa.nome !== "completo") {
                    log(`[Lancamento] Aceito na variacao "${tentativa.nome}" (a API recusou algum campo opcional).`);
                }
                break;
            } catch (erro) {
                ultimoErro = erro;
                log(`[Lancamento] Variacao "${tentativa.nome}" recusada: ${erro.message}`);
                // Erro que nao e recusa de campo (auth, rede) nao adianta reduzir payload.
                if (!/Conta Azul (400|422):/i.test(erro.message)) throw erro;
            }
        }
        if (!resposta) throw ultimoErro || new Error("A API recusou todas as variacoes do lancamento.");
        resultado.protocolo = resposta?.protocolo || null;
        log(`[Lancamento] POST aceito. Protocolo: ${resultado.protocolo} (status ${resposta?.status || "?"})`);

        // "PENDING" nao prova que a despesa nasceu: confirma consultando.
        for (const espera of [3000, 5000, 8000, 12000]) {
            await esperar(espera);
            const encontrados = await procurarLancamento(auditoria, { log });
            if (encontrados && encontrados.length) {
                resultado.criado = true;
                resultado.lancamento_id = encontrados[0].id;
                log(`[Lancamento] ✓ Confirmado no Conta Azul: id=${encontrados[0].id}`);
                break;
            }
        }
        if (!resultado.criado) {
            resultado.erro = "O Conta Azul aceitou o pedido, mas o lancamento ainda nao aparece na busca. "
                + "Confira em Financeiro > Contas a pagar antes de tentar de novo, para nao duplicar.";
        }
        return resultado;
    } catch (erro) {
        resultado.erro = erro.message;
        log(`[Lancamento] ✗ ERRO: ${erro.message}`);
        return resultado;
    } finally {
        emExecucao.delete(base);
        try {
            const auditoria = JSON.parse(fs.readFileSync(auditoriaPath, "utf8"));
            auditoria.lancamento_direto = {
                status: resultado.criado ? "CRIADO" : resultado.simulado ? "SIMULADO" : "NAO_CRIADO",
                em: new Date().toISOString(),
                lancamento_id: resultado.lancamento_id || null,
                protocolo: resultado.protocolo || null,
                impedimentos: resultado.impedimentos,
                erro: resultado.erro,
            };
            fs.writeFileSync(auditoriaPath, JSON.stringify(auditoria, null, 2), "utf8");
        } catch (_) { /* nao deixa a gravacao da auditoria derrubar o resultado */ }
    }
}

module.exports = { lancarDespesa, montarPayload, impedimentosParaLancar, procurarLancamento, uuidValido };
