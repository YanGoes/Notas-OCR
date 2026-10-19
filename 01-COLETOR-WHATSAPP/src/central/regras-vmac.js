"use strict";

// =============================================================================
// MOTOR DE REGRAS VMAC — monta a PREVIA de uma despesa
// =============================================================================
//
// Prioridades (dossie, secoes 0, 4 e 22):
//   - data de competencia = data impressa na NOTA (nunca a do WhatsApp);
//   - valor = total lido na NOTA; valor digitado so e comparado e auditado;
//   - horario so serve de PISTA (cafe/almoco/jantar), nunca e lancado;
//   - pagamento = o que o operador declarou ou a politica de cartao do
//     projeto; o "DINHEIRO" impresso no cupom nao decide nada;
//   - cartao declarado diferente da politica da gerencia -> revisao;
//   - abastecimento sem litros, hodometro ou placa -> fica pendente;
//   - descricoes seguem templates literais, sem texto livre da IA.
//
// Nada e inventado: o que nao tem evidencia vira PENDENCIA para a Central.
// =============================================================================

const { normalizar, contemTermo, centavos } = require("./texto");
const modeloCentral = require("./modelo");
const cadastros = require("./cadastros");

const TIPOS = Object.freeze({
    CAFE_DA_MANHA: { rotulo: "CAFÉ DA MANHÃ", categoria: "CAFE DA MANHA", refeicao: true },
    ALMOCO: { rotulo: "ALMOÇO", categoria: "ALMOCO", refeicao: true },
    JANTAR: { rotulo: "JANTAR", categoria: "JANTAR", refeicao: true },
    LANCHE: { rotulo: "LANCHE", categoria: "ALIMENTACAO EM CAMPO", refeicao: true },
    ABASTECIMENTO: { rotulo: "ABASTECIMENTO", categoria: null },
    HOSPEDAGEM: { rotulo: "HOSPEDAGEM", categoria: "HOSPEDAGEM" },
    PEDAGIO: { rotulo: "PEDÁGIO", categoria: "PEDAGIO" },
    ESTACIONAMENTO: { rotulo: "ESTACIONAMENTO", categoria: "ESTACIONAMENTO" },
    // Manutencao de veiculo: categoria de manutencao do proprio veiculo (pela placa) ou a geral.
    MANUTENCAO: { rotulo: "MANUTENÇÃO", categoria: "MANUTENCAO" },
    // Agua mineral (nota so de agua): categoria "Água" do Conta Azul, com a quantidade.
    AGUA: { rotulo: "ÁGUA", categoria: "AGUA" },
    MERCADO: { rotulo: "MERCADO", categoria: null },
    OUTROS: { rotulo: "OUTROS", categoria: null },
});

const TIPO_ANEXO_FISCAL = "Documento fiscal";
const TIPO_ANEXO_OUTROS = "Outros";

// ---------------------------------------------------------------------------
// Formatadores literais
// ---------------------------------------------------------------------------

/** 35.43 -> "35,43" (mantem as casas lidas; nao arredonda nem completa). */
function litrosBr(litros) {
    return String(Number(litros)).replace(".", ",");
}

