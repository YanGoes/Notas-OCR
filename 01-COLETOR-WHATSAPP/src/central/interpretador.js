"use strict";

// =============================================================================
// INTERPRETADOR DE MENSAGENS DO WHATSAPP
// =============================================================================
//
// Le texto livre como os operadores realmente escrevem — sem exigir rotulos.
// Exemplos reais que precisam funcionar:
//
//   Despesas 30/09/2026        Data 01/10/2026          (Vanessa)
//   Centro de custo            Janta                    Para o projeto X a partir
//   Goinfra G.O                Lorran                   de agora utilizar C6.
//   Qtd 3 almoço               Valor R$ 37
//   Qtd 3 janta                Observações: perdi a
//   2 café                     notinha
//
// O resultado e uma INTENCAO + os dados extraidos de cada linha. Nada aqui
// decide lancamento: so organiza o que foi dito, com a origem de cada pedaco.
// =============================================================================

const { normalizar, contemTermo, dataIso, numeroMonetario } = require("./texto");
const cadastros = require("./cadastros");
const { placaDaLegenda } = require("../legenda");

const INTENCOES = Object.freeze({
    INFORMACAO_DESPESA: "INFORMACAO_DESPESA",
    INICIO_LOTE_DIARIO: "INICIO_LOTE_DIARIO",
    DEFINICAO_PROJETO: "DEFINICAO_PROJETO",
    DEFINICAO_CARTAO_POR_PROJETO: "DEFINICAO_CARTAO_POR_PROJETO",
    CORRECAO_DESPESA: "CORRECAO_DESPESA",
    QUANTIDADE_REFEICOES_OU_PESSOAS: "QUANTIDADE_REFEICOES_OU_PESSOAS",
    COBRANCA_COMPROVANTE: "COBRANCA_COMPROVANTE",
    CONFIRMACAO: "CONFIRMACAO",
    CONVERSA_IRRELEVANTE: "CONVERSA_IRRELEVANTE",
    MENSAGEM_AMBIGUA: "MENSAGEM_AMBIGUA",
});

// Tipos de despesa reconhecidos no texto do operador (palavra inteira).
const TIPOS_TEXTO = [
    { tipo: "CAFE_DA_MANHA", termos: ["cafe da manha", "cafe", "desjejum"] },
    { tipo: "ALMOCO", termos: ["almoco", "almocos"] },
    { tipo: "JANTAR", termos: ["jantar", "janta", "jantas"] },
    { tipo: "LANCHE", termos: ["lanche", "lanches"] },
    { tipo: "ABASTECIMENTO", termos: ["abastecimento", "abastecimentos", "combustivel", "gasolina", "etanol", "diesel"] },
    { tipo: "HOSPEDAGEM", termos: ["hospedagem", "hotel", "pousada", "diaria", "diarias"] },
    { tipo: "PEDAGIO", termos: ["pedagio", "pedagios"] },
    { tipo: "ESTACIONAMENTO", termos: ["estacionamento"] },
    // Refeicao sem dizer qual: o tipo exato sai da nota (horario/lote).
    { tipo: "REFEICAO", termos: ["restaurante", "refeicao", "refeicoes", "alimentacao", "lanchonete", "comida", "marmita", "self service"] },
];

function tipoDoTexto(texto) {
    for (const { tipo, termos } of TIPOS_TEXTO) if (termos.some((termo) => contemTermo(texto, termo))) return tipo;
    return null;
}

const RE_DATA = /\b(\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2}))\b/;
const RE_ROTULO_CENTRO = /^\s*(?:centro\s*(?:de\s*)?custos?|projeto|obra|cc)\b\s*[:\-,.]?\s*(.*)$/i;
const RE_QUANTIDADE = /^\s*(?:qtd\.?|qtde\.?|quantidade)?\s*[:\-]?\s*(\d{1,3})\s*[x-]?\s+(.+)$/i;
const RE_QTD_SEM_NUMERO = /^\s*(?:qtd\.?|qtde\.?|quantidade)\s*[:\-]?\s*(\D.*)$/i;
const RE_PESSOAS = /(\d{1,3})\s*(?:pessoas?|pessoa|pax|funcionarios?|colaboradores?)\b/i;
const RE_VALOR = /^\s*valor\s*[:\-]?\s*(?:r\$)?\s*([\d.,]+)/i;
const RE_OBS = /^\s*(?:observa[cç](?:[aã]o|[oõ]es)|obs\.?)\s*[:,\-]?\s*(.*)$/i;
const RE_PAGAMENTO = /^\s*(?:pagamento|forma\s*de\s*pagamento|conta\/?cart[aã]o|cart[aã]o|conta)\s*[:\-]\s*(.+)$/i;
const RE_SEM_COMPROVANTE = /\b(perdi|perdeu|sem)\s+(a\s+)?(nota|notinha|comprovante|cupom|recibo)\b|\bnota\s+perdida\b/i;

