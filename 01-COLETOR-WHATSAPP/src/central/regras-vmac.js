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

const fs = require("fs");
const path = require("path");
const { normalizar, contemTermo, centavos } = require("./texto");
const modeloCentral = require("./modelo");
const cadastros = require("./cadastros");
const { veiculoPeloKm, regraPara } = require("./regras-operador");

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
    // Uber, 99, taxi: "Transporte Urbano (taxi, Uber)" no Conta Azul.
    TRANSPORTE: { rotulo: "TRANSPORTE", categoria: "TRANSPORTE URBANO" },
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
// Oficina/manutencao de veiculo (correcoes de 22-24/10/2026: autopecas, "MECAN", autocenter,
// montagem de pneu, rodas, "reparos automotivos" estavam virando restaurante/outros).
const OFICINAS = ["oficina", "mecanica", "mecan", "auto pecas", "autopecas", "auto peca", "autopeca", "auto center", "autocenter", "centro automotivo",
    "automotivos", "automotiva", "automotivo", "reparos automotivos", "borracharia", "pneu", "pneus", "montagem de pneu", "montagem pneu", "alinhamento",
    "balanceamento", "rodas", "retifica", "funilaria", "auto eletrica", "lubrificantes", "troca de oleo", "mao de obra mecanica"];
// Bebida sozinha (Coca, energetico, suco) nao e lanche: vai como OUTROS em Lanches e Refeicoes (#293).
const BEBIDAS = ["refrigerante", "refrig", "coca", "coca cola", "guarana", "fanta", "sprite", "pepsi", "energetico", "monster", "red bull", "redbull",
    "suco", "cha gelado", "isotonico", "gatorade", "powerade", "cerveja", "agua de coco", "achocolatado", "toddynho"];
// Corrida de aplicativo/taxi: categoria "Transporte Urbano (taxi, Uber)" (#248).
const TRANSPORTES = ["uber", "99app", "99 pop", "99pop", "99 taxi", "taxi", "cabify", "indriver", "indrive"];
const RESTAURANTES = ["restaurante", "lanchonete", "churrascaria", "pizzaria", "padaria", "panificadora", "confeitaria",
    "cafeteria", "bar", "self service", "marmitaria", "pastelaria", "hamburgueria", "lanches", "grill", "buffet"];
const HOTEIS = ["hotel", "hoteis", "pousada", "hostel", "motel", "hospedagem", "flat", "apart hotel"];
const MERCADOS = ["supermercado", "supermercados", "mercado", "mercearia", "atacadao", "atacadista", "hipermercado", "minimercado",
    "comercio varejista", "comercio de alimentos", "varejista de alimentos"];

// Material de campo (revisao de 13/10: ferragens com parafuso e cola de contato
// tinham virado "restaurante"). Estabelecimento ou itens com estes termos.
// So termos especificos: "cola" solto pegaria "Coca-Cola".
const LOJAS_MATERIAL = ["ferragem", "ferragens", "material de construcao", "materiais de construcao", "casa do construtor", "home center",
    "madeireira", "materiais eletricos", "material eletrico", "hidraulica", "tintas", "parafusos", "loja de ferramentas"];
const ITENS_MATERIAL = ["parafuso", "parafusos", "porca sextavada", "arruela", "cola contato", "cascola", "super cola", "fita isolante", "fita crepe",
    "abracadeira", "lampada", "pincel", "broca", "alicate", "martelo", "trena", "silicone", "cimento", "prego", "dobradica", "cadeado"];

// Base de produtos editavel (configuracao/produtos.json): o que a VMac compra em
// campo (ferramentas, eletrica, colas e fitas, EPI, limpeza, escritorio...).
let baseProdutos = { lido_em: 0, lojas: [], itens: [] };
function produtosConhecidos() {
    const arquivo = path.join(cadastros.PASTA_PADRAO, "produtos.json");
    try {
        const mtime = fs.statSync(arquivo).mtimeMs;
        if (mtime !== baseProdutos.lido_em) {
            const json = JSON.parse(fs.readFileSync(arquivo, "utf8"));
            baseProdutos = { lido_em: mtime, lojas: json.material_de_campo?.lojas || [], itens: json.material_de_campo?.itens || [] };
        }
    } catch (_) { /* sem a base: so as listas fixas */ }
    return { lojas: [...LOJAS_MATERIAL, ...baseProdutos.lojas], itens: [...ITENS_MATERIAL, ...baseProdutos.itens] };
}

const ehItemDeMaterial = (texto) => produtosConhecidos().itens.some((termo) => contemTermo(texto, termo));