/** 145225 -> "145.225" */
function milharBr(numero) {
    return String(Math.trunc(Number(numero))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * Descricao de abastecimento, EXATAMENTE: "35,43L od 145.225 - JKN2876".
 * Devolve null se faltar qualquer um dos tres dados (nunca completa sozinho).
 */
function descricaoAbastecimento({ litros, odometro, placa }) {
    if (!(Number(litros) > 0) || !placa) return null;
    // Nota sem hodometro: mesmo padrao, com o lugar do numero vazio ("45,34L od - OVN1505").
    const od = Number(odometro) > 0 ? `od ${milharBr(odometro)}` : "od";
    return `${litrosBr(litros)}L ${od} - ${cadastros.placaCanonica(placa)}`;
}

/** "JANTAR - 3 PESSOAS" / "ALMOÇO - 1 PESSOA" */
function descricaoRefeicao(tipo, pessoas) {
    const rotulo = TIPOS[tipo]?.rotulo;
    if (!rotulo || !(Number(pessoas) > 0)) return null;
    return `${rotulo} - ${pessoas} ${Number(pessoas) === 1 ? "PESSOA" : "PESSOAS"}`;
}

// ---------------------------------------------------------------------------
// Tipo da despesa
// ---------------------------------------------------------------------------

const COMBUSTIVEIS = ["gasolina", "etanol", "alcool", "diesel", "gnv", "arla"];
// Concessionarias de rodovia: a nota de pedagio vem com o nome delas ("Conc. ECOVIAS").
// Itens que indicam refeicao (posto com lanchonete, conveniencia).
const ITENS_DE_COMIDA = ["prato", "pf", "refeicao", "marmita", "marmitex", "almoco", "jantar", "janta", "lanche", "executivo", "self service", "buffet", "comida",
    "salgado", "pastel", "coxinha", "esfirra", "empada", "pao de queijo", "pao", "sanduiche", "misto", "hamburguer", "x burguer", "x tudo", "pizza", "espetinho",
    "suco", "refrigerante", "refri", "coca", "guarana", "cafe", "cappuccino", "cha", "vitamina", "acai", "sorvete", "bolo", "biscoito", "porcao"];
// Prato principal: contado na nota, diz quantas pessoas comeram.
const PRATOS_PRINCIPAIS = ["prato", "pf", "marmita", "marmitex", "executivo", "refeicao", "almoco", "jantar", "self service", "buffet", "parmegiana", "file"];
const CONCESSIONARIAS = /\b(conc|concession\w*|ecovias|ecorodovias|ecopistas|ecosul|arteris|autoban|autopista\w*|triunfo|viapaulista|rota das bandeiras|entrevias|eixo sp|ccr|motiva)\b/;
const OFICINAS = ["oficina", "mecanica", "auto pecas", "autopecas", "auto center", "centro automotivo", "borracharia", "pneus", "retifica", "funilaria", "auto eletrica", "lubrificantes"];
const RESTAURANTES = ["restaurante", "lanchonete", "churrascaria", "pizzaria", "padaria", "panificadora", "confeitaria",
    "cafeteria", "bar", "self service", "marmitaria", "pastelaria", "hamburgueria", "lanches", "grill", "buffet"];
const HOTEIS = ["hotel", "hoteis", "pousada", "hostel", "motel", "hospedagem", "flat", "apart hotel"];
const MERCADOS = ["supermercado", "supermercados", "mercado", "mercearia", "atacadao", "atacadista", "hipermercado", "minimercado"];

// Material de campo (revisao de 13/10: ferragens com parafuso e cola de contato
// tinham virado "restaurante"). Estabelecimento ou itens com estes termos.
// So termos especificos: "cola" solto pegaria "Coca-Cola".
const LOJAS_MATERIAL = ["ferragem", "ferragens", "material de construcao", "materiais de construcao", "casa do construtor", "home center",
    "madeireira", "materiais eletricos", "material eletrico", "hidraulica", "tintas", "parafusos", "loja de ferramentas"];
const ITENS_MATERIAL = ["parafuso", "parafusos", "porca sextavada", "arruela", "cola contato", "cascola", "super cola", "fita isolante", "fita crepe",
    "abracadeira", "lampada", "pincel", "broca", "alicate", "martelo", "trena", "silicone", "cimento", "prego", "dobradica", "cadeado"];

function ehMaterialDeCampo(estabelecimento, itens) {
    if (LOJAS_MATERIAL.some((termo) => contemTermo(estabelecimento, termo))) return true;
    return ITENS_MATERIAL.some((termo) => contemTermo(itens, termo));
}

function textoDoEstabelecimento(ocr) {
    return [ocr?.fornecedor, ocr?.nome_fantasia].filter(Boolean).join(" ");
}

/** Refeicao pelo horario so quando o horario e claro (longe das fronteiras entre refeicoes). */
function refeicaoClaraPeloHorario(hora) {
    const achado = String(hora || "").match(/^(\d{1,2}):(\d{2})/);
    if (!achado) return null;
    const minutos = Number(achado[1]) * 60 + Number(achado[2]);
    if (minutos >= 330 && minutos < 600) return "CAFE_DA_MANHA";  // 05h30-10h
    if (minutos >= 660 && minutos < 870) return "ALMOCO";          // 11h-14h30
    if (minutos >= 1110 || minutos < 120) return "JANTAR";         // 18h30-02h
    return null;
}

/** Pista de horario: 05h-10h29 cafe, 10h30-15h29 almoco, 15h30-17h59 lanche, resto jantar. */
function refeicaoPeloHorario(hora) {
    const achado = String(hora || "").match(/^(\d{1,2}):(\d{2})/);
    if (!achado) return null;
    const minutos = Number(achado[1]) * 60 + Number(achado[2]);
    if (minutos >= 300 && minutos < 630) return "CAFE_DA_MANHA";
    if (minutos >= 630 && minutos < 930) return "ALMOCO";
    if (minutos >= 930 && minutos < 1080) return "LANCHE";
    return "JANTAR";
}

/**
 * Decide o tipo com evidencias. Retorna { tipo, origem, pendencia? }.
 * Legenda da propria foto > tipo unico do lote > nota (itens, estabelecimento) > horario (pista).
 */
/** O que a propria nota diz sobre o tipo (null quando ela nao da evidencia). */
function tipoPelaNota(ocr) {
    const estabelecimento = textoDoEstabelecimento(ocr);
    const itens = [(ocr?.itens || []).map((item) => item.descricao).join(" "), ocr?.produto_principal].join(" ");
    const temLitros = Number(ocr?.litragem) > 0;
    // Sem itens estruturados (ex.: nota separada de uma foto com duas), o texto
    // tambem vale: combustivel citado + sinal de posto (nome, bico, bomba, litros).
    const texto = String(ocr?.texto_bruto || "");
    const combustivelNoTexto = COMBUSTIVEIS.some((termo) => contemTermo(texto, termo))
        && (contemTermo(estabelecimento, "posto") || contemTermo(texto, "posto") || /\b(bico|bomba|abastec\w*)\b/i.test(texto) || temLitros);
    // A nota e analisada por INTEIRO: com itens lidos, so e abastecimento se algum
    // item for combustivel. "Posto" no nome e "1LT" do suco nao bastam (#127).
    const itensLidos = (ocr?.itens || []).filter((item) => item.descricao);
    const itemDeCombustivel = itensLidos.some((item) => COMBUSTIVEIS.some((termo) => contemTermo(item.descricao, termo)));
    if (itensLidos.length && !itemDeCombustivel) {
        const comida = itensLidos.filter((item) => ITENS_DE_COMIDA.some((termo) => contemTermo(item.descricao, termo)));
        if (comida.length && comida.length >= itensLidos.length / 2 && !itensSoDeAgua(ocr)) return { tipo: "REFEICAO", origem: "itens_da_nota" };
    } else if (itemDeCombustivel || COMBUSTIVEIS.some((termo) => contemTermo(ocr?.produto_principal || "", termo))
        || (!itensLidos.length && ((temLitros && contemTermo(estabelecimento, "posto")) || ocr?.tipo_despesa_sugerido === "combustivel" || combustivelNoTexto))) {
        return { tipo: "ABASTECIMENTO", origem: "itens_da_nota" };
    }
    if (HOTEIS.some((termo) => contemTermo(estabelecimento, termo)) || contemTermo(itens, "diaria")) {
        return { tipo: "HOSPEDAGEM", origem: "estabelecimento_da_nota" };
    }
    // NFS-e/recibo de hotel: o servico prestado diz que e hospedagem, mesmo que
    // o Azure tenha classificado como refeicao.
    if (/hospedagem\s+de\s+qualquer|\bdi[aá]rias?\b|qtd[_ .]*h[oó]spede|h[oó]spede\s+principal|\bcheck[\s-]?in\b/i.test(String(ocr?.texto_bruto || ""))) {
        return { tipo: "HOSPEDAGEM", origem: "texto_da_nota" };
    }
    if (contemTermo(estabelecimento, "pedagio") || contemTermo(ocr?.texto_bruto, "praca de pedagio") || CONCESSIONARIAS.test(normalizar(estabelecimento))) {
        return { tipo: "PEDAGIO", origem: "estabelecimento_da_nota" };
    }
    if (contemTermo(estabelecimento, "estacionamento")) return { tipo: "ESTACIONAMENTO", origem: "estabelecimento_da_nota" };
    // Loja de ferragens / material de construcao: antes de "refeicao", porque o
    // Azure as vezes classifica qualquer nota de varejo como refeicao.
    if (ehMaterialDeCampo(estabelecimento, itens)) return { tipo: "OUTROS", origem: "material_de_campo", material: true };
    // Oficina pelo nome so se nao for posto ("Auto Posto e Auto Center", "Lubrificantes" sao postos).
    if (OFICINAS.some((termo) => contemTermo(estabelecimento, termo)) && !contemTermo(estabelecimento, "posto")) return { tipo: "MANUTENCAO", origem: "nome_do_estabelecimento" };
    if (itensSoDeAgua(ocr)) return { tipo: "AGUA", origem: "itens_da_nota" };
    if (RESTAURANTES.some((termo) => contemTermo(estabelecimento, termo))) return { tipo: "REFEICAO", origem: "estabelecimento_da_nota" };
    // So o "tipo de recibo" do Azure dizendo refeicao: pista fraca (perde para a legenda).
    if (ocr?.tipo_despesa_sugerido === "alimentacao") {
        return { tipo: "REFEICAO", origem: "sugestao_azure" };
    }
    if (MERCADOS.some((termo) => contemTermo(estabelecimento, termo))) return { tipo: "MERCADO", origem: "estabelecimento_da_nota" };
    return null;
}

/** Cafe/almoco/jantar/lanche: horario e so pista, confirmado quando o lote cita aquela refeicao. */
function subtipoRefeicao(ocr, lote, origemBase) {
    const tiposLote = new Set((lote?.quantidades?.refeicoes_e_tipos || []).map((item) => item.tipo));
    const pelaHora = refeicaoPeloHorario(ocr?.hora);
    if (pelaHora && tiposLote.has(pelaHora)) return { tipo: pelaHora, origem: "horario_da_nota_confirmado_pelo_lote" };
    if (pelaHora) {
        return {
            tipo: pelaHora, origem: "horario_da_nota_pista",
            pendencia: `Refeição inferida apenas pelo horário da nota (${ocr.hora}); confirme se é ${TIPOS[pelaHora].rotulo}.`,
        };
    }
    return { tipo: "LANCHE", origem: origemBase, pendencia: "Refeição sem horário legível; confirme se é café, almoço, jantar ou lanche." };
}

const ehRefeicao = (tipo) => tipo === "REFEICAO" || Boolean(TIPOS[tipo]?.refeicao);

function decidirTipo({ ocr, legenda, lote }) {
    const daNota = tipoPelaNota(ocr);
    const tiposLegenda = legenda?.tipos || [];
    const daLegenda = tiposLegenda.length === 1 ? tiposLegenda[0] : null;

    if (daLegenda) {
        // Legenda e nota discordando de "grupo" (refeicao x posto, por ex.): vale a nota, com revisao.
        const conflito = daNota && !["sugestao_azure", "nome_do_estabelecimento"].includes(daNota.origem) && daNota.tipo !== daLegenda && !(ehRefeicao(daNota.tipo) && ehRefeicao(daLegenda));
        if (conflito) {
            const decisao = daNota.tipo === "REFEICAO" ? subtipoRefeicao(ocr, lote, daNota.origem) : daNota;
            return { ...decisao, pendencia: `A mensagem diz ${daLegenda.toLowerCase()}, mas a nota indica ${daNota.tipo.toLowerCase()}; confirme o tipo.` };
        }
        if (daLegenda === "REFEICAO") return subtipoRefeicao(ocr, lote, "legenda_da_foto");
        // Refeicao: a NOTA manda. Legenda "Jantar" numa nota das 12:40 e almoco (#132).
        if (["ALMOCO", "JANTAR", "CAFE_DA_MANHA", "LANCHE"].includes(daLegenda) && ocr?.hora) {
            const pelaHora = refeicaoClaraPeloHorario(ocr.hora);
            if (pelaHora && pelaHora !== daLegenda) {
                return { tipo: pelaHora, origem: "horario_da_nota", aviso: `Mensagem diz ${TIPOS[daLegenda].rotulo.toLowerCase()}, mas a nota é das ${String(ocr.hora).slice(0, 5)}: lançado como ${TIPOS[pelaHora].rotulo.toLowerCase()} (vale a nota).` };
            }
        }
        return { tipo: daLegenda, origem: "legenda_da_foto" };
    }
    if (daNota?.origem === "sugestao_azure" && (legenda?.observacoes || []).length) return { tipo: "OUTROS", origem: "legenda_da_foto" };
    if (daNota) return daNota.tipo === "REFEICAO" ? subtipoRefeicao(ocr, lote, daNota.origem) : daNota;

    // Lote com um unico tipo citado ("Abastecimento") vale como pista fraca.
    const tiposLote = [...new Set([...(lote?.quantidades?.tipos || []), ...(lote?.quantidades?.refeicoes_e_tipos || []).map((item) => item.tipo)])];
    if (tiposLote.length === 1) {
        const pendencia = "Tipo vindo só do cabeçalho do lote; a nota não confirmou.";
        if (tiposLote[0] === "REFEICAO") return { ...subtipoRefeicao(ocr, lote, "lote_do_dia"), pendencia };
        return { tipo: tiposLote[0], origem: "lote_do_dia", pendencia };
    }
    return { tipo: "OUTROS", origem: null, pendencia: "Não foi possível identificar o tipo da despesa pela nota nem pela mensagem." };
}

// ---------------------------------------------------------------------------
// Pessoas nas refeicoes
// ---------------------------------------------------------------------------

// Itens que nao dizem nada sobre quantas pessoas comeram.
const NAO_E_PRATO = /\b(taxa|servico|gorjeta|couvert|embalagem|sacola|gelo|desconto|acrescimo)\b/i;

/**
 * Pessoas estimadas pela NOTA (so pista, nunca confirma sozinho):
 *   - hospedagem: "QTD_HOSPEDE: 2", "hospedes: 2";
 *   - refeicao: a MAIOR quantidade de um mesmo item (3 hamburgueres = 3
 *     pessoas; 4 coxinhas + 4 cafes = 4 pessoas). Somar os itens
 *     superestima: cada pessoa costuma pedir comida E bebida.
 */
function pessoasPelaNota(ocr, tipo) {
    const texto = String(ocr?.texto_bruto || "");
    if (tipo === "HOSPEDAGEM") {
        const achado = texto.match(/\b(?:qtd[_ .]*h[oó]spedes?|h[oó]spedes?|n[ºo°]?\s*de\s*h[oó]spedes)\s*[:\-]?\s*(\d{1,2})\b/i);
        return achado && Number(achado[1]) > 0 ? { valor: Number(achado[1]), origem: "hospedes_na_nota" } : null;
    }
    const pratos = (ocr?.itens || []).filter((item) => item.descricao && !NAO_E_PRATO.test(normalizar(item.descricao)));
    if (!pratos.length) return null;
    // Linhas iguais somam (3 linhas de "PRATO FEITO" = 3 pratos).
    const porItem = new Map();
    for (const item of pratos) {
        const quantidade = Number(item.quantidade);
        // Quantidade fracionada (kg de self-service) nao conta pessoa: vale 1.
        const conta = Number.isInteger(quantidade) && quantidade > 0 && quantidade <= 20 ? quantidade : 1;
        const chave = normalizar(item.descricao);
        porItem.set(chave, (porItem.get(chave) || 0) + conta);
    }
    const [itemMaior, maior] = [...porItem.entries()].sort((x, y) => y[1] - x[1])[0];
    // Prato principal contado (prato feito, marmita, executivo...): evidencia forte da nota.
    const ehPrato = PRATOS_PRINCIPAIS.some((termo) => contemTermo(itemMaior, termo));
    return maior >= 1 ? { valor: Math.min(maior, 20), origem: ehPrato && maior >= 2 ? "pratos_da_nota" : "itens_da_nota" } : null;
}

function decidirPessoas({ tipo, legenda, lote, ocr = null, habitos = null, recentes = null }) {
    if (legenda?.pessoas?.quantidade) return { valor: legenda.pessoas.quantidade, origem: "mensagem_da_foto", confirmado: true };
    const declarado = lote?.quantidades?.pessoas;
    if (declarado?.quantidade && (!declarado.tipo || declarado.tipo === tipo)) {
        return { valor: declarado.quantidade, origem: "cabecalho_do_lote", confirmado: true };
    }
    const qtdLote = (lote?.quantidades?.refeicoes_e_tipos || []).find((item) => item.tipo === tipo);
    if (qtdLote?.semantica === "PESSOAS") {
        // "Qtd 3 almoço" = 3 pessoas (padrao combinado com os operadores).
        return { valor: qtdLote.quantidade, origem: "cabecalho_do_lote", confirmado: true };
    }
    if (qtdLote) {
        // Mensagens antigas (antes do padrao): pode ser pessoas ou notas, a confirmar.
        return { valor: qtdLote.quantidade, origem: "quantidade_do_lote_semantica_indeterminada", confirmado: false };
    }
    // Pratos principais contados na propria nota valem mais que o padrao dos dias (#127).
    const contados = pessoasPelaNota(ocr, tipo);
    if (contados?.origem === "pratos_da_nota") return { ...contados, confirmado: false };
    // Padrao do proprio operador nos ultimos dias: o que ele disse no mesmo
    // dia vale como informado; de dias anteriores, so estimativa.
    if (recentes?.valor) {
        return recentes.mesmo_dia
            ? { valor: recentes.valor, origem: "pessoas_do_mesmo_dia", confirmado: true, referencia: recentes.despesa_id }
            : { valor: recentes.valor, origem: "pessoas_de_dias_anteriores", confirmado: false, data_referencia: recentes.data, referencia: recentes.despesa_id };
    }
    // Habito do operador (ex.: o Lorran viaja sozinho: todas as refeicoes
    // aprovadas sao de 1 pessoa). Vale mais que contar itens da nota, que
    // confunde "2 itens" com "2 pessoas". Sempre estimativa a confirmar.
    const habito = habitos?.pessoas?.[tipo === "HOSPEDAGEM" ? "hospedagem" : "refeicao"];
    if (habito?.valor) return { valor: habito.valor, origem: "habito_do_operador", confirmado: false, amostras: habito.amostras };
    const pelaNota = pessoasPelaNota(ocr, tipo);
    if (pelaNota) return { ...pelaNota, confirmado: false };
    // Hospedagem sem nada informado: diaria de ate R$ 350 e, na pratica da
    // VMac, de 1 pessoa (observacao da revisao de 12/10). So estimativa.
    if (tipo === "HOSPEDAGEM" && Number(ocr?.valor) > 0 && Number(ocr.valor) <= LIMITE_DIARIA_UMA_PESSOA) {
        return { valor: 1, origem: "valor_da_diaria", confirmado: false };
    }
    return { valor: null, origem: null, confirmado: false };
}

const LIMITE_DIARIA_UMA_PESSOA = 350;

// ---------------------------------------------------------------------------
// Montagem da previa
// ---------------------------------------------------------------------------

/**
 * @param {object} entrada
 * @param {object|null} entrada.ocr — documento lido (null = despesa sem comprovante)
 * @param {object} entrada.legenda — dados interpretados da legenda/mensagem da foto
 * @param {object} entrada.contexto — { lote, projeto } de contexto.contextoPara
 * @param {object|null} entrada.politica — politica de cartao vigente do projeto
 * @param {object} entrada.identificacao — resultado de cadastros.identificarPessoa
 * @param {object} entrada.cad — cadastros
 * @param {object} [entrada.regras] — regras.json (confianca_minima)
 * @param {Date} [entrada.hoje]
 */
/** O valor aparece impresso no texto da nota? ("81,88", "81.88", "R$81,88") */
function valorImpressoNaNota(texto, valor) {
    if (!texto || !(Number(valor) > 0)) return false;
    const [inteiro, decimal] = Number(valor).toFixed(2).split(".");
    const milhar = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const formas = new Set([`${inteiro},${decimal}`, `${inteiro}.${decimal}`, `${milhar},${decimal}`]);
    return [...formas].some((forma) => new RegExp(`(?<![\\d,.])${forma.replace(/\./g, "\\.")}(?![\\d])`).test(String(texto)));
}

/**
 * Litros com separador de milhar lido como numero inteiro ("61618" = 61,618 L).
 * Corrige so quando o preco por litro resultante e de combustivel (R$ 3 a 12).
 */
function corrigirLitros(litros, valor) {
    if (!(litros > 300)) return { litros, corrigido: false };
    for (const divisor of [1000, 100]) {
        const candidato = Math.round((litros / divisor) * 1000) / 1000;
        const preco = valor ? valor / candidato : null;
        if (candidato >= 1 && candidato <= 300 && (!preco || (preco >= 3 && preco <= 12))) return { litros: candidato, corrigido: true };
    }
    return { litros, corrigido: false };
}

function montarPrevia({ ocr = null, legenda = {}, contexto = {}, politica = null, identificacao = {}, cad, regras = {}, hoje = new Date(), modelo, habitos = null, pessoasRecentes = null }) {
    const pendencias = [];
    const avisos = [];
    const campos = {};
    const pessoa = identificacao.pessoa || null;
    const lote = contexto.lote || null;

    // Remetente
    campos.remetente = { valor: pessoa?.nome || null, pessoa_id: pessoa?.id || null, origem: identificacao.origem || null };
    if (!pessoa) {
        pendencias.push(`Remetente não vinculado ao cadastro de pessoas${identificacao.sugestao ? ` (parece ser ${identificacao.sugestao.nome})` : ""}.`);
    } else if (!pessoa.pasta_drive) {
        pendencias.push(`${pessoa.nome} não tem pasta individual no Drive; defina o destino do comprovante.`);
    }

    // Comprovante
    if (!ocr) {
        pendencias.push("SEM COMPROVANTE: o operador informou a despesa sem a nota. Lançamento só com justificativa aprovada.");
    }
    campos.sem_comprovante = { valor: !ocr };

    // Data: sempre a da nota
    const dataNota = ocr?.data || null;
    campos.data_competencia = { valor: dataNota, origem: dataNota ? "nota" : null };
    if (!dataNota) {
        pendencias.push(ocr ? "Data da compra não foi lida na nota." : "Data da compra sem comprovante para confirmar.");
        if (legenda?.data_declarada) campos.data_competencia.sugestao = { valor: legenda.data_declarada, origem: "mensagem" };
    } else {
        const limite = new Date(hoje.getTime() + 2 * 86400000).toISOString().slice(0, 10);
        if (dataNota > limite) pendencias.push(`Data lida (${dataNota}) está no futuro; provável erro de leitura.`);
        const declarada = legenda?.data_declarada || lote?.data_declarada;
        if (declarada && declarada !== dataNota) avisos.push(`Data da nota (${dataNota}) difere da data da mensagem (${declarada}); vale a da nota.`);
    }

    // Valor: sempre o da nota. Quando a mensagem diz outro valor, confere se
    // ESSE valor tambem esta impresso na nota (o OCR pegou o subtotal, ou leu
    // "58,00" como 5800): ai vale o valor impresso que bate com a mensagem.
    let valorNota = Number(ocr?.valor) > 0 ? Number(ocr.valor) : null;
    let origemValor = valorNota ? "nota" : null;
    const declarado = legenda?.valor_declarado ?? null;
    if (valorNota && declarado && centavos(declarado) !== centavos(valorNota)) {
        const impresso = valorImpressoNaNota(ocr?.texto_bruto, declarado);
        const semVirgula = centavos(valorNota) === centavos(declarado * 100);
        if (impresso || semVirgula) {
            avisos.push(`Valor lido R$ ${valorNota.toFixed(2)} trocado por R$ ${declarado.toFixed(2)}: é o valor da mensagem e ele ${semVirgula ? "é o mesmo número com a vírgula perdida na leitura" : "também está impresso na nota"}.`);
            valorNota = declarado;
            origemValor = "nota_confirmada_pela_mensagem";
        } else {
            pendencias.push(`Valor da nota (R$ ${valorNota.toFixed(2)}) difere do valor da mensagem (R$ ${declarado.toFixed(2)}), que não aparece na nota; confirme.`);
        }
    }
    campos.valor = { valor: valorNota, origem: origemValor };
    if (!valorNota) {
        pendencias.push(ocr ? "Valor total não foi lido com segurança na nota." : "Valor sem comprovante para confirmar.");
        if (declarado) campos.valor.sugestao = { valor: declarado, origem: "mensagem" };
    }
    const minimo = Number(regras.confianca_minima || 0);
    if (ocr && minimo && Number(ocr.confianca || 0) < minimo) {
        pendencias.push(`Leitura com confiança baixa (${Math.round(Number(ocr.confianca || 0) * 100)}%); confira valor e data na imagem.`);
    }

    // Tipo
    const decisaoTipo = ocr
        ? decidirTipo({ ocr, legenda, lote })
        : { tipo: (legenda?.tipos || [])[0] || "OUTROS", origem: legenda?.tipos?.length ? "mensagem" : null };
    if (decisaoTipo.pendencia) pendencias.push(decisaoTipo.pendencia);
    if (decisaoTipo.aviso) avisos.push(decisaoTipo.aviso);
    let tipo = decisaoTipo.tipo;
    // "Material - parafusos" na legenda: material de campo, salvo tipos que a
    // nota identifica sem duvida (posto, hotel, pedagio, estacionamento).
    if (legenda?.material && !TIPOS_COM_NOTA_PROPRIA.includes(tipo)) {
        tipo = "OUTROS";
        decisaoTipo.origem = "mensagem_da_foto";
        decisaoTipo.material = true;
    }
    campos.tipo = { valor: tipo, origem: decisaoTipo.origem };
    if (ocr?.hora) campos.hora_da_nota = { valor: ocr.hora, origem: "nota", uso: "somente_pista" };

    // Fornecedor
    // Material de campo (ferragens, parafuso, cola de contato...): fornecedor generico "Materiais de Campo".
    const itensDaNota = (ocr?.itens || []).map((item) => item.descricao).filter(Boolean);
    const material = tipo === "OUTROS" && (decisaoTipo.material || legenda?.material || ehMaterialDeCampo(textoDoEstabelecimento(ocr), itensDaNota.join(" ")));
    // Agua: o fornecedor e o do lugar onde foi comprada (restaurante, mercado, posto).
    // Refeicao em padaria -> PADARIA; em mercado -> fornecedor do mercado (SUPERMERCADO), como o Conta Azul faz.
    const estabelecimentoDaNota = textoDoEstabelecimento(ocr);
    const refeicaoEm = TIPOS[tipo]?.refeicao
        ? (["padaria", "panificadora", "panificacao", "confeitaria"].some((t) => contemTermo(estabelecimentoDaNota, t)) ? "PADARIA"
            : MERCADOS.some((t) => contemTermo(estabelecimentoDaNota, t)) ? null : tipo)
        : tipo;
    const tipoDoFornecedor = material ? "MATERIAL_DE_CAMPO" : tipo === "AGUA" ? tipoDoEstabelecimento(ocr) : refeicaoEm;
    const fornecedor = cadastros.resolverFornecedor(cad, ocr?.fornecedor || ocr?.nome_fantasia, tipoDoFornecedor);
    campos.fornecedor = { valor: fornecedor.nome, origem: fornecedor.origem, nome_lido: fornecedor.nome_lido || ocr?.fornecedor || null, cnpj_lido: ocr?.cnpj || null };
    if (ocr && !fornecedor.nome) pendencias.push("Fornecedor não foi lido na nota.");

    // Avisos da leitura que a pessoa precisa conferir.
    if (ocr?.separada_da_foto) {
        pendencias.push(`Foto com ${ocr.separada_da_foto.total} notas lado a lado: esta é a da ${ocr.separada_da_foto.coluna}. Confira os campos com a imagem.`);
    }
    if (ocr?.data_lida_descartada) avisos.push(`Data ${ocr.data_lida_descartada} lida no futuro foi descartada; usada ${ocr.data}, que também aparece na nota.`);

    // Abastecimento
    const regrasPessoa = pessoa?.regras_especiais || [];
    let categoria = null;
    let descricao = null;
    let descricaoAnexo = null;
    let centroDaRegra = null;
    let sugestaoCategoria = null;
    if (tipo === "ABASTECIMENTO") {
        // A nota e a fonte principal; o que o operador digitou so completa o que faltou.
        const daNotaOuMensagem = (daNota, daMensagem) => (daNota ? { valor: daNota, origem: "nota" }
            : daMensagem ? { valor: daMensagem, origem: "mensagem_do_operador" } : { valor: null, origem: null });
        const placaInfo = daNotaOuMensagem(ocr?.placa, legenda?.placa);
        const litrosInfo = daNotaOuMensagem(Number(ocr?.litragem) > 0 ? Number(ocr.litragem) : null, Number(legenda?.litros) > 0 ? Number(legenda.litros) : null);
        const odometroInfo = daNotaOuMensagem(Number(ocr?.odometro) > 0 ? Number(ocr.odometro) : null, Number(legenda?.odometro) > 0 ? Number(legenda.odometro) : null);
        for (const [nome, info] of [["Placa", placaInfo], ["Litros", litrosInfo], ["Hodômetro", odometroInfo]]) {
            if (info.origem === "mensagem_do_operador") avisos.push(`${nome} não lido na nota; usado o valor digitado pelo operador.`);
        }
        const placaLida = placaInfo.valor;
        let veiculo = placaLida ? cadastros.resolverVeiculo(cad, placaLida) : null;
        // "SGR4854" lida = SGR4B54 da frota (8 no lugar de B): so troca de caractere parecido e um unico veiculo.
        if (!veiculo && placaLida) {
            const sosia = cadastros.veiculoPorSosia(cad, placaLida);
            if (sosia) {
                veiculo = sosia.veiculo;
                avisos.push(`Placa lida como "${sosia.lida}" corresponde a ${cadastros.placaCanonica(veiculo.placa)} da frota (troca de caractere parecido na leitura).`);
            }
        }
        // Litros com o separador de milhar perdido ("61618" = 61,618 L), conferido pelo preco por litro.
        if (!litrosInfo.valor && valorNota) {
            const calculado = litrosPelaConta(ocr?.texto_bruto, valorNota);
            if (calculado) {
                litrosInfo.valor = calculado.litros;
                litrosInfo.origem = calculado.origem;
                if (calculado.origem === "conta_litros_x_preco") avisos.push(`Litros calculados pela conta: ${litrosBr(calculado.litros)} L × R$ ${String(calculado.preco).replace(".", ",")} = valor da nota (unidade ilegível na leitura).`);
                else pendencias.push(`Litros não lidos; calculados como valor ÷ preço (R$ ${String(calculado.preco).replace(".", ",")}) = ${litrosBr(calculado.litros)} L. Confirme.`);
            }
        }
        const ajusteLitros = corrigirLitros(litrosInfo.valor, valorNota);
        if (ajusteLitros.corrigido) {
            avisos.push(`Litros lidos como ${litrosInfo.valor} corrigidos para ${litrosBr(ajusteLitros.litros)} L (separador perdido na leitura; preço por litro confere).`);
            litrosInfo.valor = ajusteLitros.litros;
        }
        const litros = litrosInfo.valor;
        const odometro = odometroInfo.valor;
        campos.abastecimento = {
            litros: litrosInfo,
            odometro: { ...odometroInfo, leitura: ocr?.odometro_origem || null },
            placa: { valor: veiculo ? cadastros.placaCanonica(veiculo.placa) : (placaLida ? cadastros.placaCanonica(placaLida) : null), origem: placaInfo.origem },
            combustivel: ocr?.produto_principal || null,
            preco_litro: (ocr?.itens || []).find((item) => Number(item.valor_unitario) > 0)?.valor_unitario ?? null,
        };
        if (placaInfo.origem === "nota" && ocr?.placa_corrigida) {
            avisos.push(`Placa impressa lida como "${ocr.placa_bruta}" e corrigida para ${cadastros.placaCanonica(placaLida)} (troca comum do OCR).`);
        }
        if (odometroInfo.origem === "nota" && ocr?.odometro_origem === "numero_ao_lado_da_placa") {
            pendencias.push(`Hodômetro ${milharBr(odometro)} lido sem rótulo, no número ao lado da placa; confirme.`);
        }
        // Placa ilegivel: compara com a frota e SUGERE (nunca decide sozinho).
        if (!placaLida && ocr?.placa_bruta) {
            const parecido = cadastros.veiculoAproximado(cad, ocr.placa_bruta);
            if (parecido) {
                campos.abastecimento.placa.sugestao = { valor: cadastros.placaCanonica(parecido.veiculo.placa), origem: "frota_por_semelhanca" };
                sugestaoCategoria = { nome: parecido.veiculo.categoria_nome_conta_azul, origem: "frota_por_semelhanca" };
                pendencias.push(`Placa ilegível ("${ocr.placa_bruta}"); parece ${cadastros.placaCanonica(parecido.veiculo.placa)} (${parecido.veiculo.nome}). Confirme.`);
            } else {
                pendencias.push(`Placa ilegível na nota ("${ocr.placa_bruta}").`);
            }
        }
        // Sem hodometro na nota nao trava: a descricao sai sem o numero (orientacao do Yan, 18/10/2026).
        if (!odometro && litros && (placaLida || ocr?.placa_bruta)) avisos.push("Nota sem hodômetro: descrição sem o número do odômetro (ex.: 45,34L od - OVN1505).");
        const faltando = [!litros && "litros", !odometro && !litros && "hodômetro", !placaLida && !ocr?.placa_bruta && "placa"].filter(Boolean);
        if (faltando.length) pendencias.push(`Abastecimento sem ${faltando.join(", ")} legível na nota; fica pendente até conferência.`);

        const motoParticular = regrasPessoa.find((regra) => regra.tipo === "ABASTECIMENTO_MOTO_PARTICULAR");
        const mencionaMoto = contemTermo([legenda?.observacoes, legenda?.texto].flat().join(" "), "moto");
        if (motoParticular && mencionaMoto) {
            categoria = categoriaLivre(cad, motoParticular.categoria_nome, motoParticular.categoria_id);
            descricaoAnexo = motoParticular.descricao_anexo;
            if (motoParticular.centro_custo) centroDaRegra = motoParticular.centro_custo;
            avisos.push("Regra especial: abastecimento de moto particular (despesa administrativa).");
        } else if (veiculo) {
            const idValido = veiculo.categoria_id && !String(veiculo.categoria_id).startsWith("PREENCHER_");
            categoria = { nome: veiculo.categoria_nome_conta_azul, id: idValido ? veiculo.categoria_id : null, origem: "placa_da_frota" };
            if (!veiculo.categoria_nome_conta_azul) pendencias.push(`Veículo ${veiculo.placa} sem categoria definida no Conta Azul.`);
        } else if (placaLida) {
            pendencias.push(`Placa ${cadastros.placaCanonica(placaLida)} não está na frota cadastrada (alugado? particular?).`);
            sugestaoCategoria = { nome: "VEICULO - ALUGADO", origem: "placa_fora_da_frota" };
        }
        campos.placa_veiculo = { valor: veiculo?.nome || null };
        descricao = { valor: descricaoAbastecimento({ litros, odometro, placa: campos.abastecimento.placa.valor }), origem: "template_abastecimento" };
    } else if (TIPOS[tipo]?.refeicao || tipo === "HOSPEDAGEM") {
        // Refeicao e hospedagem: descricao "JANTAR - 3 PESSOAS" / "HOSPEDAGEM - 1 PESSOA".
        const recentes = pessoasRecentes ? pessoasRecentes(tipo, ocr?.data || legenda?.data_declarada || lote?.data_declarada || null) : null;
        const pessoas = decidirPessoas({ tipo, legenda, lote, ocr, habitos, recentes });
        campos.pessoas = pessoas;
        if (!pessoas.valor) pendencias.push(`Quantidade de pessoas ${tipo === "HOSPEDAGEM" ? "hospedadas" : "da refeição"} não informada.`);
        else if (pessoas.origem === "pessoas_do_mesmo_dia") {
            avisos.push(`Pessoas não informadas nesta foto; ${pessoas.valor} como nas outras notas do dia.`);
        } else if (pessoas.origem === "pessoas_de_dias_anteriores") {
            pendencias.push(`Pessoas não informadas; estimado ${pessoas.valor} como na nota de ${pessoas.data_referencia.split("-").reverse().slice(0, 2).join("/")}. Confirme.`);
        } else if (pessoas.origem === "habito_do_operador") {
            pendencias.push(`Pessoas não informadas; estimado ${pessoas.valor} pelo costume de ${pessoa?.nome || "deste operador"} (${pessoas.amostras} notas aprovadas). Confirme.`);
        } else if (pessoas.origem === "itens_da_nota" || pessoas.origem === "pratos_da_nota") {
            pendencias.push(`${pessoas.valor} ${pessoas.valor === 1 ? "pessoa estimada" : "pessoas estimadas"} pelos itens da nota; confirme.`);
        } else if (pessoas.origem === "valor_da_diaria") {
            pendencias.push(`Pessoas não informadas; estimada 1 pelo valor da diária (até R$ ${LIMITE_DIARIA_UMA_PESSOA}). Confirme.`);
        } else if (pessoas.origem === "hospedes_na_nota") {
            pendencias.push(`${pessoas.valor} hóspede(s) segundo a nota; confirme.`);
        } else if (!pessoas.confirmado) {
            pendencias.push(`"Qtd ${pessoas.valor}" no lote pode ser pessoas ou notas; confirme quantas pessoas.`);
        }
        descricao = { valor: descricaoRefeicao(tipo, pessoas.valor), origem: "template_refeicao", estimada: !pessoas.confirmado };
    } else if (tipo === "MERCADO") {
        pendencias.push("Compra em mercado: defina se é despesa de campo ou administrativa (categoria).");
    } else if (tipo === "MANUTENCAO") {
        // Placa digitada ou lida na nota: categoria de manutencao DAQUELE veiculo.
        const placa = legenda?.placa || ocr?.placa || null;
        const veiculo = placa ? cadastros.resolverVeiculo(cad, placa) : null;
        if (veiculo?.manutencao_categoria_nome) {
            const idValido = veiculo.manutencao_categoria_id && !String(veiculo.manutencao_categoria_id).startsWith("PREENCHER_");
            categoria = { nome: veiculo.manutencao_categoria_nome, id: idValido ? veiculo.manutencao_categoria_id : null, origem: "placa_da_frota" };
            campos.placa_veiculo = { valor: veiculo.nome };
        } else {
            pendencias.push("Manutenção sem placa do veículo: informe a placa para usar a categoria de manutenção dele.");
        }
        const peca = (legenda?.observacoes || [])[0] || (ocr?.itens || []).map((item) => item.descricao).filter(Boolean)[0];
        if (peca) descricao = { valor: String(peca).replace(/\s+/g, " ").trim().toUpperCase(), origem: legenda?.observacoes?.length ? "mensagem_da_foto" : "itens_da_nota" };
    }

    if (tipo === "AGUA") {
        const quantidade = Number(legenda?.quantidade_agua) || quantidadeDeAgua(ocr);
        if (!descricao) descricao = { valor: quantidade ? `ÁGUA - ${quantidade} ${quantidade === 1 ? "UNIDADE" : "UNIDADES"}` : "ÁGUA", origem: "template_agua" };
    }
    // Gerador: "gerador" na mensagem, ou ate 12 L sem placa e sem hodometro
    // (gerador nao tem placa nem hodometro; orientacao do Yan, 16/10/2026).
    if (tipo === "ABASTECIMENTO" && campos.abastecimento && categoria?.origem !== "regra_especial") {
        const ab = campos.abastecimento;
        const ditoGerador = Boolean(legenda?.gerador) || contemTermo([legenda?.texto, ...(legenda?.observacoes || []), ...(lote?.observacoes || [])].join(" "), "gerador");
        const litrosDeGerador = Number(ab.litros?.valor) > 0 && Number(ab.litros.valor) <= LITROS_MAXIMO_GERADOR && !ab.placa?.valor && !ab.odometro?.valor;
        if (ditoGerador || litrosDeGerador) {
            const gerador = categoriaLivre(cad, "GERADOR");
            categoria = { nome: gerador.nome || "GERADOR", id: gerador.id, origem: ditoGerador ? "mensagem_da_foto" : "litros_de_gerador" };
            sugestaoCategoria = null;
            descricao = { valor: ab.litros?.valor ? `GERADOR - ${litrosBr(ab.litros.valor)}L` : "GERADOR", origem: "template_gerador" };
            campos.placa_veiculo = { valor: null };
            for (let i = pendencias.length - 1; i >= 0; i -= 1) if (/^(Abastecimento sem|Placa|Veículo|Hodômetro)/.test(pendencias[i])) pendencias.splice(i, 1);
            if (!ditoGerador) avisos.push(`${litrosBr(ab.litros.valor)} L sem placa e sem hodômetro: classificado como gerador.`);
        }
    }
    if (!categoria && material) {
        const encontrada = cadastros.categoriaPorNome(cad, "MATERIAL DE CAMPO");
        categoria = encontrada ? { ...encontrada, origem: "material_de_campo" } : null;
    }
    if (!categoria && TIPOS[tipo]?.categoria) {
        const encontrada = cadastros.categoriaPorNome(cad, TIPOS[tipo].categoria);
        categoria = encontrada ? { ...encontrada, origem: "regra_do_tipo" } : null;
    }
    campos.categoria = categoria || { nome: null, id: null, origem: null };
    if (!categoria?.nome) {
        // Sem regra: o modelo da planilha so SUGERE; a pessoa decide na revisao.
        const textoSugestao = [ocr?.fornecedor, ...(ocr?.itens || []).map((item) => item.descricao), ...(legenda?.observacoes || []), legenda?.texto]
            .filter(Boolean).join(" ");
        const sugestao = sugestaoCategoria || modeloCentral.sugerirCategoria(textoSugestao, modelo === undefined ? {} : { modelo });
        if (sugestao) campos.categoria.sugestao = sugestao;
        const dica = sugestao ? ` Sugestão: "${sugestao.nome}"${sugestao.confianca ? ` (${Math.round(sugestao.confianca * 100)}% de confiança)` : ""}.` : "";
        if (tipo !== "MERCADO") pendencias.push(`Categoria não definida para esta despesa.${dica}`);
        else if (dica) avisos.push(`Categoria do mercado:${dica}`);
    } else if (!categoria.id) {
        pendencias.push(`Categoria "${categoria.nome}" sem ID do Conta Azul; sincronize as categorias.`);
    }

    if (!descricao?.valor) {
        if (tipo === "PEDAGIO" || tipo === "ESTACIONAMENTO") descricao = { valor: TIPOS[tipo].rotulo, origem: "template_simples" };
        else if (material && itensDaNota.length && !descricao) {
            // "MATERIAL DE CAMPO - COLA CONTATO CASCOLA 730GR": item principal da nota, para confirmar.
            descricao = { valor: `MATERIAL DE CAMPO - ${String(itensDaNota[0]).replace(/\s+/g, " ").trim().toUpperCase()}`, origem: "template_material" };
            pendencias.push("Material de campo: descrição proposta pelo item da nota; confirme o texto.");
        } else if (!descricao) {
            const citado = [...(legenda?.observacoes || []), ...(lote?.quantidades?.itens || []).map((item) => item.descricao)][0];
            descricao = { valor: citado ? String(citado).toUpperCase() : null, origem: citado ? "mensagem_do_operador" : null };
            pendencias.push(citado ? "Descrição proposta a partir da mensagem; confirme o texto." : "Descrição sem template para este tipo; defina o texto.");
        }
    }
    campos.descricao = descricao;

    // Projeto / centro de custo: regra especial > orientacao da gerencia (Vanessa,
    // para o grupo/periodo) > legenda da foto > contexto do operador
    const orientacao = orientacaoVigente(contexto.orientacoes, ocr?.data || legenda?.data_declarada || lote?.data_declarada, contexto.momento);
    const projetoDoOperador = legenda?.projeto_texto || contexto.projeto?.texto || null;
    const projetoInformado = orientacao?.projeto_texto || projetoDoOperador;
    const projetoTexto = centroDaRegra || projetoInformado;
    if (!centroDaRegra && orientacao?.projeto_texto && projetoDoOperador && normalizar(projetoDoOperador) !== normalizar(orientacao.projeto_texto)) {
        const doOperador = cadastros.resolverProjeto(cad, projetoDoOperador, pessoa);
        const daGerencia = cadastros.resolverProjeto(cad, orientacao.projeto_texto, pessoa);
        if (doOperador.status === "RESOLVIDO" && daGerencia.projeto && doOperador.projeto.nome_oficial !== daGerencia.projeto.nome_oficial) {
            pendencias.push(`Operador informou "${projetoDoOperador}", mas a gerência orientou "${orientacao.projeto_texto}" para este período; confirme o centro de custo.`);
        } else {
            avisos.push(`Centro de custo da orientação da gerência ("${orientacao.projeto_texto}") usado no lugar de "${projetoDoOperador}".`);
        }
    }
    if (centroDaRegra && projetoInformado && normalizar(projetoInformado) !== normalizar(centroDaRegra)) {
        avisos.push(`Centro de custo da regra especial (${centroDaRegra}) prevaleceu sobre o projeto do operador (${projetoInformado}).`);
    }
    const resolucao = projetoTexto ? cadastros.resolverProjeto(cad, projetoTexto, pessoa) : null;
    const projetoAchado = resolucao?.projeto || null;
    campos.centro_custo = {
        texto_informado: projetoTexto,
        origem: centroDaRegra ? "regra_especial" : orientacao?.projeto_texto ? "orientacao_da_gerencia" : legenda?.projeto_texto ? "mensagem_da_foto" : contexto.projeto?.origem || null,
        nome: projetoAchado ? cadastros.nomeCentro(projetoAchado) : null,
        projeto: projetoAchado?.nome_oficial || null,
        id: resolucao?.status === "RESOLVIDO" ? projetoAchado.id_conta_azul || null : null,
        status: resolucao?.status || "NAO_INFORMADO",
        candidatos: (resolucao?.candidatos || []).map((projeto) => projeto.nome_oficial),
    };
    if (!projetoTexto) {
        // Sem projeto na mensagem: SUGERE o centro de costume (cadastro da pessoa
        // ou habito aprendido). Ex.: as notas do Jhonathan quase sempre sao
        // administrativas, mas nao todas — por isso nunca decide sozinho.
        const sugerido = pessoa?.centro_custo_sugerido || habitos?.centro?.valor || null;
        const projetoSugerido = sugerido ? cadastros.resolverProjeto(cad, sugerido, pessoa).projeto : null;
        if (projetoSugerido) {
            campos.centro_custo.sugestao = {
                nome: cadastros.nomeCentro(projetoSugerido), projeto: projetoSugerido.nome_oficial, id: projetoSugerido.id_conta_azul || null,
                origem: pessoa?.centro_custo_sugerido ? "costume_cadastrado" : "habito_do_operador", amostras: habitos?.centro?.amostras || null,
            };
            pendencias.push(`Projeto não informado. ${pessoa?.nome || "O operador"} costuma lançar em ${cadastros.nomeCentro(projetoSugerido)}; confirme.`);
        } else {
            pendencias.push("Projeto/centro de custo não informado pelo operador.");
        }
    } else if (resolucao.status === "RESOLVIDO") {
        if (!resolucao.projeto.id_conta_azul) pendencias.push(`Projeto "${resolucao.projeto.nome_oficial}" sem ID do Conta Azul; sincronize os centros de custo.`);
        if (resolucao.projeto.ativo !== true) pendencias.push(`Projeto "${resolucao.projeto.nome_oficial}" ainda não confirmado como ativo.`);
    } else if (resolucao.status === "INATIVO") {
        pendencias.push(`"${projetoTexto}" corresponde a projeto inativo${projetoAchado ? ` (${projetoAchado.nome_oficial})` : ""}; confirme o centro de custo.`);
    } else {
        const opcoes = campos.centro_custo.candidatos.length ? ` Possíveis: ${campos.centro_custo.candidatos.join(" | ")}.` : "";
        pendencias.push(`Projeto "${projetoTexto}" não corresponde exatamente a um projeto cadastrado.${opcoes}`);
    }

    // Despesa administrativa: refeicao e mercado vao para "Lanches e Refeições";
    // o resto segue a regra do tipo (nao existe "OUTROS" no Conta Azul). Com o centro so sugerido, a
    // categoria correspondente fica como sugestao.
    const centroAdministrativo = ehCentroAdministrativo(campos.centro_custo.nome);
    const sugeridoAdministrativo = !campos.centro_custo.nome && ehCentroAdministrativo(campos.centro_custo.sugestao?.nome);
    if (centroAdministrativo || sugeridoAdministrativo) {
        const categoriaAdm = categoriaAdministrativa(cad, tipo, material);
        if (categoriaAdm && centroAdministrativo && !iguaisTexto(campos.categoria.nome, categoriaAdm.nome) && campos.categoria.origem !== "regra_especial") {
            if (campos.categoria.nome) avisos.push(`Despesa administrativa: categoria "${campos.categoria.nome}" trocada por "${categoriaAdm.nome}".`);
            campos.categoria = { ...categoriaAdm, origem: "despesa_administrativa" };
            // As pendencias da categoria anterior deixam de valer.
            for (let i = pendencias.length - 1; i >= 0; i -= 1) if (/^Categoria (não definida|")/.test(pendencias[i])) pendencias.splice(i, 1);
            if (!categoriaAdm.id) pendencias.push(`Categoria "${categoriaAdm.nome}" sem ID do Conta Azul; sincronize as categorias.`);
        } else if (categoriaAdm && sugeridoAdministrativo && !iguaisTexto(campos.categoria.nome, categoriaAdm.nome)) {
            campos.categoria.sugestao = { nome: categoriaAdm.nome, origem: "despesa_administrativa" };
        }
    }

    // Pagamento
    const declaradoPag = legenda?.pagamento || lote?.pagamento || null;
    const origemDeclarado = legenda?.pagamento ? "mensagem_da_foto" : lote?.pagamento ? "cabecalho_do_lote" : null;
    let pagamento = null;
    // Sem politica do projeto, vale o cartao da orientacao da gerencia para o
    // grupo; sem ela, o cartao cadastrado no proprio centro de custo.
    if (!politica?.cartao && orientacao?.cartao) politica = { cartao: orientacao.cartao, origem: "orientacao_da_gerencia" };
    if (!politica?.cartao && projetoAchado?.cartao) politica = { cartao: projetoAchado.cartao, origem: "cartao_do_centro_de_custo" };
    const fontePolitica = politica?.origem === "cartao_do_centro_de_custo" ? "o cartão cadastrado no centro de custo" : "a orientação da gerência para o projeto";
    if (declaradoPag?.cartao && politica?.cartao && declaradoPag.cartao !== politica.cartao) {
        pendencias.push(`Cartão informado (${declaradoPag.rotulo}) diverge d${fontePolitica} (${politica.cartao}).`);
        pagamento = { forma: declaradoPag.forma, cartao: declaradoPag.cartao, origem: origemDeclarado, conflito_com_politica: politica };
    } else if (declaradoPag) {
        pagamento = { forma: declaradoPag.forma, cartao: declaradoPag.cartao, origem: origemDeclarado };
        if (declaradoPag.pagador) pagamento.pagador = declaradoPag.pagador;
        if (!declaradoPag.cartao && politica?.cartao) avisos.push(`Pagamento excepcional declarado (${declaradoPag.rotulo}) num projeto com orientação de cartão ${politica.cartao}.`);
    } else if (politica?.cartao) {
        const cartao = cad.cartoes.find((item) => item.codigo === politica.cartao);
        pagamento = { forma: cartao?.forma_pagamento || "CARTAO_CREDITO", cartao: politica.cartao, origem: politica.origem || "orientacao_da_gerencia" };
    }
    if (pagamento?.cartao) {
        const cartao = cad.cartoes.find((item) => item.codigo === pagamento.cartao);
        pagamento.rotulo = cartao?.rotulo || pagamento.cartao;
        pagamento.conta_id = cartao?.conta_conta_azul_id || null;
    }
    campos.pagamento = pagamento || { forma: null, cartao: null, origem: null };

    // Observacao do lancamento (opcional): reembolso, pagamento fora do cartao
    // da empresa e "Obs:" do operador. Vai para o campo observacao no Conta Azul.
    campos.observacao = { valor: montarObservacao({ legenda, pagamento: campos.pagamento }), origem: "mensagem" };
    if (!campos.observacao.valor) campos.observacao.origem = null;
    if (legenda?.reembolso) avisos.push("Operador indica que pagou do próprio bolso: reembolso anotado na observação.");

    if (!pagamento) {
        const impresso = ocr?.forma_pagamento ? ` (o cupom indica ${ocr.forma_pagamento}, mas isso não decide)` : "";
        // Cartao de costume do operador: so SUGESTAO (quem decide e a mensagem ou a gerencia).
        const costume = habitos?.cartao;
        const cartaoCostume = costume ? cad.cartoes.find((item) => item.codigo === costume.codigo) : null;
        if (cartaoCostume) {
            campos.pagamento.sugestao = { codigo: cartaoCostume.codigo, rotulo: cartaoCostume.rotulo, origem: "habito_do_operador", amostras: costume.amostras };
            pendencias.push(`Cartão não informado${impresso}. ${pessoa?.nome || "O operador"} costuma usar ${cartaoCostume.rotulo} (${costume.amostras} notas aprovadas).`);
        } else {
            pendencias.push(`Forma/conta de pagamento não informada${impresso}.`);
        }
    } else if (pagamento.forma === "CARTAO_CREDITO" && !pagamento.cartao) {
        // "Crédito" sem o banco: para lancar e preciso saber de qual cartao sai.
        const costume = habitos?.cartao ? cad.cartoes.find((item) => item.codigo === habitos.cartao.codigo) : null;
        if (costume) campos.pagamento.sugestao = { codigo: costume.codigo, rotulo: costume.rotulo, origem: "habito_do_operador", amostras: habitos.cartao.amostras };
        pendencias.push(`Cartão de crédito sem o banco; confirme qual cartão${costume ? ` (${pessoa?.nome || "o operador"} costuma usar ${costume.rotulo})` : ""}.`);
    } else if (ocr?.forma_pagamento && pagamento.forma && ocr.forma_pagamento !== pagamento.forma) {
        avisos.push(`O cupom indica ${ocr.forma_pagamento}; prevaleceu o pagamento informado (${pagamento.rotulo || pagamento.forma}).`);
    }

    // Reembolso: a descricao do anexo (ao lado da foto no Conta Azul) diz de quem e
    // o reembolso, como a VMac faz: "REEMBOLSO LORRAN".
    if (legenda?.reembolso && !descricaoAnexo) {
        const nome = pessoa?.nome || identificacao?.sugestao?.nome || null;
        descricaoAnexo = nome ? `REEMBOLSO ${normalizar(nome).toUpperCase()}` : "REEMBOLSO";
        if (!nome) pendencias.push("Reembolso sem o operador identificado: complete a descrição do anexo com o nome de quem pagou.");
    }

    // Anexo
    campos.anexo = {
        tipo: tipo === "ABASTECIMENTO" ? TIPO_ANEXO_FISCAL : TIPO_ANEXO_OUTROS,
        descricao: descricaoAnexo,
    };

    return {
        campos,
        pendencias: [...new Set(pendencias)],
        avisos: [...new Set(avisos)],
        estado: pendencias.length ? "AGUARDANDO_REVISAO" : "CLASSIFICADO",
    };
}

const ROTULO_FORMA = { PIX: "PIX", DINHEIRO: "dinheiro", CARTAO_DEBITO: "cartão de débito", CARTAO_CREDITO: "cartão de crédito" };

function montarObservacao({ legenda, pagamento }) {
    const partes = [];
    if (legenda?.reembolso) partes.push(`REEMBOLSO ao operador: ${legenda.reembolso_texto || "pago do próprio bolso"}`);
    if (pagamento && !pagamento.cartao && pagamento.forma && pagamento.forma !== "CARTAO_CREDITO") {
        const quem = pagamento.pagador ? ` (${pagamento.pagador})` : "";
        partes.push(`Pago via ${ROTULO_FORMA[pagamento.forma] || pagamento.forma}${quem}, fora do cartão da empresa${legenda?.reembolso ? "" : " — conferir reembolso"}`);
    }
    for (const obs of legenda?.obs_rotuladas || []) if (!partes.some((p) => p.includes(obs))) partes.push(obs);
    return partes.length ? partes.join(". ").slice(0, 500) : null;
}

const LITROS_MAXIMO_GERADOR = 12;
const ehItemDeAgua = (descricao) => /\bagua\b/.test(normalizar(descricao || "")) && !/\bcoco\b|\btonica\b|\bsaborizada\b/.test(normalizar(descricao || ""));

/** Nota em que TODOS os itens sao agua mineral. */
function itensSoDeAgua(ocr) {
    const itens = (ocr?.itens || []).filter((item) => item.descricao);
    return itens.length > 0 && itens.every((item) => ehItemDeAgua(item.descricao));
}

function quantidadeDeAgua(ocr) {
    const total = (ocr?.itens || []).filter((item) => ehItemDeAgua(item.descricao))
        .reduce((soma, item) => soma + (Number.isInteger(Number(item.quantidade)) && Number(item.quantidade) > 0 ? Number(item.quantidade) : 1), 0);
    return total || null;
}

/** Tipo do lugar da compra, so para escolher o fornecedor generico. */
function tipoDoEstabelecimento(ocr) {
    const estabelecimento = textoDoEstabelecimento(ocr);
    if (contemTermo(estabelecimento, "posto") || COMBUSTIVEIS.some((termo) => contemTermo(estabelecimento, termo))) return "ABASTECIMENTO";
    if (RESTAURANTES.some((termo) => contemTermo(estabelecimento, termo))) return "REFEICAO";
    return null;
}

/**
 * Litros quando a unidade veio ilegivel ("20,524 IT", "27.344 1.1"): procura a
 * quantidade com 3 casas que, vezes um preco por litro (R$ 3 a 9,99), da o
 * valor da nota (±2%). Sem isso, valor ÷ preco (so com um unico preco).
 */
function litrosPelaConta(texto, valor) {
    if (!(valor > 0)) return null;
    const t = String(texto || "");
    const precos = [...t.matchAll(/(?<![\d.,])([3-9][.,]\d{2,3})(?![\d.,])/g)].map((m) => Number(m[1].replace(",", "."))).filter((p) => p >= 3 && p < 10);
    const quantidades = [...t.matchAll(/(?<![\d.,])(\d{1,3})[.,](\d{3})(?![\d.,])/g)].map((m) => Number(`${m[1]}.${m[2]}`)).filter((q) => q >= 1 && q <= 300);
    let melhor = null;
    for (const q of quantidades) for (const p of precos) {
        const erro = Math.abs(q * p - valor) / valor;
        if (erro <= 0.02 && (!melhor || erro < melhor.erro)) melhor = { litros: q, preco: p, erro, origem: "conta_litros_x_preco" };
    }
    if (melhor) return melhor;
    const unicos = [...new Set(precos)];
    return unicos.length === 1 ? { litros: Math.round((valor / unicos[0]) * 1000) / 1000, preco: unicos[0], origem: "valor_dividido_pelo_preco" } : null;
}

const TIPOS_COM_NOTA_PROPRIA = ["ABASTECIMENTO", "HOSPEDAGEM", "PEDAGIO", "ESTACIONAMENTO"];

/**
 * Orientacao da gerencia que vale para a nota: com periodo, a data da nota
 * precisa estar dentro dele (vale mesmo para notas enviadas ANTES da
 * mensagem); sem periodo, vale a partir da mensagem. A mais recente vence.
 */
function orientacaoVigente(orientacoes, dataNota, momento) {
    const lista = Array.isArray(orientacoes) ? orientacoes : [];
    const data = dataNota || (momento ? String(momento).slice(0, 10) : null);
    return lista.find((item) => (item.periodo
        ? Boolean(data) && data >= item.periodo.de && data <= item.periodo.ate
        : !momento || !item.desde || item.desde <= momento)) || null;
}

const ehCentroAdministrativo = (nome) => /despesas\s+administrativas/i.test(String(nome || ""));
const iguaisTexto = (a, b) => Boolean(a) && Boolean(b) && normalizar(a) === normalizar(b);

/** Categoria de despesa administrativa: refeicao/mercado -> Lanches e Refeições; o resto segue a regra do tipo. */
function categoriaAdministrativa(cad, tipo, material) {
    if (material) return null;
    if (TIPOS[tipo]?.refeicao || tipo === "MERCADO") {
        const lanches = cadastros.categoriaPorNome(cad, "ALIMENTACAO EM CAMPO");
        return lanches ? { nome: lanches.nome, id: lanches.id } : { nome: "Lanches e Refeições", id: null };
    }
    return null;
}

/** Categoria indicada por nome livre (regra especial), resolvida no cadastro se possivel. */
function categoriaLivre(cad, nome, idInformado = null) {
    if (!nome || String(nome).startsWith("PREENCHER_")) return { nome: null, id: null, origem: "regra_especial_sem_categoria" };
    const alvo = normalizar(nome);
    const achada = cad.categorias.find((item) => normalizar(item.nome) === alvo || normalizar(item.nome_conta_azul) === alvo);
    const id = idInformado || achada?.id;
    const idValido = id && !String(id).startsWith("PREENCHER_");
    return { nome: achada?.nome_conta_azul || nome, id: idValido ? id : null, origem: "regra_especial" };
}

module.exports = {
    montarPrevia, decidirTipo, decidirPessoas, refeicaoPeloHorario, orientacaoVigente,
    descricaoAbastecimento, descricaoRefeicao, litrosBr, milharBr, TIPOS,
    TIPO_ANEXO_FISCAL, TIPO_ANEXO_OUTROS,
};