function metodoExcepcional(texto) {
    if (contemTermo(texto, "pix")) return "PIX";
    if (contemTermo(texto, "dinheiro") || contemTermo(texto, "especie")) return "DINHEIRO";
    if (contemTermo(texto, "debito")) return "CARTAO_DEBITO";
    return null;
}

/** Pagamento declarado em uma linha: cartao do cadastro ou metodo excepcional. */
function pagamentoDaLinha(cad, linha) {
    const cartao = cadastros.resolverCartao(cad, linha);
    if (cartao) return { forma: cartao.forma_pagamento, cartao: cartao.codigo, rotulo: cartao.rotulo };
    const metodo = metodoExcepcional(linha);
    return metodo ? { forma: metodo, cartao: null, rotulo: metodo } : null;
}

/**
 * Le cada linha da mensagem e extrai o que ela diz.
 * @returns {object} dados extraidos, com `linhas_nao_entendidas` para auditoria
 */
function extrair(cad, texto, { nomeRemetente = "" } = {}) {
    const dados = {
        data_declarada: null, projeto_texto: null, pagamento: null, valor_declarado: null,
        tipos: [], quantidades: [], pessoas: null, observacoes: [], itens_citados: [],
        sem_comprovante: false, placa: null, litros: null, odometro: null, linhas_nao_entendidas: [],
    };
    const linhas = String(texto || "").split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean);
    let aguardandoProjeto = false;

    for (const linha of linhas) {
        const normal = normalizar(linha);
        if (!normal) continue;

        // Nome do proprio remetente repetido na mensagem ("Lorran").
        if (nomeRemetente && normal === normalizar(nomeRemetente)) continue;

        const data = linha.match(RE_DATA);
        if (data && /^(despesas?|data|dia)\b/i.test(normal)) {
            dados.data_declarada = dataIso(data[1]);
            continue;
        }
        if (data && normal.replace(/\d/g, "").trim() === "") {
            dados.data_declarada = dataIso(data[1]);
            continue;
        }

        const centro = linha.match(RE_ROTULO_CENTRO);
        if (centro) {
            if (centro[1].trim()) dados.projeto_texto = centro[1].trim();
            else aguardandoProjeto = true;
            continue;
        }
        if (aguardandoProjeto) {
            dados.projeto_texto = linha;
            aguardandoProjeto = false;
            continue;
        }

        if (RE_SEM_COMPROVANTE.test(linha)) dados.sem_comprovante = true;

        // Dados de abastecimento digitados (opcionais): so complementam a leitura da nota.
        const placa = placaDaLegenda(linha);
        if (placa && !dados.placa) dados.placa = placa;
        const litros = linha.match(/(\d{1,3}[.,]\d{1,3})\s*(?:l|lts?|litros)\b/i);
        if (litros && !dados.litros) dados.litros = Number(litros[1].replace(",", "."));
        const odometro = linha.match(/\b(?:od|km|h?od[oô]metro)\s*:?\s*(\d{1,3}(?:\.\d{3})+|\d{4,7})\b/i);
        if (odometro && !dados.odometro) dados.odometro = Number(odometro[1].replace(/\D/g, ""));
        if ((placa || litros || odometro) && normalizar(linha).split(" ").length <= 6
            && !tipoDoTexto(linha) && !cadastros.pareceProjeto(cad, linha)) continue;

        const obs = linha.match(RE_OBS);
        if (obs) {
            const conteudo = obs[1].trim();
            if (conteudo && !/^s\s*\/?\s*a$/i.test(conteudo)) dados.observacoes.push(conteudo);
            continue;
        }

        const valor = linha.match(RE_VALOR);
        if (valor) {
            dados.valor_declarado = numeroMonetario(valor[1]);
            continue;
        }

        const pagamentoRotulado = linha.match(RE_PAGAMENTO);
        const pagamento = pagamentoDaLinha(cad, pagamentoRotulado ? pagamentoRotulado[1] : linha);
        if (pagamento && (pagamentoRotulado || /^(cr[eé]dito|pix|dinheiro|d[eé]bito)/i.test(linha) || normal.split(" ").length <= 3)) {
            dados.pagamento = pagamento;
            continue;
        }

        const pessoas = linha.match(RE_PESSOAS);
        if (pessoas) {
            dados.pessoas = { quantidade: Number(pessoas[1]), tipo: tipoDoTexto(linha), semantica: "PESSOAS", origem: "texto" };
            const tipo = tipoDoTexto(linha);
            if (tipo && !dados.tipos.includes(tipo)) dados.tipos.push(tipo);
            continue;
        }

        const quantidade = linha.match(RE_QUANTIDADE);
        if (quantidade) {
            const tipo = tipoDoTexto(quantidade[2]);
            if (tipo) {
                // "Qtd 3 almoço" pode ser 3 pessoas OU 3 notas: nunca decide sozinho.
                dados.quantidades.push({ tipo, quantidade: Number(quantidade[1]), semantica: "INDETERMINADA", texto: linha });
            } else {
                dados.itens_citados.push({ descricao: quantidade[2].trim(), quantidade: Number(quantidade[1]), texto: linha });
            }
            continue;
        }
        const qtdSemNumero = linha.match(RE_QTD_SEM_NUMERO);
        if (qtdSemNumero) {
            dados.itens_citados.push({ descricao: qtdSemNumero[1].trim(), quantidade: null, texto: linha });
            continue;
        }

        // Veiculo citado pelo nome ("Fiat Scudo"): nunca e projeto.
        const veiculo = cadastros.resolverVeiculoPorTexto(cad, linha);
        if (veiculo.status !== "DESCONHECIDO") {
            dados.veiculo_texto = linha;
            if (veiculo.veiculo && !dados.placa) dados.placa = veiculo.veiculo.placa;
            continue;
        }

        const tipo = tipoDoTexto(linha);
        if (tipo && normal.split(" ").length <= 4) {
            if (!dados.tipos.includes(tipo)) dados.tipos.push(tipo);
            continue;
        }

        // Linha solta que corresponde a um projeto do cadastro ("Goinfra G.O").
        if (!dados.projeto_texto && cadastros.pareceProjeto(cad, linha)) {
            dados.projeto_texto = linha;
            continue;
        }

        dados.linhas_nao_entendidas.push(linha);
    }

    // Cabecalho "Despesas 06/10/2026" seguido de uma linha solta: na pratica
    // e o projeto escrito sem rotulo ("GOINFRA FWD"). Fica como texto do
    // projeto; se nao casar com o cadastro, a despesa vai para revisao.
    const comecaComData = linhas.length && /^(despesas?|data|dia)\b/.test(normalizar(linhas[0])) && dados.data_declarada;
    if (!dados.projeto_texto && comecaComData && dados.linhas_nao_entendidas.length) {
        const candidata = dados.linhas_nao_entendidas.find((linha) => normalizar(linha).split(" ").length <= 8);
        if (candidata) {
            dados.projeto_texto = candidata;
            dados.projeto_inferido_por_posicao = true;
            dados.linhas_nao_entendidas = dados.linhas_nao_entendidas.filter((linha) => linha !== candidata);
        }
    }
    return dados;
}