/**
 * Material de campo: loja de material, ou pelo menos metade das linhas de item
 * sao produtos de material (uma Coca no meio da ferragem nao atrapalha; um pano
 * no meio da compra de comida nao vira material). Sem linhas, vale o texto.
 */
function ehMaterialDeCampo(estabelecimento, itens, linhas = null) {
    const { lojas } = produtosConhecidos();
    if (lojas.some((termo) => contemTermo(estabelecimento, termo))) return true;
    const lista = (linhas || []).filter(Boolean);
    if (lista.length) return lista.filter(ehItemDeMaterial).length >= lista.length / 2;
    return ehItemDeMaterial(itens);
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
    if (minutos >= 1110) return "JANTAR";                         // 18h30-23h59
    if (minutos < 300) return "LANCHE";                           // madrugada: lanche, nao jantar (#287, 00:07)
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
    if (minutos < 300) return "LANCHE";
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
    // Corrida de Uber/99/taxi.
    const cabecalho = String(ocr?.texto_bruto || "").split(/\r?\n/).slice(0, 8).join(" ");
    if (TRANSPORTES.some((termo) => contemTermo(estabelecimento, termo) || contemTermo(cabecalho, termo))) return { tipo: "TRANSPORTE", origem: "estabelecimento_da_nota" };
    if (itensLidos.length && !itemDeCombustivel) {
        // So bebida (Coca, energetico...), sem comida: nao e lanche (#293).
        const ehBebida = (descricao) => BEBIDAS.some((termo) => contemTermo(descricao, termo));
        if (itensLidos.every((item) => ehBebida(item.descricao)) && !itensSoDeAgua(ocr)) return { tipo: "OUTROS", origem: "so_bebidas", bebida: true };
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
    if (ehMaterialDeCampo(estabelecimento, itens, itensLidos.map((item) => item.descricao))) return { tipo: "OUTROS", origem: "material_de_campo", material: true };
    // Oficina pelo nome so se nao for posto ("Auto Posto e Auto Center", "Lubrificantes" sao postos).
    // Pelo nome, pelos itens ou pelo topo do cupom ("AUTOPEÇAS", "MECAN", "MONTAGEM PNEU").
    const deOficina = [estabelecimento, itens, cabecalho].some((texto) => OFICINAS.some((termo) => contemTermo(texto, termo)));
    // "AUTOCENTER Posto Ipiranga" com item "MONTAGEM PNEUS": o servico nos itens vence o "posto" no nome (#306).
    const servicoNosItens = OFICINAS.some((termo) => contemTermo(itens, termo));
    if (deOficina && (!contemTermo(estabelecimento, "posto") || servicoNosItens)) return { tipo: "MANUTENCAO", origem: "nome_do_estabelecimento" };
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
    let pelaHora = refeicaoPeloHorario(ocr?.hora);
    // Churrascaria/churrasco a tarde ou sem horario e almoco, nao lanche (#305).
    const churrasco = ["churrascaria", "churrasco", "churrascos"].some((t) => contemTermo(textoDoEstabelecimento(ocr), t));
    if (churrasco && (pelaHora === "LANCHE" || !pelaHora)) {
        if (!pelaHora) return { tipo: "ALMOCO", origem: "estabelecimento_da_nota", pendencia: "Churrascaria sem horário na nota: lançado como almoço; confirme." };
        pelaHora = "ALMOCO";
    }
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

function montarPrevia({ ocr = null, legenda = {}, contexto = {}, politica = null, identificacao = {}, cad, regras = {}, hoje = new Date(), modelo, habitos = null, pessoasRecentes = null,
    frotaRecente = null, regrasOperador = [], fornecedorAprendido = null }) {
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
        // Sem data na nota: a do cabecalho/mensagem do dia, senao a do envio (correcoes de 24/10/2026).
        const daMensagem = legenda?.data_declarada || lote?.data_declarada || null;
        const doEnvio = contexto.momento ? new Date(new Date(contexto.momento).getTime() - 3 * 3600000).toISOString().slice(0, 10) : null;
        const usada = daMensagem || doEnvio;
        if (usada) {
            campos.data_competencia = { valor: usada, origem: daMensagem ? "mensagem_do_dia" : "data_do_envio" };
            pendencias.push(`Data não lida na nota; usada ${usada.split("-").reverse().join("/")} (${daMensagem ? "da mensagem do dia" : "dia em que a foto chegou"}). Confira.`);
        } else {
            pendencias.push(ocr ? "Data da compra não foi lida na nota." : "Data da compra sem comprovante para confirmar.");
        }
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
    // Legenda so com a bebida ("Energético"), sem tipo dito: bebida, nao refeicao (#330).
    if (!(legenda?.tipos || []).length && ehRefeicao(tipo) && BEBIDAS.some((termo) => contemTermo(legenda?.texto || "", termo))) {
        tipo = "OUTROS";
        decisaoTipo.origem = "mensagem_da_foto";
        decisaoTipo.bebida = true;
    }
    // "Material - parafusos" na legenda: material de campo, salvo tipos que a
    // nota identifica sem duvida (posto, hotel, pedagio, estacionamento).
    // "Pano de chão", "fita dupla face" na legenda (sem tipo dito): tambem e material.
    const materialNaLegenda = legenda?.material || (!(legenda?.tipos || []).length && ehItemDeMaterial(legenda?.texto || ""));
    if (materialNaLegenda && !TIPOS_COM_NOTA_PROPRIA.includes(tipo)) {
        tipo = "OUTROS";
        decisaoTipo.origem = "mensagem_da_foto";
        decisaoTipo.material = true;
    }
    campos.tipo = { valor: tipo, origem: decisaoTipo.origem };
    if (ocr?.hora) campos.hora_da_nota = { valor: ocr.hora, origem: "nota", uso: "somente_pista" };

    // Fornecedor
    // Material de campo (ferragens, parafuso, cola de contato...): fornecedor generico "Materiais de Campo".
    const itensDaNota = (ocr?.itens || []).map((item) => item.descricao).filter(Boolean);
    const material = tipo === "OUTROS" && (decisaoTipo.material || materialNaLegenda || ehMaterialDeCampo(textoDoEstabelecimento(ocr), itensDaNota.join(" "), itensDaNota));
    // Agua: o fornecedor e o do lugar onde foi comprada (restaurante, mercado, posto).
    // Refeicao em padaria -> PADARIA; em mercado -> fornecedor do mercado (SUPERMERCADO), como o Conta Azul faz.
    const estabelecimentoDaNota = textoDoEstabelecimento(ocr);
    const refeicaoEm = TIPOS[tipo]?.refeicao
        ? (["padaria", "panificadora", "panificacao", "confeitaria"].some((t) => contemTermo(estabelecimentoDaNota, t)) ? "PADARIA"
            : MERCADOS.some((t) => contemTermo(estabelecimentoDaNota, t)) ? null : tipo)
        : tipo;
    const tipoDoFornecedor = material ? "MATERIAL_DE_CAMPO" : tipo === "AGUA" ? tipoDoEstabelecimento(ocr) : refeicaoEm;
    // Razao social ("A A RIBEIRO SUPERMERCADO") e nome fantasia ("BOM DIA SUPERMERCADOS"):
    // vale o que achar um fornecedor conhecido no Conta Azul.
    const conhecido = (r) => ["fornecedor_recorrente", "fornecedor_cadastrado", "fornecedor_generico_do_tipo"].includes(r.origem);
    const pelaRazao = cadastros.resolverFornecedor(cad, ocr?.fornecedor || ocr?.nome_fantasia, tipoDoFornecedor);
    const pelaFantasia = ocr?.nome_fantasia && ocr?.fornecedor ? cadastros.resolverFornecedor(cad, ocr.nome_fantasia, tipoDoFornecedor) : null;
    let fornecedor = !conhecido(pelaRazao) && pelaFantasia && conhecido(pelaFantasia) ? pelaFantasia : pelaRazao;
    // Nome do fornecedor conhecido impresso no topo do cupom ("BOM DIA SUPERMERCADOS STB" acima
    // da razao social "A A RIBEIRO SUPERMERCADO", #301).
    if (!conhecido(fornecedor)) {
        for (const linha of String(ocr?.texto_bruto || "").split(/\r?\n/).slice(0, 6)) {
            const r = linha.trim().length >= 6 ? cadastros.resolverFornecedor(cad, linha, null) : null;
            if (r && ["fornecedor_recorrente", "fornecedor_cadastrado"].includes(r.origem)) { fornecedor = { ...r, nome_lido: ocr?.fornecedor || null }; break; }
        }
    }
    // Manutencao: autopecas -> AUTO PEÇAS; oficina/MECAN/autocenter/pneu -> Oficina Mecanica (correcoes de 22-24/10/2026).
    if (tipo === "MANUTENCAO" && fornecedor.origem === "fornecedor_generico_do_tipo") {
        const textoOficina = [estabelecimentoDaNota, itensDaNota.join(" "), String(ocr?.texto_bruto || "").split(/\r?\n/).slice(0, 8).join(" ")].join(" ");
        const especifico = ["auto pecas", "autopecas", "auto peca", "autopeca"].some((t) => contemTermo(textoOficina, t)) ? "AUTO PEÇAS"
            : ["oficina", "mecanica", "mecan", "auto center", "autocenter", "pneu", "pneus", "borracharia", "alinhamento", "balanceamento"].some((t) => contemTermo(textoOficina, t)) ? "Oficina Mecanica" : null;
        if (especifico) fornecedor = { ...fornecedor, nome: especifico, origem: "tipo_de_oficina" };
    }
    // O revisor ja corrigiu o fornecedor deste CNPJ antes: segue a escolha dele.
    const aprendido = fornecedorAprendido && ocr?.cnpj ? fornecedorAprendido(ocr.cnpj) : null;
    if (aprendido && normalizar(aprendido) !== normalizar(fornecedor.nome)) {
        fornecedor = { nome: aprendido, origem: "corrigido_antes_para_este_cnpj", nome_lido: ocr?.fornecedor || null };
        avisos.push(`Fornecedor "${aprendido}": é o que você escolheu antes para este CNPJ.`);
    }
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
        // Sem placa na nota: deduz pelo km entre os veiculos que o operador abasteceu
        // nos ultimos dias (o km so aumenta). Sem km, so sugere.
        let sugestaoDaFrota = null;
        if (!placaInfo.valor && frotaRecente && !legenda?.gerador) {
            const dataNota = ocr?.data || legenda?.data_declarada || lote?.data_declarada || null;
            const frota = frotaRecente(dataNota) || [];
            const pelaKm = veiculoPeloKm(frota, odometroInfo.valor, dataNota);
            if (pelaKm?.placa) {
                placaInfo.valor = pelaKm.placa;
                placaInfo.origem = "deduzida_pelo_km";
                const [, mm, dd] = pelaKm.referencia.data.split("-");
                avisos.push(`Placa não lida na nota; deduzida pelo km: ${cadastros.placaCanonica(pelaKm.placa)} estava com ${milharBr(pelaKm.referencia.odometro)} km em ${dd}/${mm} (+${milharBr(pelaKm.distancia)} km).`);
            } else if (frota.length) {
                const opcoes = (pelaKm?.ambiguo || frota).map((v) => cadastros.placaCanonica(v.placa));
                sugestaoDaFrota = opcoes;
                pendencias.push(`Placa não lida na nota${odometroInfo.valor ? "" : " e sem km"}. Veículos de ${pessoa?.nome || "o operador"} nos últimos dias: ${opcoes.join(", ")}. Confirme qual é.`);
            }
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
        // Litros × preco por litro tem que dar o valor da nota. "32 350 L" lido como 350 L
        // (virgula virou espaco) e corrigido pelo numero colado ao "L" que fecha a conta.
        if (litrosInfo.origem === "nota" || !litrosInfo.valor) {
            // Nota com oleo/Arla junto: a conta usa o valor da linha do combustivel, nao o total.
            const itemCombustivel = (ocr?.itens || []).find((item) => /gasolina|diesel|etanol|alcool|álcool|gnv/i.test(String(item.descricao || "")))
                || (ocr?.itens || []).find((item) => Number(item.valor_unitario) > 0);
            const precoItem = Number(itemCombustivel?.valor_unitario) > 0 ? Number(itemCombustivel.valor_unitario) : null;
            const valorCombustivel = Number(itemCombustivel?.valor_total) > 0 ? Number(itemCombustivel.valor_total) : valorNota;
            const conferido = conferirLitros({ litros: litrosInfo.valor, valores: [valorCombustivel, valorNota], precoItem, texto: ocr?.texto_bruto });
            const preco = conferido.preco ? String(conferido.preco).replace(".", ",") : "";
            if (conferido.mudou && !conferido.confirmar) {
                avisos.push(`Litros ${litrosInfo.valor ? `lidos como ${litrosBr(litrosInfo.valor)} ` : ""}corrigidos para ${litrosBr(conferido.litros)} L: ${litrosBr(conferido.litros)} × R$ ${preco} = valor da nota${conferido.como === "numero_junto_do_L" ? " (número junto do \"L\" na nota)" : ""}.`);
                litrosInfo.valor = conferido.litros;
                litrosInfo.origem = "nota";
            } else if (conferido.mudou) {
                pendencias.push(`Litros ${litrosInfo.valor ? `lidos (${litrosBr(litrosInfo.valor)}) não fecham com o valor; ` : "não lidos; "}calculados como valor ÷ preço (R$ ${preco}) = ${litrosBr(conferido.litros)} L. Confirme na foto.`);
                litrosInfo.valor = conferido.litros;
                litrosInfo.origem = "valor_dividido_pelo_preco";
            } else if (conferido.confirmar) {
                pendencias.push(`Litros ${litrosBr(litrosInfo.valor)} × preço por litro não dá o valor da nota. Confira os litros na foto.`);
            }
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
        const faltando = [!litros && "litros", !odometro && !litros && "hodômetro", !placaLida && !ocr?.placa_bruta && !sugestaoDaFrota && "placa"].filter(Boolean);
        if (sugestaoDaFrota?.length === 1) campos.abastecimento.placa.sugestao = { valor: sugestaoDaFrota[0], origem: "frota_recente_do_operador" };
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
        let pessoas = decidirPessoas({ tipo, legenda, lote, ocr, habitos, recentes });
        // Pessoas x valor (correcoes de 22-24/10/2026): "R$ 33 nao almoca 4 pessoas",
        // "R$ 138 de almoco nao e 1 pessoa". Estimativa fora da faixa e refeita pelo valor;
        // numero dito pelo operador fica, so com aviso.
        const faixa = VALOR_POR_PESSOA[tipo];
        if (faixa && valorNota > 0) {
            const porPessoa = pessoas.valor ? valorNota / pessoas.valor : null;
            // Gritante = bem fora da faixa: costume e notas do dia anterior acertam na maioria; o valor so corrige o absurdo.
            const foraDaFaixa = porPessoa !== null && (porPessoa < faixa.min * 0.6 || porPessoa > faixa.max * 1.3);
            const pelaConta = Math.max(1, Math.round(valorNota / faixa.tipico));
            if (pelaConta > 15) {
                // R$ 33.004 de almoco: o valor foi mal lido (#298); nao estima pessoas por ele.
                pendencias.push(`Valor R$ ${valorNota.toFixed(2).replace(".", ",")} é alto demais para ${TIPOS[tipo].rotulo.toLowerCase()}; confira o valor na foto (pode ter sido mal lido).`);
            } else if (pessoas.valor && foraDaFaixa && pessoas.confirmado) {
                avisos.push(`R$ ${valorNota.toFixed(2).replace(".", ",")} para ${pessoas.valor} pessoa(s) dá R$ ${porPessoa.toFixed(2).replace(".", ",")} por pessoa, fora do comum para ${TIPOS[tipo].rotulo.toLowerCase()}. Confira.`);
            } else if ((foraDaFaixa || !pessoas.valor) && pelaConta !== pessoas.valor) {
                pessoas = { valor: pelaConta, origem: "valor_da_nota", confirmado: false, anterior: pessoas.valor || null };
            }
        }
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
        } else if (pessoas.origem === "valor_da_nota") {
            pendencias.push(`${pessoas.anterior ? `${pessoas.anterior} pessoa(s) não combina com o valor; ` : "Pessoas não informadas; "}estimado ${pessoas.valor} pelo valor (R$ ${valorNota.toFixed(2).replace(".", ",")}, cerca de R$ ${VALOR_POR_PESSOA[tipo].tipico} por pessoa). Confirme.`);
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
        // Material de quem compra para o deposito (Everson -> galpao de Santa Branca): regra
        // confirmada do operador "categoria_material"; sem ela, MATERIAL DE CAMPO.
        const regraMaterial = regraPara(regrasOperador, "categoria_material", campos.data_competencia?.valor);
        const daRegra = regraMaterial ? cadastros.categoriaPorNome(cad, regraMaterial.valor) : null;
        const encontrada = daRegra || cadastros.categoriaPorNome(cad, "MATERIAL DE CAMPO");
        categoria = encontrada ? { ...encontrada, origem: daRegra ? "regra_do_operador" : "material_de_campo" } : null;
        if (daRegra) avisos.push(`Material de ${pessoa?.nome || "o operador"}: categoria ${daRegra.nome} pela regra confirmada.`);
    }
    if (!categoria && decisaoTipo.bebida) {
        const lanches = cadastros.categoriaPorNome(cad, "ALIMENTACAO EM CAMPO");
        if (lanches) categoria = { ...lanches, origem: "so_bebidas" };
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
        else if (tipo === "TRANSPORTE") {
            const qual = TRANSPORTES.find((termo) => contemTermo([textoDoEstabelecimento(ocr), ocr?.texto_bruto, legenda?.texto].join(" "), termo));
            descricao = { valor: qual === "taxi" ? "TÁXI" : qual ? (qual.startsWith("99") ? "99" : qual.toUpperCase()) : "TRANSPORTE", origem: "template_simples" };
        }
        else if (decisaoTipo.bebida && itensDaNota.length) {
            // So bebida: "COCA COLA - 5" (nome + quantidade, como o Yan corrigiu em #293/#284).
            const total = (ocr?.itens || []).reduce((soma, item) => soma + (Number(item.quantidade) > 0 ? Number(item.quantidade) : 1), 0);
            const nome = itensDaNota.some((d) => contemTermo(d, "coca")) ? "COCA COLA" : nomeCurtoDoItem(itensDaNota[0]) || "BEBIDA";
            descricao = { valor: `${nome} - ${Math.round(total)}`, origem: "template_bebida" };
        } else if (material && itensDaNota.length && !descricao) {
            // So o que foi comprado, curto: "LAMPADA H4", "CHAVE ALAVANCA E CHAVE MG" (correcoes de 22-24/10/2026).
            const nomes = [...new Set(itensDaNota.map(nomeCurtoDoItem).filter(Boolean))].slice(0, 2);
            descricao = { valor: nomes.length ? nomes.join(" E ") : String(itensDaNota[0]).replace(/\s+/g, " ").trim().toUpperCase(), origem: "template_material" };
            avisos.push("Material de campo: descrição com o nome curto do que foi comprado; ajuste se precisar.");
        } else if (!descricao) {
            const citado = [...(legenda?.observacoes || []), ...(lote?.quantidades?.itens || []).map((item) => item.descricao)][0];
            descricao = { valor: citado ? String(citado).toUpperCase() : null, origem: citado ? "mensagem_do_operador" : null };
            pendencias.push(citado ? "Descrição proposta a partir da mensagem; confirme o texto." : "Descrição sem template para este tipo; defina o texto.");
        }
    }
    campos.descricao = descricao;

    // Projeto / centro de custo: regra especial > orientacao da gerencia (Vanessa,
    // para o grupo/periodo) > legenda da foto > contexto do operador
    let orientacao = orientacaoVigente(contexto.orientacoes, ocr?.data || legenda?.data_declarada || lote?.data_declarada, contexto.momento);
    // Regras confirmadas do operador (botao "Reclassificar com minhas observações"):
    // valem quando a foto e o cabecalho do dia nao dizem o centro/cartao. Regra
    // mais nova que a orientacao da gerencia vence (o operador mudou de projeto).
    const dataDaNota = ocr?.data || legenda?.data_declarada || lote?.data_declarada || String(contexto.momento || "").slice(0, 10) || null;
    const regraCentro = regraPara(regrasOperador, "centro", dataDaNota);
    const regraCartao = regraPara(regrasOperador, "cartao", dataDaNota);
    const inicioOrientacao = (o) => o?.periodo?.de || String(o?.desde || "").slice(0, 10);
    if (orientacao && regraCentro && regraCentro.desde > inicioOrientacao(orientacao)) orientacao = { ...orientacao, projeto_texto: null, cartao: regraCartao && regraCartao.desde > inicioOrientacao(orientacao) ? null : orientacao.cartao };
    let projetoDoOperador = legenda?.projeto_texto || contexto.projeto?.texto || null;
    let centroPelaRegra = false;
    if (regraCentro && !centroDaRegra && !orientacao?.projeto_texto) {
        const nomeOperador = pessoa?.nome || "o operador";
        if (!projetoDoOperador) {
            projetoDoOperador = regraCentro.valor;
            centroPelaRegra = true;
            avisos.push(`Centro de custo não informado; usado o de ${nomeOperador} pela regra confirmada (desde ${regraCentro.desde.split("-").reverse().join("/")}).`);
        } else if (cadastros.resolverProjeto(cad, projetoDoOperador, pessoa).status !== "RESOLVIDO") {
            avisos.push(`"${projetoDoOperador}" não é um centro cadastrado; usado o de ${nomeOperador} pela regra confirmada (${regraCentro.valor}).`);
            projetoDoOperador = regraCentro.valor;
            centroPelaRegra = true;
        }
    }
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
        origem: centroDaRegra ? "regra_especial" : orientacao?.projeto_texto ? "orientacao_da_gerencia" : centroPelaRegra ? "regra_do_operador" : legenda?.projeto_texto ? "mensagem_da_foto" : contexto.projeto?.origem || null,
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
    if (!politica?.cartao && regraCartao) politica = { cartao: regraCartao.valor, origem: "regra_do_operador" };
    if (!politica?.cartao && projetoAchado?.cartao) politica = { cartao: projetoAchado.cartao, origem: "cartao_do_centro_de_custo" };
    const fontePolitica = politica?.origem === "cartao_do_centro_de_custo" ? "o cartão cadastrado no centro de custo" : "a orientação da gerência para o projeto";
    // A regra do operador e so o padrao: o que ele declarar na mensagem vale sem conflito.
    if (declaradoPag?.cartao && politica?.cartao && declaradoPag.cartao !== politica.cartao && politica.origem !== "regra_do_operador") {
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

    // Reembolso e Pix de alguem vao na DESCRICAO da nota, nao na do anexo
    // (orientacao do Yan, 25/10/2026): "ALMOÇO - 4 PESSOAS - REEMBOLSO ALMIR",
    // "45,34L od - OVN1505 - PAGO PIX MURILLO".
    const complemento = complementoDePagamento({ legenda, pagamento: campos.pagamento, nomeOperador: pessoa?.nome || identificacao?.sugestao?.nome || null });
    if (complemento) {
        if (complemento.pendencia) pendencias.push(complemento.pendencia);
        campos.descricao = { ...(campos.descricao || {}), valor: comComplemento(campos.descricao?.valor, complemento.texto), complemento: complemento.texto };
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

/** "REEMBOLSO ALMIR" / "PAGO PIX MURILLO" para o fim da descricao. */
function complementoDePagamento({ legenda, pagamento, nomeOperador }) {
    const maiusculo = (texto) => normalizar(texto).toUpperCase();
    if (legenda?.reembolso) {
        return nomeOperador ? { texto: `REEMBOLSO ${maiusculo(nomeOperador)}` }
            : { texto: "REEMBOLSO", pendencia: "Reembolso sem o operador identificado: complete a descrição com o nome de quem pagou." };
    }
    if (pagamento?.forma === "PIX") {
        // "Pix pago por Murillo" (pagador lido junto) ou "Pix - pago por Murillo" (ficou nas observacoes).
        const solto = (legenda?.observacoes || []).map((o) => String(o).match(/^\s*pago\s+(?:por|pelo|pela)\s+([A-Za-zÀ-ÿ ]{2,30})$/i)?.[1]).find(Boolean);
        const pagador = String(pagamento.pagador || solto || "").replace(/^\s*pago\s+(?:por|pelo|pela)?\s*/i, "").trim();
        return { texto: pagador ? `PAGO PIX ${maiusculo(pagador)}` : "PAGO PIX" };
    }
    return null;
}

function comComplemento(valor, complemento) {
    if (!complemento) return valor || null;
    if (!valor) return complemento;
    return normalizar(valor).toUpperCase().endsWith(normalizar(complemento).toUpperCase()) ? valor : `${valor} - ${complemento}`;
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

// Valor por pessoa que faz sentido em cada refeicao (min-max) e o tipico para estimar.
// Tirado das notas aprovadas com pessoas confirmadas (26/10/2026): mediana jantar R$ 31,
// almoco R$ 40, cafe R$ 15, lanche R$ 6-18. Faixa larga: so corrige o que e claramente errado.
const VALOR_POR_PESSOA = {
    CAFE_DA_MANHA: { min: 4, max: 40, tipico: 15 },
    ALMOCO: { min: 15, max: 100, tipico: 40 },
    JANTAR: { min: 12, max: 80, tipico: 31 },
    LANCHE: { min: 3, max: 60, tipico: 15 },
};

/** "CHAVE ALAVANCA ON/OFF/ON 10A 12 6A" -> "CHAVE ALAVANCA"; "VV.TS LAMPADA H4 12V" -> "LAMPADA H4". */
function nomeCurtoDoItem(descricao) {
    const palavras = String(descricao || "").toUpperCase().replace(/[×*]/g, " X ").replace(/\s+/g, " ").trim().split(" ");
    const ehCodigo = (p) => /^\d+$/.test(p) || /[/\\]/.test(p) || /\d.*\d/.test(p) && p.length >= 3 || /^\d+([.,]\d+)?(MM|M|CM|KG|G|ML|L|LT|V|A|W|MTS|MT)$/.test(p) || /\./.test(p);
    while (palavras.length && ehCodigo(palavras[0])) palavras.shift();
    const nome = [];
    for (const p of palavras) {
        if (ehCodigo(p) || nome.length >= 3) break;
        nome.push(p);
    }
    return nome.join(" ") || null;
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

/**
 * Numeros colados a unidade de litros: "32,350 L", "32.350LT", "32 350 L"
 * (virgula lida como espaco), "32,350\nL X R$ 6,64" (unidade na linha de
 * baixo), "LITROS: 32,350". Devolve todos; quem decide e a conta com o valor.
 */
function litrosJuntoDoL(texto) {
    const t = String(texto || "");
    const candidatos = [];
    const somar = (inteiro, decimais) => {
        const numero = Number(decimais ? `${inteiro}.${decimais}` : inteiro);
        if (Number.isFinite(numero) && numero >= 1 && numero <= 300 && !candidatos.includes(numero)) candidatos.push(numero);
    };
    const UNIDADE = String.raw`(?:L|LT|LTS|LITROS?)(?![A-Za-zÀ-ÿ])`;
    // Numero (com virgula, ponto ou espaco no lugar da virgula) antes da unidade, na mesma linha ou na de baixo.
    for (const m of t.matchAll(new RegExp(String.raw`(?<![\d.,])(\d{1,3})(?:[.,]|[ \t]+)(\d{2,3})[ \t]*\r?\n?[ \t]*${UNIDADE}`, "gi"))) somar(m[1], m[2]);
    for (const m of t.matchAll(new RegExp(String.raw`(?<![\d.,])(\d{1,3})[ \t]*\r?\n?[ \t]*${UNIDADE}`, "gi"))) somar(m[1], null);
    // Rotulo antes do numero: "LITROS: 32,350", "QTD LT 32,350".
    for (const m of t.matchAll(/(?:LITROS?|LTS?|QTDE?\.?\s*(?:LT|L)?)\s*[:=]?\s*(\d{1,3})[.,](\d{2,3})(?![\d])/gi)) somar(m[1], m[2]);
    return candidatos;
}

/**
 * Confere os litros pela conta litros × preco por litro = valor da nota (±2%).
 * Se nao bater, procura o numero colado ao "L"/"LT" que bate; depois a conta
 * com os precos impressos; por fim valor ÷ preco (pede confirmacao).
 * @returns {{litros:number|null, mudou:boolean, como?:string, preco?:number, confirmar?:boolean}}
 */
function conferirLitros({ litros, valor, valores = null, precoItem = null, texto = "" }) {
    // Valores que a conta pode fechar: o da linha do combustivel e o total da nota
    // (qualquer um dos dois pode vir mal lido). O primeiro e o preferido.
    const alvos = [...new Set((valores || [valor]).map(Number).filter((v) => v > 0))];
    if (!alvos.length) return { litros, mudou: false };
    valor = alvos[0];
    const precosTexto = [...String(texto).matchAll(/(?<![\d.,])([3-9][.,]\d{2,3})(?![\d.,])/g)].map((m) => Number(m[1].replace(",", "."))).filter((p) => p >= 3 && p < 10);
    const precos = [...new Set([Number(precoItem) > 0 ? Number(precoItem) : null, ...precosTexto].filter(Boolean))];
    if (!precos.length) return { litros, mudou: false };
    const bate = (q) => precos.flatMap((p) => alvos.map((v) => ({ p, erro: Math.abs(q * p - v) / v }))).filter((x) => x.erro <= 0.02).sort((a, b) => a.erro - b.erro)[0] || null;
    if (Number(litros) > 0 && bate(Number(litros))) return { litros, mudou: false };
    for (const candidato of litrosJuntoDoL(texto)) {
        const achou = bate(candidato);
        if (achou) return { litros: candidato, mudou: true, como: "numero_junto_do_L", preco: achou.p };
    }
    for (const alvo of alvos) {
        const pelaConta = litrosPelaConta(texto, alvo);
        if (pelaConta?.origem === "conta_litros_x_preco") return { litros: pelaConta.litros, mudou: true, como: "conta_litros_x_preco", preco: pelaConta.preco };
    }
    const dividido = precos.length === 1 ? Math.round((valor / precos[0]) * 1000) / 1000 : null;
    if (dividido >= 1 && dividido <= 300) return { litros: dividido, mudou: true, como: "valor_dividido_pelo_preco", preco: precos[0], confirmar: true };
    return { litros, mudou: false, confirmar: Number(litros) > 0 };
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
    // Almoco, jantar e cafe ficam SEMPRE na categoria do proprio tipo, inclusive no
    // administrativo (9 correcoes do Yan, 21-24/10/2026: "se e almoco, a categoria e almoco").
    if (["ALMOCO", "JANTAR", "CAFE_DA_MANHA"].includes(tipo)) return null;
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
    descricaoAbastecimento, descricaoRefeicao, litrosBr, milharBr, TIPOS, comComplemento, complementoDePagamento,
    TIPO_ANEXO_FISCAL, TIPO_ANEXO_OUTROS, conferirLitros, litrosJuntoDoL,
};
