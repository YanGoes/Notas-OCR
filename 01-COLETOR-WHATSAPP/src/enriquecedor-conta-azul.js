"use strict";

// =============================================================================
// ENRIQUECEDOR CONTA AZUL — Arquitetura Híbrida
// =============================================================================
//
// Módulo pós-captura que enriquece lançamentos criados pela Conta AI.
//
// Fluxo:
//   1. A Conta AI lê a foto (via WhatsApp) e cria um rascunho com
//      Fornecedor, Data e Valor.
//   2. Este módulo busca esse rascunho via API, identifica a parcela,
//      e injeta Categoria, Centro de Custo e Método de Pagamento
//      que a IA não conseguiu classificar.
//
// Depende de:
//   - src/conta-azul.js → requisicao(), buscarContasPagar(),
//                          buscarParcelasDoEvento(), patchParcela()
//   - mapeamento.json → tradução texto operador → nome oficial
//   - configuracao/categorias.json → nome → UUID da categoria
//   - configuracao/centros_custo.json → nome → UUID do centro
//   - configuracao/veiculos.json → placa → UUID da categoria de combustível
// =============================================================================

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");
const contaAzul = require("./conta-azul");

// ---------------------------------------------------------------------------
// Utilidades de carga (carrega JSONs de configuração com cache simples)
// ---------------------------------------------------------------------------

/** Cache em memória para evitar leituras repetidas no mesmo ciclo. */
let _cache = {};

/**
 * Limpa o cache de configuração.
 * Útil para testes ou quando os arquivos são alterados em runtime.
 */
function limparCache() {
    _cache = {};
}

/**
 * Lê um arquivo JSON com cache. Retorna o conteúdo parseado.
 * Se o arquivo não existir, retorna o valor `fallback`.
 */
function lerJson(caminho, fallback = null) {
    if (_cache[caminho]) return _cache[caminho];
    if (!fs.existsSync(caminho)) return fallback;
    const dados = JSON.parse(fs.readFileSync(caminho, "utf8"));
    _cache[caminho] = dados;
    return dados;
}

function carregarMapeamento() {
    return lerJson(path.join(RAIZ, "mapeamento.json"), {});
}

function carregarCategorias() {
    return lerJson(path.join(RAIZ, "configuracao", "categorias.json"), []);
}

function carregarCentrosCusto() {
    return lerJson(path.join(RAIZ, "configuracao", "centros_custo.json"), []);
}

function carregarVeiculos() {
    return lerJson(path.join(RAIZ, "configuracao", "veiculos.json"), []);
}

// ---------------------------------------------------------------------------
// Normalização de texto (remove acentos, lowercase, trim)
// ---------------------------------------------------------------------------