const RE_AGRADECIMENTO = /^(ok+|okay|blz|beleza|obrigad[oa]s?|obg|valeu|vlw|show|perfeito|certo|top|bom dia|boa tarde|boa noite|👍|🙏|✅)\b/i;
const RE_COBRANCA = /\b(falta(m|ram)?|cad[eê]|mand(a|em|ar)|envi(a|em|ar)|aguardando)\b.*\b(nota|notas|notinha|comprovante|comprovantes|cupom|cupons|recibo)/i;
const RE_VIGENCIA = /\b(a\s+partir\s+de|daqui\s+(pra|para)\s+frente|agora|sempre|utiliz(ar|em)|us(ar|em)|passa(r|m)?\s+a)\b/i;
const RE_CORRECAO = /\b(era|e)\s+(.+?)\s+e\s+n[aã]o\s+(.+)|\bn[aã]o\s+(era|e)\s+(.+?),?\s+(era|e|mas)\s+(.+)|\bcorrig|\berrad[oa]\b/i;

/**
 * Classifica a mensagem e extrai os dados.
 *
 * @param {object} cad — cadastros carregados
 * @param {object} mensagem
 * @param {string} mensagem.texto
 * @param {boolean} [mensagem.temMidia] — mensagem e legenda de uma foto
 * @param {object} [mensagem.pessoa] — pessoa identificada (pode ser null)
 * @param {string} [mensagem.nomeRemetente]
 */
