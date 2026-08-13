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
 * Trava de execução: evita que duas chamadas concorrentes de `enriquecer()`
 * para a mesma despesa (mesmo valor + data, ou a chave informada pelo
 * chamador) rodem ao mesmo tempo e apliquem PATCHs conflitantes/duplicados.
 */
const _emExecucao = new Set();

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
    const configuradas = lerJson(path.join(RAIZ, "configuracao", "categorias.json"), []) || [];
    const baixadas = lerJson(path.join(RAIZ, "dados", "conta-azul", "categorias-despesa.json"), []) || [];

    const mapa = new Map();
    for (const cat of baixadas) {
        if (cat?.id && cat?.nome) {
            mapa.set(normalizar(cat.nome), { id: cat.id, nome: cat.nome, nome_conta_azul: cat.nome });
        }
    }
    for (const cat of configuradas) {
        const chave = normalizar(cat.nome_conta_azul || cat.nome);
        if (cat?.id && !cat.id.startsWith("PREENCHER_")) {
            mapa.set(chave, { id: cat.id, nome: cat.nome, nome_conta_azul: cat.nome_conta_azul || cat.nome });
        }
    }
    return Array.from(mapa.values());
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
    // 3. Se há veículo informado e o tipo É combustível ou manutenção,
    //    buscar a categoria específica do veículo
    // -----------------------------------------------------------------------
    const ehCombustivelOuManutencao = [
        "combustivel", "abastecimento", "gasolina", "etanol", "diesel",
        "manutencao", "oficina", "mecanica", "auto pecas", "veiculo", "carro"
    ].includes(chave);

    if (textoVeiculo && mapeamento.veiculos && ehCombustivelOuManutencao) {
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
 * @param {string} [opcoes.fornecedorCnpj] — CNPJ/CPF (só dígitos) do fornecedor
 *   esperado, usado apenas para desempatar quando mais de um lançamento bate
 *   com valor+data. Não é usado como filtro de busca, só de desambiguação.
 * @param {Function} [opcoes.log] — função de log (padrão: console.log)
 * @returns {Promise<object>} — o evento financeiro encontrado
 * @throws {Error} — se não encontrar após todas as tentativas, ou se houver
 *   mais de um candidato e não for possível desambiguar com segurança
 *   (nesse caso o erro tem `erro.ambiguo = true` e não é retentado).
 */
async function buscarLancamentoRecente(valor, data, opcoes = {}) {
    const {
        tentativas = 5,
        intervaloInicialMs = 10000,
        toleranciaValor = 0.01,
        toleranciaDias = 1,
        fornecedorCnpj = null,
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
        data_vencimento_de: formatarData(dataInicio),
        data_vencimento_ate: formatarData(dataFim),
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
                let candidatos = itens;

                if (itens.length > 1) {
                    log(`[Enriquecedor] ⚠ ${itens.length} lançamentos encontrados no período/valor.`);
                    if (fornecedorCnpj) {
                        const alvo = String(fornecedorCnpj).replace(/\D/g, "");
                        const filtrados = itens.filter((item) => {
                            const cnpjItem = String(
                                item.fornecedor?.documento || item.fornecedor?.cnpj || item.contato?.documento || ""
                            ).replace(/\D/g, "");
                            return alvo && cnpjItem && cnpjItem === alvo;
                        });
                        if (filtrados.length === 1) {
                            candidatos = filtrados;
                            log(`[Enriquecedor] Desambiguado por fornecedor (CNPJ/CPF): id=${candidatos[0].id}`);
                        }
                    }
                    if (candidatos.length > 1) {
                        // Nunca escolher "o primeiro" quando ha ambiguidade real: risco de
                        // aplicar categoria/centro/metodo no lancamento errado.
                        const erroAmbiguo = new Error(
                            `[Enriquecedor] ${candidatos.length} lançamentos ambíguos para valor=R$ ${valor}, `
                            + `data=${data}. Não é seguro escolher automaticamente qual complementar; `
                            + `informe o CNPJ/CPF do fornecedor ou complete manualmente no Conta Azul.`
                        );
                        erroAmbiguo.ambiguo = true;
                        throw erroAmbiguo;
                    }
                }

                const lancamento = candidatos[0];
                log(`[Enriquecedor] Lançamento encontrado na tentativa ${tentativa}/${tentativas}: id=${lancamento.id}`);
                log(`[Enriquecedor]   Descrição: ${lancamento.descricao || "(sem descrição)"}`);
                const valorExibicao = lancamento.valor ?? lancamento.valor_total ?? lancamento.valor_bruto ?? valor;
                log(`[Enriquecedor]   Valor: R$ ${valorExibicao}`);
                log(`[Enriquecedor]   Data competência: ${lancamento.data_competencia}`);

                return lancamento;
            }

            // Lançamento ainda não apareceu — aguardar e tentar novamente
            if (tentativa < tentativas) {
                const espera = intervaloInicialMs * Math.pow(2, tentativa - 1);
                log(`[Enriquecedor] Tentativa ${tentativa}/${tentativas}: lançamento não encontrado. Aguardando ${espera / 1000}s...`);
                await esperar(espera);
            }
        } catch (erro) {
            // Ambiguidade nunca deve ser retentada: tentar de novo não resolve
            // qual lançamento é o certo, só atrasa o erro.
            if (erro.ambiguo) throw erro;

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
function extrairNumVersao(obj) {
    if (typeof obj?.versao === "number") return obj.versao;
    if (typeof obj?.version === "number") return obj.version;
    return 0;
}

/**
 * Lê o que já está preenchido numa parcela (retorno de
 * `GET /v1/financeiro/eventos-financeiros/parcelas/{id}`), para que o
 * enriquecedor só complemente o que a Conta AI deixou ausente — nunca
 * sobrescreva um valor que ela já identificou corretamente.
 *
 * @param {object} parcela — objeto retornado por buscarParcela()/obterParcelaFinanceira()
 * @returns {{ categoriaId: string|null, centroCustoId: string|null, metodoPagamento: string|null }}
 */
function extrairEstadoAtual(parcela) {
    const rateio = Array.isArray(parcela?.rateio) ? parcela.rateio[0] : null;
    const centroRateio = Array.isArray(rateio?.rateio_centro_custo) ? rateio.rateio_centro_custo[0] : null;
    const anexos = parcela?.anexos ?? parcela?.evento?.anexos;
    return {
        categoriaId: rateio?.id_categoria || null,
        centroCustoId: centroRateio?.id_centro_custo || null,
        metodoPagamento: parcela?.metodo_pagamento || null,
        // Campos que o enriquecedor nao altera, mas confere para avisar o operador
        descricao: parcela?.descricao || parcela?.evento?.descricao || null,
        fornecedor: parcela?.fornecedor?.nome || parcela?.contato?.nome || parcela?.evento?.fornecedor?.nome || null,
        dataCompetencia: parcela?.data_competencia || parcela?.evento?.data_competencia || null,
        dataVencimento: parcela?.data_vencimento || null,
        contaFinanceira: parcela?.conta_financeira?.id || parcela?.id_conta_financeira || null,
        valor: parcela?.valor ?? parcela?.valor_composicao?.valor_bruto ?? null,
        anexos: Array.isArray(anexos) ? anexos.length : null,
    };
}

/**
 * Confere o lancamento inteiro e devolve o que continua vazio no Conta Azul,
 * separando o que este modulo consegue preencher do que depende de uma pessoa.
 *
 * @returns {Array<{campo:string, rotulo:string, preenchivel:boolean}>}
 */
function camposFaltantes(estadoAtual = {}) {
    const conferencia = [
        { campo: "categoria", rotulo: "Categoria", valor: estadoAtual.categoriaId, preenchivel: true },
        { campo: "centro_custo", rotulo: "Centro de custo", valor: estadoAtual.centroCustoId, preenchivel: true },
        { campo: "metodo_pagamento", rotulo: "Forma de pagamento", valor: estadoAtual.metodoPagamento, preenchivel: true },
        { campo: "descricao", rotulo: "Descricao", valor: estadoAtual.descricao, preenchivel: false },
        { campo: "fornecedor", rotulo: "Fornecedor", valor: estadoAtual.fornecedor, preenchivel: false },
        { campo: "data_competencia", rotulo: "Data de competencia", valor: estadoAtual.dataCompetencia, preenchivel: false },
        { campo: "data_vencimento", rotulo: "Data de vencimento", valor: estadoAtual.dataVencimento, preenchivel: false },
        { campo: "conta_financeira", rotulo: "Conta financeira", valor: estadoAtual.contaFinanceira, preenchivel: false },
        { campo: "valor", rotulo: "Valor", valor: estadoAtual.valor, preenchivel: false },
        { campo: "anexo", rotulo: "Imagem anexada", valor: estadoAtual.anexos, preenchivel: false },
    ];
    return conferencia
        .filter(({ valor }) => valor === null || valor === undefined || valor === "" || valor === 0)
        .map(({ campo, rotulo, preenchivel }) => ({ campo, rotulo, preenchivel }));
}

async function buscarParcela(eventoId, opcoes = {}) {
    const { log = console.log } = opcoes;

    log(`[Enriquecedor] Buscando parcelas do evento: ${eventoId}`);

    try {
        // Tenta o endpoint específico de parcelas do evento
        const resposta = await contaAzul.buscarParcelasDoEvento(eventoId);
        const parcelas = resposta?.itens || resposta?.items || (Array.isArray(resposta) ? resposta : []);

        if (parcelas.length > 0) {
            const parcela = parcelas[0];
            const v = extrairNumVersao(parcela);
            log(`[Enriquecedor] Parcela encontrada: id=${parcela.id}, versão=${v}`);
            return {
                id: parcela.id,
                versao: v,
                parcela,
            };
        }
    } catch (erro) {
        log(`[Enriquecedor] Endpoint de parcelas por evento falhou: ${erro.message}`);
        log(`[Enriquecedor] Tentando via obterParcelaFinanceira (fallback)...`);
    }

    // Fallback: obter detalhe da parcela via obterParcelaFinanceira
    try {
        const detalhe = await contaAzul.obterParcelaFinanceira(eventoId);
        if (detalhe?.id) {
            const v = extrairNumVersao(detalhe);
            log(`[Enriquecedor] Parcela obtida via fallback: id=${detalhe.id}, versão=${v}`);
            return {
                id: detalhe.id,
                versao: v,
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
 * Detecta se um erro de PATCH parece ser rejeição de um campo específico
 * (400/422) — caso em que vale tentar um payload menor — em oposição a
 * erro de autenticação, rede ou versão desatualizada, que não deve ser
 * mascarado tentando outro formato de corpo.
 */
function pareceRejeicaoDeCampo(mensagemErro) {
    return /Conta Azul (400|422):/i.test(String(mensagemErro || ""));
}

/**
 * Atualiza uma parcela existente com Categoria, Centro de Custo e Método
 * de Pagamento via PATCH.
 *
 * IMPORTANTE — o contrato oficial documenta `rateio`/`rateio_centro_custo`
 * apenas para a CRIAÇÃO do lançamento; só `metodo_pagamento` foi confirmado
 * por teste real como aceito no PATCH da parcela (ver API-CONTA-AZUL.md).
 * Por isso esta função não assume que o payload completo será aceito: ela
 * tenta o payload completo primeiro e, apenas se a API rejeitar
 * especificamente por causa de um campo (400/422), tenta payloads
 * progressivamente menores. Erros de autenticação/rede/versão nunca
 * disparam esse fallback — são propagados imediatamente.
 *
 * O body envia a `versao` atual para controle otimista de concorrência
 * (a API rejeita se a versão mudou desde a leitura).
 *
 * @param {string} parcelaId — UUID da parcela
 * @param {number} versao — versão atual da parcela (controle de concorrência)
 * @param {object} dados — campos a injetar (usar `null` para "nada a enviar nesse campo")
 * @param {string} [dados.categoriaId] — UUID da categoria
 * @param {number} dados.valor — valor da despesa (obrigatório no rateio)
 * @param {string} [dados.centroCustoId] — UUID do centro de custo
 * @param {string} [dados.metodoPagamento] — string da API (ex: "PIX")
 * @param {object} [opcoes]
 * @param {Function} [opcoes.log] — função de log
 * @returns {Promise<{resposta:object, tentativaAplicada:string, categoriaAplicada:boolean, centroCustoAplicado:boolean, metodoPagamentoAplicado:boolean}>}
 * @throws {Error} — se nenhuma tentativa for aceita
 */
async function atualizarParcela(parcelaId, versao, dados, opcoes = {}) {
    const { log = console.log } = opcoes;

    function montarCorpo({ incluirRateio, incluirCentro, incluirMetodo }) {
        const corpo = { versao: Number(versao), version: Number(versao) };
        if (incluirRateio && dados.categoriaId) {
            const itemRateio = { id_categoria: dados.categoriaId, valor: dados.valor };
            // Centro de custo vai DENTRO do rateio, como array
            // (conforme documentado em API-CONTA-AZUL.md, linhas 117-121)
            if (incluirCentro && dados.centroCustoId) {
                itemRateio.rateio_centro_custo = [{ id_centro_custo: dados.centroCustoId, valor: dados.valor }];
            }
            corpo.rateio = [itemRateio];
        }
        if (incluirMetodo && dados.metodoPagamento) corpo.metodo_pagamento = dados.metodoPagamento;
        return corpo;
    }

    const tentativas = [];
    if (dados.categoriaId) {
        tentativas.push({ nome: "rateio_completo", incluirRateio: true, incluirCentro: true, incluirMetodo: true });
        if (dados.centroCustoId) {
            tentativas.push({ nome: "rateio_sem_centro_custo", incluirRateio: true, incluirCentro: false, incluirMetodo: true });
        }
    }
    if (dados.metodoPagamento) {
        tentativas.push({ nome: "somente_metodo_pagamento", incluirRateio: false, incluirCentro: false, incluirMetodo: true });
    }

    let ultimoErro = null;
    for (const tentativa of tentativas) {
        const corpo = montarCorpo(tentativa);
        if (!corpo.rateio && !corpo.metodo_pagamento) continue; // nada a enviar nesse payload

        log(`[Enriquecedor] Tentativa "${tentativa.nome}" na parcela ${parcelaId} (versão ${versao}):`);
        log(`[Enriquecedor]   Body: ${JSON.stringify(corpo, null, 2)}`);

        try {
            const resposta = await contaAzul.patchParcela(parcelaId, corpo);
            log(`[Enriquecedor] ✓ PATCH aceito na tentativa "${tentativa.nome}"!`);
            return {
                resposta,
                tentativaAplicada: tentativa.nome,
                categoriaAplicada: Boolean(corpo.rateio),
                centroCustoAplicado: Boolean(corpo.rateio?.[0]?.rateio_centro_custo),
                metodoPagamentoAplicado: Boolean(corpo.metodo_pagamento),
            };
        } catch (erro) {
            ultimoErro = erro;
            log(`[Enriquecedor] ✗ Tentativa "${tentativa.nome}" falhou: ${erro.message}`);
            // Só tenta um payload menor quando a API rejeitou por causa de um campo
            // (400/422). Auth/rede/versão desatualizada não devem ser mascarados.
            if (!pareceRejeicaoDeCampo(erro.message)) throw erro;
        }
    }

    throw ultimoErro || new Error("[Enriquecedor] Nenhum campo para atualizar (categoria/centro/método ausentes).");
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
 * @param {string} [opcoes.chaveIdempotencia] — chave para a trava de execução
 *   concorrente (ex: nome base do arquivo da nota). Se omitida, usa `valor|data`.
 * @param {string} [opcoes.fornecedorCnpj] — CNPJ/CPF do fornecedor, usado só
 *   para desambiguar quando há mais de um lançamento candidato.
 * @param {Function} [opcoes.log] — função de log
 * @returns {Promise<object>} — resultado completo do enriquecimento
 */
async function enriquecer(valor, data, contexto, opcoes = {}) {
    const { dryRun = false, log = console.log, chaveIdempotencia, ...opcoesRetry } = opcoes;
    const inicio = Date.now();
    const chave = chaveIdempotencia || `${valor}|${data}`;

    if (_emExecucao.has(chave)) {
        throw new Error(
            `[Enriquecedor] Já existe um enriquecimento em andamento para esta despesa (${chave}). `
            + `Evite clicar/chamar novamente; aguarde a execução anterior terminar.`
        );
    }
    _emExecucao.add(chave);

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
        pendencias: [],
        erro: null,
        duracao_ms: 0,
    };

    try {
        // -------------------------------------------------------------------
        // Resolver UUIDs localmente ANTES de buscar na API
        // -------------------------------------------------------------------
        // Quando o pipeline ja resolveu os UUIDs (classificacao local), reaproveita
        // em vez de resolver o texto de novo — evita divergencia entre as duas etapas.
        const categoriaResolvida = contexto.categoriaId
            ? { id: contexto.categoriaId, nome: contexto.categoriaNome || contexto.categoriaId }
            : resolverCategoria(contexto.categoria, contexto.veiculo || null);
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
        if (contexto.centroCustoId) {
            centroCustoResolvido = { id: contexto.centroCustoId, nome: contexto.centroCustoNome || contexto.centroCustoId };
            log(`[Enriquecedor] Centro de custo recebido ja resolvido: "${centroCustoResolvido.nome}" → ${centroCustoResolvido.id}`);
        } else if (contexto.centroCusto) {
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
        const lancamento = await buscarLancamentoRecente(valor, data, {
            ...opcoesRetry,
            fornecedorCnpj: opcoes.fornecedorCnpj || null,
            log,
        });
        resultado.etapas.lancamento = {
            id: lancamento.id,
            descricao: lancamento.descricao,
            valor: lancamento.valor ?? lancamento.valor_total ?? valor,
            data_competencia: lancamento.data_competencia,
        };

        // -------------------------------------------------------------------
        // ETAPA 3 — Buscar parcela
        // -------------------------------------------------------------------
        log("\n--- ETAPA 3: Captura da parcela ---");
        const { id: parcelaId, versao, parcela } = await buscarParcela(lancamento.id, { log });
        resultado.etapas.parcela = { id: parcelaId, versao };

        // O que a Conta AI já preencheu — nunca sobrescrever isso automaticamente.
        const estadoAtual = extrairEstadoAtual(parcela);
        const categoriaJaPresente = Boolean(estadoAtual.categoriaId);
        const centroJaPresente = Boolean(estadoAtual.centroCustoId);
        const metodoJaPresente = Boolean(estadoAtual.metodoPagamento);
        log(
            `[Enriquecedor] Estado atual na Conta Azul — categoria: ${estadoAtual.categoriaId || "(ausente)"}, `
            + `centro de custo: ${estadoAtual.centroCustoId || "(ausente)"}, `
            + `método de pagamento: ${estadoAtual.metodoPagamento || "(ausente)"}`
        );
        resultado.etapas.estado_atual = estadoAtual;
        resultado.etapas.campos_faltantes = camposFaltantes(estadoAtual);
        resultado.etapas.campos_mantidos = {
            categoria: categoriaJaPresente,
            centro_custo: centroJaPresente,
            metodo_pagamento: metodoJaPresente,
        };

        // -------------------------------------------------------------------
        // ETAPA 4 — PATCH de enriquecimento (só dos campos ainda ausentes)
        // -------------------------------------------------------------------
        log("\n--- ETAPA 4: Enriquecimento via PATCH ---");

        const dadosPatch = {
            // Categoria é obrigatória no rateio: mantém a já existente se houver,
            // só usa a resolvida localmente quando a Conta AI não preencheu nada.
            categoriaId: estadoAtual.categoriaId || categoriaResolvida.id,
            valor: Number(lancamento.valor || valor),
            centroCustoId: centroJaPresente ? null : (centroCustoResolvido?.id || null),
            metodoPagamento: metodoJaPresente ? null : metodoPagamentoResolvido,
        };

        const nadaAComplementar = categoriaJaPresente
            && (centroJaPresente || !dadosPatch.centroCustoId)
            && (metodoJaPresente || !dadosPatch.metodoPagamento);

        if (nadaAComplementar) {
            log("[Enriquecedor] A Conta AI já preencheu tudo que este módulo poderia complementar; nenhum PATCH necessário.");
            resultado.etapas.patch = { executado: false, motivo: "nada_a_complementar" };
        } else if (dryRun) {
            log("[Enriquecedor] *** DRY-RUN: PATCH NÃO EXECUTADO ***");
            log(`[Enriquecedor] Payload que seria enviado: ${JSON.stringify(dadosPatch, null, 2)}`);
            resultado.etapas.patch = { dryRun: true, payload: dadosPatch };
        } else {
            const aplicado = await atualizarParcela(parcelaId, versao, dadosPatch, { log });
            resultado.etapas.patch = { executado: true, ...aplicado };
            if (dadosPatch.centroCustoId && !aplicado.centroCustoAplicado) {
                log("[Enriquecedor] ⚠ Centro de custo não pôde ser confirmado via PATCH; requer revisão manual no Conta Azul.");
                resultado.pendencias.push("centro_de_custo_nao_aplicado_via_api");
            }
            if (dadosPatch.metodoPagamento && !aplicado.metodoPagamentoAplicado) {
                resultado.pendencias.push("metodo_pagamento_nao_aplicado_via_api");
            }
        }

        resultado.sucesso = true;
        log("\n" + "=".repeat(70));
        log(`[Enriquecedor] ✓ Enriquecimento concluído com sucesso!`);
    } catch (erro) {
        resultado.erro = erro.message;
        log(`\n[Enriquecedor] ✗ ERRO: ${erro.message}`);
    } finally {
        _emExecucao.delete(chave);
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
    extrairEstadoAtual,
    camposFaltantes,

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