function normalizar(texto) {
    return String(texto || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

// ---------------------------------------------------------------------------
// Helpers de espera e retry
// ---------------------------------------------------------------------------

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// RESOLVEDORES — traduzem texto do operador → UUID da API
// ---------------------------------------------------------------------------

/**
 * Resolve o texto do operador para o UUID da categoria no Conta Azul.
 *
 * Cadeia de resolução:
 *   1. Tenta correspondência direta em mapeamento.json (refeições, diretas)
 *   2. Tenta correspondência por veículo (placa/alias → categoria específica)
 *   3. Busca o nome oficial no configuracao/categorias.json para obter o UUID
 *
 * @param {string} textoOperador — o que o operador escreveu (ex: "almoco", "combustivel")
 * @param {string} [textoVeiculo] — placa ou alias do veículo (ex: "sgr4b54", "scudo")
 * @returns {{ id: string, nome: string } | null} — UUID + nome, ou null se não encontrado
 */
function resolverCategoria(textoOperador, textoVeiculo = null) {
    const mapeamento = carregarMapeamento();
    const categorias = carregarCategorias();
    const veiculos = carregarVeiculos();
    const chave = normalizar(textoOperador);

    // -----------------------------------------------------------------------
    // 1. Verificar se é um tipo de refeição mapeado
    // -----------------------------------------------------------------------
    if (mapeamento.refeicoes && mapeamento.refeicoes[chave]) {
        const nomeOficial = mapeamento.refeicoes[chave];
        const cat = categorias.find(
            (c) => normalizar(c.nome_conta_azul || c.nome) === normalizar(nomeOficial)
        );
        if (cat && cat.id && !cat.id.startsWith("PREENCHER_")) {
            return { id: cat.id, nome: cat.nome_conta_azul || cat.nome };
        }
    }

    // -----------------------------------------------------------------------
    // 2. Verificar se é uma categoria direta
    // -----------------------------------------------------------------------
    if (mapeamento.diretas && mapeamento.diretas[chave]) {
        const nomeOficial = mapeamento.diretas[chave];
        const cat = categorias.find(
            (c) => normalizar(c.nome_conta_azul || c.nome) === normalizar(nomeOficial)
        );
        if (cat && cat.id && !cat.id.startsWith("PREENCHER_")) {
            return { id: cat.id, nome: cat.nome_conta_azul || cat.nome };
        }
    }

    // -----------------------------------------------------------------------
    // 3. Se há veículo informado e o tipo é combustível/manutenção,
    //    buscar a categoria específica do veículo
    // -----------------------------------------------------------------------
    if (textoVeiculo && mapeamento.veiculos) {
        const veiculoNorm = normalizar(textoVeiculo);
        // Procura pela placa ou alias no mapeamento.json
        for (const [placa, info] of Object.entries(mapeamento.veiculos)) {
            if (placa.startsWith("_")) continue; // pular _regra, _atencao
            const aliases = (info.aliases || []).map(normalizar);
            if (normalizar(placa) === veiculoNorm || aliases.includes(veiculoNorm)) {
                // Decidir se é combustível ou manutenção baseado no tipo informado
                const ehManutencao = ["manutencao", "oficina", "mecanica", "auto pecas"].includes(chave);
                const nomeCategoria = ehManutencao ? info.manutencao : info.combustivel;
                if (!nomeCategoria) break; // veículo alugado sem manutenção, por exemplo

                // Buscar UUID: primeiro em veiculos.json (tem categoria_id direto)
                const veiculoCfg = veiculos.find(
                    (v) => normalizar(v.placa || "") === normalizar(placa)
                        || normalizar(v.categoria_nome_conta_azul || "") === normalizar(nomeCategoria)
                );
                if (veiculoCfg?.categoria_id && !veiculoCfg.categoria_id.startsWith("PREENCHER_")) {
                    return { id: veiculoCfg.categoria_id, nome: veiculoCfg.categoria_nome_conta_azul || nomeCategoria };
                }

                // Fallback: buscar por nome em categorias.json
                const cat = categorias.find(
                    (c) => normalizar(c.nome_conta_azul || c.nome) === normalizar(nomeCategoria)
                );
                if (cat?.id && !cat.id.startsWith("PREENCHER_")) {
                    return { id: cat.id, nome: cat.nome_conta_azul || cat.nome };
                }
                break;
            }
        }
    }

    // -----------------------------------------------------------------------
    // 4. Fallback: buscar diretamente por nome no categorias.json
    //    (cobre casos onde o operador escreveu o nome exato da categoria)
    // -----------------------------------------------------------------------
    const catDireta = categorias.find(
        (c) => normalizar(c.nome) === chave
            || normalizar(c.nome_conta_azul || "") === chave
            || (c.apelidos || []).some((a) => normalizar(a) === chave)
    );
    if (catDireta?.id && !catDireta.id.startsWith("PREENCHER_")) {
        return { id: catDireta.id, nome: catDireta.nome_conta_azul || catDireta.nome };
    }

    return null;
}

/**
 * Resolve o texto do operador para o UUID do centro de custo no Conta Azul.
 *
 * Cadeia: mapeamento.json → configuracao/centros_custo.json → UUID
 *
 * @param {string} textoOperador — ex: "consol mg-050", "CONSOL MG-259"
 * @returns {{ id: string, nome: string } | null}
 */
function resolverCentroCusto(textoOperador) {
    const mapeamento = carregarMapeamento();
    const centros = carregarCentrosCusto();
    const chave = normalizar(textoOperador);

    // 1. Traduzir via mapeamento.json
    let nomeOficial = null;
    if (mapeamento.centros_de_custo) {
        for (const [alias, nome] of Object.entries(mapeamento.centros_de_custo)) {
            if (alias.startsWith("_")) continue;
            if (normalizar(alias) === chave) {
                nomeOficial = nome;
                break;
            }
        }
    }

    // 2. Buscar UUID no configuracao/centros_custo.json
    const alvo = nomeOficial || textoOperador;
    const centro = centros.find(
        (c) => normalizar(c.nome) === normalizar(alvo)
            || (c.apelidos || []).some((a) => normalizar(a) === normalizar(alvo))
    );
    if (centro?.id) {
        return { id: centro.id, nome: centro.nome };
    }

    // 3. Tentar correspondência direta se o mapeamento não ajudou
    if (!nomeOficial) {
        const centroDir = centros.find(
            (c) => normalizar(c.nome) === chave
                || (c.apelidos || []).some((a) => normalizar(a) === chave)
        );
        if (centroDir?.id) {
            return { id: centroDir.id, nome: centroDir.nome };
        }
    }

    return null;
}

/**
 * Mapeia texto livre do operador para a string de método de pagamento
 * aceita pela API do Conta Azul.
 *
 * Valores conhecidos da API: DINHEIRO, CARTAO_CREDITO, CARTAO_DEBITO,
 * PIX, BOLETO, TRANSFERENCIA.
 *
 * @param {string} textoOperador — ex: "pix", "cartão de crédito", "dinheiro"
 * @returns {string | null} — string exata da API ou null
 */
function resolverMetodoPagamento(textoOperador) {
    const entrada = normalizar(textoOperador);

    // Mapa de aliases → valor da API
    const mapa = {
        // Dinheiro
        dinheiro: "DINHEIRO",
        especie: "DINHEIRO",
        cash: "DINHEIRO",

        // Cartão de crédito
        cartao_credito: "CARTAO_CREDITO",
        "cartao de credito": "CARTAO_CREDITO",
        credito: "CARTAO_CREDITO",
        "cartao credito": "CARTAO_CREDITO",

        // Cartão de débito
        cartao_debito: "CARTAO_DEBITO",
        "cartao de debito": "CARTAO_DEBITO",
        debito: "CARTAO_DEBITO",
        "cartao debito": "CARTAO_DEBITO",

        // PIX
        pix: "PIX",

        // Boleto
        boleto: "BOLETO",
        "boleto bancario": "BOLETO",

        // Transferência
        transferencia: "TRANSFERENCIA",
        ted: "TRANSFERENCIA",
        doc: "TRANSFERENCIA",
        "transferencia bancaria": "TRANSFERENCIA",
    };

    return mapa[entrada] || null;
}

// ---------------------------------------------------------------------------
// ETAPA 2 — Busca do lançamento recente via API
// ---------------------------------------------------------------------------

/**
 * Busca um lançamento financeiro recém-criado pela Conta AI, filtrando por
 * valor e data de competência.
 *
 * Implementa retentativas com backoff exponencial para aguardar a IA
 * processar a foto (pode demorar 15-30 segundos).
 *
 * @param {number} valor — valor da despesa (ex: 48.00)
 * @param {string} data — data de competência no formato AAAA-MM-DD
 * @param {object} [opcoes] — configurações opcionais
 * @param {number} [opcoes.tentativas=5] — número máximo de tentativas
 * @param {number} [opcoes.intervaloInicialMs=10000] — espera inicial (10s)
 * @param {number} [opcoes.toleranciaValor=0.01] — tolerância no valor (±R$0.01)
 * @param {number} [opcoes.toleranciaDias=1] — tolerância na data (±1 dia)
 * @param {Function} [opcoes.log] — função de log (padrão: console.log)
 * @returns {Promise<object>} — o evento financeiro encontrado
 * @throws {Error} — se não encontrar após todas as tentativas
 */
async function buscarLancamentoRecente(valor, data, opcoes = {}) {
    const {
        tentativas = 5,
        intervaloInicialMs = 10000,
        toleranciaValor = 0.01,
        toleranciaDias = 1,
        log = console.log,
    } = opcoes;

    // Calcular janela de data (±toleranciaDias)
    const dataRef = new Date(data + "T12:00:00Z");
    const dataInicio = new Date(dataRef);
    dataInicio.setDate(dataInicio.getDate() - toleranciaDias);
    const dataFim = new Date(dataRef);
    dataFim.setDate(dataFim.getDate() + toleranciaDias);

    const formatarData = (d) => d.toISOString().slice(0, 10);

    // Montar filtros para buscarContasPagar()
    const filtros = {
        data_competencia_de: formatarData(dataInicio),
        data_competencia_ate: formatarData(dataFim),
        valor_de: String(Math.max(0, valor - toleranciaValor).toFixed(2)),
        valor_ate: String((valor + toleranciaValor).toFixed(2)),
        tamanho_pagina: 20,
        campo_ordenado_descendente: "data_alteracao",
    };

    log(`[Enriquecedor] Buscando lançamento: valor=${valor}, data=${data}`);
    log(`[Enriquecedor] Filtros: ${JSON.stringify(filtros)}`);

    for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
        try {
            const resposta = await contaAzul.buscarContasPagar(filtros);
            const itens = resposta?.itens || resposta?.items || [];

            if (itens.length > 0) {
                // Pegar o lançamento mais recente (primeiro, já ordenado por data_alteracao desc)
                const lancamento = itens[0];
                log(`[Enriquecedor] Lançamento encontrado na tentativa ${tentativa}/${tentativas}: id=${lancamento.id}`);
                log(`[Enriquecedor]   Descrição: ${lancamento.descricao || "(sem descrição)"}`);
                log(`[Enriquecedor]   Valor: R$ ${lancamento.valor}`);
                log(`[Enriquecedor]   Data competência: ${lancamento.data_competencia}`);

                if (itens.length > 1) {
                    log(`[Enriquecedor] ⚠ ${itens.length} lançamentos encontrados no período/valor. Usando o mais recente.`);
                }

                return lancamento;
            }

            // Lançamento ainda não apareceu — aguardar e tentar novamente
            if (tentativa < tentativas) {
                const espera = intervaloInicialMs * Math.pow(2, tentativa - 1);
                log(`[Enriquecedor] Tentativa ${tentativa}/${tentativas}: lançamento não encontrado. Aguardando ${espera / 1000}s...`);
                await esperar(espera);
            }
        } catch (erro) {
            // Erros de rede/API não devem abortar o retry
            log(`[Enriquecedor] Tentativa ${tentativa}/${tentativas}: erro na busca — ${erro.message}`);
            if (tentativa < tentativas) {
                const espera = intervaloInicialMs * Math.pow(2, tentativa - 1);
                await esperar(espera);
            }
        }
    }

    throw new Error(
        `[Enriquecedor] Lançamento não encontrado após ${tentativas} tentativas. `
        + `Valor: R$ ${valor}, Data: ${data}. `
        + `Verifique se a Conta AI criou o rascunho no Conta Azul.`
    );
}

// ---------------------------------------------------------------------------
// ETAPA 3 — Captura do ID da parcela
// ---------------------------------------------------------------------------

/**
 * Busca a parcela (installment) de um evento financeiro.
 *
 * A maioria das despesas de campo tem uma única parcela (pagamento à vista).
 * A função retorna a primeira parcela encontrada.
 *
 * @param {string} eventoId — UUID do evento financeiro
 * @param {object} [opcoes]
 * @param {Function} [opcoes.log] — função de log
 * @returns {Promise<{ id: string, versao: number, evento: object }>}
 * @throws {Error} — se não encontrar parcelas
 */
async function buscarParcela(eventoId, opcoes = {}) {
    const { log = console.log } = opcoes;

    log(`[Enriquecedor] Buscando parcelas do evento: ${eventoId}`);

    try {
        // Tenta o endpoint específico de parcelas do evento
        const resposta = await contaAzul.buscarParcelasDoEvento(eventoId);
        const parcelas = resposta?.itens || resposta?.items || (Array.isArray(resposta) ? resposta : []);

        if (parcelas.length > 0) {
            const parcela = parcelas[0];
            log(`[Enriquecedor] Parcela encontrada: id=${parcela.id}, versão=${parcela.versao || parcela.version || 1}`);
            return {
                id: parcela.id,
                versao: parcela.versao || parcela.version || 1,
                parcela,
            };
        }
    } catch (erro) {
        log(`[Enriquecedor] Endpoint de parcelas por evento falhou: ${erro.message}`);
        log(`[Enriquecedor] Tentando via obterParcelaFinanceira (fallback)...`);
    }

    // Fallback: se o evento tem campo parcelas embutido (alguns retornos da API)
    // ou se precisamos buscar pelo ID da parcela diretamente.
    // Nesse caso, tentamos obter o detalhe da parcela usando o ID do evento
    // como ID da parcela (em alguns cenários da API, o evento tem uma única
    // parcela cujo ID pode ser o próprio ID do evento).
    try {
        const detalhe = await contaAzul.obterParcelaFinanceira(eventoId);
        if (detalhe?.id) {
            log(`[Enriquecedor] Parcela obtida via fallback: id=${detalhe.id}, versão=${detalhe.versao || 1}`);
            return {
                id: detalhe.id,
                versao: detalhe.versao || detalhe.version || 1,
                parcela: detalhe,
            };
        }
    } catch (erroFallback) {
        log(`[Enriquecedor] Fallback também falhou: ${erroFallback.message}`);
    }

    throw new Error(
        `[Enriquecedor] Nenhuma parcela encontrada para o evento ${eventoId}. `
        + `O lançamento pode ainda estar sendo processado.`
    );
}

// ---------------------------------------------------------------------------
// ETAPA 4 — PATCH de enriquecimento
// ---------------------------------------------------------------------------

/**
 * Atualiza uma parcela existente com Categoria, Centro de Custo e Método
 * de Pagamento via PATCH.
 *
 * O body envia a `versao` atual para controle otimista de concorrência
 * (a API rejeita se a versão mudou desde a leitura).
 *
 * @param {string} parcelaId — UUID da parcela
 * @param {number} versao — versão atual da parcela (controle de concorrência)
 * @param {object} dados — campos a injetar
 * @param {string} dados.categoriaId — UUID da categoria
 * @param {number} dados.valor — valor da despesa (obrigatório no rateio)
 * @param {string} [dados.centroCustoId] — UUID do centro de custo
 * @param {string} [dados.metodoPagamento] — string da API (ex: "PIX")
 * @param {object} [opcoes]
 * @param {Function} [opcoes.log] — função de log
 * @returns {Promise<object>} — resposta da API
 */
async function atualizarParcela(parcelaId, versao, dados, opcoes = {}) {
    const { log = console.log } = opcoes;

    // Montar o rateio com categoria e, opcionalmente, centro de custo
    const itemRateio = {
        id_categoria: dados.categoriaId,
        valor: dados.valor,
    };

    // Centro de custo vai DENTRO do rateio, como array
    // (conforme documentado em API-CONTA-AZUL.md, linhas 117-121)
    if (dados.centroCustoId) {
        itemRateio.rateio_centro_custo = [
            {
                id_centro_custo: dados.centroCustoId,
                valor: dados.valor,
            },
        ];
    }

    const corpo = {
        versao,
        rateio: [itemRateio],
    };

    // Método de pagamento, se informado
    if (dados.metodoPagamento) {
        corpo.metodo_pagamento = dados.metodoPagamento;
    }

    log(`[Enriquecedor] Atualizando parcela ${parcelaId} (versão ${versao}):`);
    log(`[Enriquecedor]   Categoria: ${dados.categoriaId}`);
    if (dados.centroCustoId) log(`[Enriquecedor]   Centro de Custo: ${dados.centroCustoId}`);
    if (dados.metodoPagamento) log(`[Enriquecedor]   Método Pagamento: ${dados.metodoPagamento}`);
    log(`[Enriquecedor]   Body: ${JSON.stringify(corpo, null, 2)}`);

    const resposta = await contaAzul.patchParcela(parcelaId, corpo);

    log(`[Enriquecedor] ✓ Parcela atualizada com sucesso!`);
    return resposta;
}

// ---------------------------------------------------------------------------
// ORQUESTRADOR — executa as 3 etapas em sequência
// ---------------------------------------------------------------------------

/**
 * Função principal do enriquecedor. Executa o fluxo completo:
 *   Etapa 2: Buscar lançamento recente por valor + data
 *   Etapa 3: Obter ID e versão da parcela
 *   Etapa 4: PATCH com categoria, centro de custo e método de pagamento
 *
 * @param {number} valor — valor da despesa
 * @param {string} data — data de competência (AAAA-MM-DD)
 * @param {object} contexto — dados do operador/OCR
 * @param {string} contexto.categoria — texto do tipo (ex: "almoco", "combustivel")
 * @param {string} [contexto.veiculo] — placa ou alias do veículo
 * @param {string} [contexto.centroCusto] — texto do centro de custo (ex: "consol mg-050")
 * @param {string} [contexto.metodoPagamento] — texto do método (ex: "pix", "dinheiro")
 * @param {object} [opcoes] — configurações de retry, log, etc.
 * @param {boolean} [opcoes.dryRun=false] — se true, não executa o PATCH
 * @param {Function} [opcoes.log] — função de log
 * @returns {Promise<object>} — resultado completo do enriquecimento
 */
async function enriquecer(valor, data, contexto, opcoes = {}) {
    const { dryRun = false, log = console.log, ...opcoesRetry } = opcoes;
    const inicio = Date.now();

    log("=".repeat(70));
    log("[Enriquecedor] Iniciando enriquecimento de lançamento");
    log(`[Enriquecedor] Valor: R$ ${valor} | Data: ${data}`);
    log(`[Enriquecedor] Contexto: ${JSON.stringify(contexto)}`);
    if (dryRun) log("[Enriquecedor] *** MODO DRY-RUN — nenhuma alteração será feita ***");
    log("=".repeat(70));

    const resultado = {
        sucesso: false,
        dryRun,
        valor,
        data,
        contexto,
        etapas: {},
        erro: null,
        duracao_ms: 0,
    };

    try {
        // -------------------------------------------------------------------
        // Resolver UUIDs localmente ANTES de buscar na API
        // -------------------------------------------------------------------
        const categoriaResolvida = resolverCategoria(
            contexto.categoria,
            contexto.veiculo || null
        );
        if (!categoriaResolvida) {
            throw new Error(
                `Categoria não encontrada para "${contexto.categoria}"`
                + (contexto.veiculo ? ` (veículo: ${contexto.veiculo})` : "")
                + `. Verifique mapeamento.json e configuracao/categorias.json.`
            );
        }
        resultado.etapas.categoria = categoriaResolvida;
        log(`[Enriquecedor] Categoria resolvida: "${categoriaResolvida.nome}" → ${categoriaResolvida.id}`);

        let centroCustoResolvido = null;
        if (contexto.centroCusto) {
            centroCustoResolvido = resolverCentroCusto(contexto.centroCusto);
            if (!centroCustoResolvido) {
                throw new Error(
                    `Centro de custo não encontrado para "${contexto.centroCusto}". `
                    + `Verifique mapeamento.json e configuracao/centros_custo.json.`
                );
            }
            log(`[Enriquecedor] Centro de custo resolvido: "${centroCustoResolvido.nome}" → ${centroCustoResolvido.id}`);
        }
        resultado.etapas.centroCusto = centroCustoResolvido;

        let metodoPagamentoResolvido = null;
        if (contexto.metodoPagamento) {
            metodoPagamentoResolvido = resolverMetodoPagamento(contexto.metodoPagamento);
            if (!metodoPagamentoResolvido) {
                throw new Error(
                    `Método de pagamento não reconhecido: "${contexto.metodoPagamento}". `
                    + `Valores aceitos: dinheiro, credito, debito, pix, boleto, transferencia.`
                );
            }
            log(`[Enriquecedor] Método de pagamento: "${contexto.metodoPagamento}" → ${metodoPagamentoResolvido}`);
        }
        resultado.etapas.metodoPagamento = metodoPagamentoResolvido;

        // -------------------------------------------------------------------
        // ETAPA 2 — Buscar lançamento
        // -------------------------------------------------------------------
        log("\n--- ETAPA 2: Busca do lançamento ---");
        const lancamento = await buscarLancamentoRecente(valor, data, { ...opcoesRetry, log });
        resultado.etapas.lancamento = {
            id: lancamento.id,
            descricao: lancamento.descricao,
            valor: lancamento.valor,
            data_competencia: lancamento.data_competencia,
        };

        // -------------------------------------------------------------------
        // ETAPA 3 — Buscar parcela
        // -------------------------------------------------------------------
        log("\n--- ETAPA 3: Captura da parcela ---");
        const { id: parcelaId, versao, parcela } = await buscarParcela(lancamento.id, { log });
        resultado.etapas.parcela = { id: parcelaId, versao };

        // -------------------------------------------------------------------
        // ETAPA 4 — PATCH de enriquecimento
        // -------------------------------------------------------------------
        log("\n--- ETAPA 4: Enriquecimento via PATCH ---");

        const dadosPatch = {
            categoriaId: categoriaResolvida.id,
            valor: Number(lancamento.valor || valor),
            centroCustoId: centroCustoResolvido?.id || null,
            metodoPagamento: metodoPagamentoResolvido,
        };

        if (dryRun) {
            log("[Enriquecedor] *** DRY-RUN: PATCH NÃO EXECUTADO ***");
            log(`[Enriquecedor] Payload que seria enviado: ${JSON.stringify(dadosPatch, null, 2)}`);
            resultado.etapas.patch = { dryRun: true, payload: dadosPatch };
        } else {
            const respostaPatch = await atualizarParcela(parcelaId, versao, dadosPatch, { log });
            resultado.etapas.patch = { executado: true, resposta: respostaPatch };
        }

        resultado.sucesso = true;
        log("\n" + "=".repeat(70));
        log(`[Enriquecedor] ✓ Enriquecimento concluído com sucesso!`);
    } catch (erro) {
        resultado.erro = erro.message;
        log(`\n[Enriquecedor] ✗ ERRO: ${erro.message}`);
    }

    resultado.duracao_ms = Date.now() - inicio;
    log(`[Enriquecedor] Duração total: ${(resultado.duracao_ms / 1000).toFixed(1)}s`);
    log("=".repeat(70));

    return resultado;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    // Funções de API (Etapas 2, 3 e 4)
    buscarLancamentoRecente,
    buscarParcela,
    atualizarParcela,

    // Resolvedores locais
    resolverCategoria,
    resolverCentroCusto,
    resolverMetodoPagamento,

    // Orquestrador principal
    enriquecer,

    // Utilidades (expostas para testes)
    limparCache,
    normalizar,
};