function interpretar(cad, { texto = "", temMidia = false, pessoa = null, nomeRemetente = "" } = {}) {
    const bruto = String(texto || "").trim();
    const dados = extrair(cad, bruto, { nomeRemetente: pessoa?.nome || nomeRemetente });
    const normal = normalizar(bruto);
    const autoridade = Boolean(pessoa?.autoridade_financeira);
    const resultado = (intencao, extra = {}) => ({ intencao, dados, autoridade_financeira: autoridade, ...extra });

    if (!bruto) return resultado(temMidia ? INTENCOES.INFORMACAO_DESPESA : INTENCOES.CONVERSA_IRRELEVANTE);

    // Instrucao de cartao por projeto: so vale de quem tem autoridade financeira.
    const cartaoNaFrase = dados.pagamento?.cartao ? dados.pagamento : pagamentoDaLinha(cad, bruto);
    if (!temMidia && cartaoNaFrase?.cartao && RE_VIGENCIA.test(bruto)) {
        dados.pagamento = cartaoNaFrase;
        const projetoTexto = limparProjetoDaFrase(dados.projeto_texto) || projetoNaFrase(cad, bruto);
        if (projetoTexto) {
            dados.projeto_texto = projetoTexto;
            return resultado(INTENCOES.DEFINICAO_CARTAO_POR_PROJETO, { exige_autoridade: true, autorizada: autoridade });
        }
    }

    if (RE_CORRECAO.test(bruto) && !temMidia && bruto.length < 400) return resultado(INTENCOES.CORRECAO_DESPESA);
    if (!temMidia && RE_COBRANCA.test(bruto)) return resultado(INTENCOES.COBRANCA_COMPROVANTE);
    if (!temMidia && RE_AGRADECIMENTO.test(normal) && normal.split(" ").length <= 6) {
        return resultado(/^(ok|okay|blz|beleza|certo|perfeito|✅|👍)/i.test(normal) ? INTENCOES.CONFIRMACAO : INTENCOES.CONVERSA_IRRELEVANTE);
    }

    if (temMidia) return resultado(INTENCOES.INFORMACAO_DESPESA);

    const temValor = dados.valor_declarado !== null;
    const temLote = dados.quantidades.length > 0 || dados.itens_citados.length > 0
        || (dados.data_declarada && !temValor && (dados.projeto_texto || dados.pagamento || dados.tipos.length));
    if (dados.sem_comprovante || (temValor && (dados.tipos.length || dados.data_declarada))) {
        return resultado(INTENCOES.INFORMACAO_DESPESA);
    }
    if (temLote) return resultado(INTENCOES.INICIO_LOTE_DIARIO);
    if (dados.projeto_texto) return resultado(INTENCOES.DEFINICAO_PROJETO);
    if (dados.pessoas) return resultado(INTENCOES.QUANTIDADE_REFEICOES_OU_PESSOAS);
    if (dados.pagamento || dados.data_declarada || dados.tipos.length) return resultado(INTENCOES.MENSAGEM_AMBIGUA);
    return resultado(INTENCOES.CONVERSA_IRRELEVANTE);
}

/** "Goinfra fwd agora vai no Inter" -> "Goinfra fwd". */
function limparProjetoDaFrase(texto) {
    if (!texto) return null;
    const limpo = String(texto)
        .split(/\s+(?:a\s+partir|daqui|utiliz\w*|us(?:ar|em|e)|passa\w*|agora|sempre|vai|vao|fica|deve\w*|no\s+cart|com\s+o?\s*cart|no\s+cr[eé]d)\b|[,.;]/i)[0]
        .trim();
    return limpo || null;
}

/** Procura, dentro de uma frase, o trecho que corresponde a um projeto do cadastro. */
function projetoNaFrase(cad, frase) {
    const projetos = cadastros.projetosComId(cad).filter((projeto) => projeto.ativo !== false);
    const achados = projetos.filter((projeto) => [projeto.nome_oficial, ...(projeto.apelidos || [])]
        .some((nome) => contemTermo(frase, nome)));
    if (achados.length === 1) return achados[0].nome_oficial;
    const depoisDeProjeto = String(frase).match(/\bprojeto\s+(.+?)(?:\s+(?:a\s+partir|daqui|utiliz|us(?:ar|em)|passa|agora|,|\.|$))/i);
    return depoisDeProjeto ? depoisDeProjeto[1].trim() : null;
}

module.exports = { interpretar, extrair, tipoDoTexto, pagamentoDaLinha, INTENCOES };
