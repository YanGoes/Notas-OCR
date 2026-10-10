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
    if (!(Number(litros) > 0) || !(Number(odometro) > 0) || !placa) return null;
    return `${litrosBr(litros)}L od ${milharBr(odometro)} - ${cadastros.placaCanonica(placa)}`;
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
const RESTAURANTES = ["restaurante", "lanchonete", "churrascaria", "pizzaria", "padaria", "panificadora", "confeitaria",
    "cafeteria", "bar", "self service", "marmitaria", "pastelaria", "hamburgueria", "lanches", "grill", "buffet"];
const HOTEIS = ["hotel", "hoteis", "pousada", "hostel", "motel", "hospedagem", "flat", "apart hotel"];
const MERCADOS = ["supermercado", "supermercados", "mercado", "mercearia", "atacadao", "atacadista", "hipermercado", "minimercado"];

function textoDoEstabelecimento(ocr) {
    return [ocr?.fornecedor, ocr?.nome_fantasia].filter(Boolean).join(" ");
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
    if (COMBUSTIVEIS.some((termo) => contemTermo(itens, termo)) || (temLitros && contemTermo(estabelecimento, "posto"))
        || ocr?.tipo_despesa_sugerido === "combustivel" || combustivelNoTexto) {
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
    if (contemTermo(estabelecimento, "pedagio") || contemTermo(ocr?.texto_bruto, "praca de pedagio")) {
        return { tipo: "PEDAGIO", origem: "estabelecimento_da_nota" };
    }
    if (contemTermo(estabelecimento, "estacionamento")) return { tipo: "ESTACIONAMENTO", origem: "estabelecimento_da_nota" };
    if (RESTAURANTES.some((termo) => contemTermo(estabelecimento, termo)) || ocr?.tipo_despesa_sugerido === "alimentacao") {
        return { tipo: "REFEICAO", origem: "estabelecimento_da_nota" };
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
        const conflito = daNota && daNota.tipo !== daLegenda && !(ehRefeicao(daNota.tipo) && ehRefeicao(daLegenda));
        if (conflito) {
            const decisao = daNota.tipo === "REFEICAO" ? subtipoRefeicao(ocr, lote, daNota.origem) : daNota;
            return { ...decisao, pendencia: `A mensagem diz ${daLegenda.toLowerCase()}, mas a nota indica ${daNota.tipo.toLowerCase()}; confirme o tipo.` };
        }
        if (daLegenda === "REFEICAO") return subtipoRefeicao(ocr, lote, "legenda_da_foto");
        return { tipo: daLegenda, origem: "legenda_da_foto" };
    }
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
    const maior = Math.max(...pratos.map((item) => {
        const quantidade = Number(item.quantidade);
        // Quantidade fracionada (kg de self-service) nao conta pessoa: vale 1.
        return Number.isInteger(quantidade) && quantidade > 0 && quantidade <= 20 ? quantidade : 1;
    }));
    return maior >= 1 ? { valor: maior, origem: "itens_da_nota" } : null;
}

function decidirPessoas({ tipo, legenda, lote, ocr = null }) {
    if (legenda?.pessoas?.quantidade) return { valor: legenda.pessoas.quantidade, origem: "mensagem_da_foto", confirmado: true };
    const declarado = lote?.quantidades?.pessoas;
    if (declarado?.quantidade && (!declarado.tipo || declarado.tipo === tipo)) {
        return { valor: declarado.quantidade, origem: "cabecalho_do_lote", confirmado: true };
    }
    const qtdLote = (lote?.quantidades?.refeicoes_e_tipos || []).find((item) => item.tipo === tipo);
    if (qtdLote) {
        // "Qtd 3 almoço": pode ser 3 pessoas ou 3 notas. Vira estimativa a confirmar.
        return { valor: qtdLote.quantidade, origem: "quantidade_do_lote_semantica_indeterminada", confirmado: false };
    }
    const pelaNota = pessoasPelaNota(ocr, tipo);
    if (pelaNota) return { ...pelaNota, confirmado: false };
    return { valor: null, origem: null, confirmado: false };
}

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
function montarPrevia({ ocr = null, legenda = {}, contexto = {}, politica = null, identificacao = {}, cad, regras = {}, hoje = new Date(), modelo }) {
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

    // Valor: sempre o da nota
    const valorNota = Number(ocr?.valor) > 0 ? Number(ocr.valor) : null;
    campos.valor = { valor: valorNota, origem: valorNota ? "nota" : null };
    const declarado = legenda?.valor_declarado ?? null;
    if (!valorNota) {
        pendencias.push(ocr ? "Valor total não foi lido com segurança na nota." : "Valor sem comprovante para confirmar.");
        if (declarado) campos.valor.sugestao = { valor: declarado, origem: "mensagem" };
    } else if (declarado && centavos(declarado) !== centavos(valorNota)) {
        avisos.push(`Valor da mensagem (R$ ${declarado.toFixed(2)}) difere da nota (R$ ${valorNota.toFixed(2)}); vale o da nota.`);
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
    const tipo = decisaoTipo.tipo;
    campos.tipo = { valor: tipo, origem: decisaoTipo.origem };
    if (ocr?.hora) campos.hora_da_nota = { valor: ocr.hora, origem: "nota", uso: "somente_pista" };

    // Fornecedor
    const fornecedor = cadastros.resolverFornecedor(cad, ocr?.fornecedor || ocr?.nome_fantasia, tipo);
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
        const veiculo = placaLida ? cadastros.resolverVeiculo(cad, placaLida) : null;
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
        const faltando = [!litros && "litros", !odometro && "hodômetro", !placaLida && !ocr?.placa_bruta && "placa"].filter(Boolean);
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
        const pessoas = decidirPessoas({ tipo, legenda, lote, ocr });
        campos.pessoas = pessoas;
        if (!pessoas.valor) pendencias.push(`Quantidade de pessoas ${tipo === "HOSPEDAGEM" ? "hospedadas" : "da refeição"} não informada.`);
        else if (pessoas.origem === "itens_da_nota") {
            pendencias.push(`${pessoas.valor} ${pessoas.valor === 1 ? "pessoa estimada" : "pessoas estimadas"} pelos itens da nota; confirme.`);
        } else if (pessoas.origem === "hospedes_na_nota") {
            pendencias.push(`${pessoas.valor} hóspede(s) segundo a nota; confirme.`);
        } else if (!pessoas.confirmado) {
            pendencias.push(`"Qtd ${pessoas.valor}" no lote pode ser pessoas ou notas; confirme quantas pessoas.`);
        }
        descricao = { valor: descricaoRefeicao(tipo, pessoas.valor), origem: "template_refeicao", estimada: !pessoas.confirmado };
    } else if (tipo === "MERCADO") {
        pendencias.push("Compra em mercado: defina se é despesa de campo ou administrativa (categoria).");
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
        else if (!descricao) {
            const citado = [...(legenda?.observacoes || []), ...(lote?.quantidades?.itens || []).map((item) => item.descricao)][0];
            descricao = { valor: citado ? String(citado).toUpperCase() : null, origem: citado ? "mensagem_do_operador" : null };
            pendencias.push(citado ? "Descrição proposta a partir da mensagem; confirme o texto." : "Descrição sem template para este tipo; defina o texto.");
        }
    }
    campos.descricao = descricao;

    // Projeto / centro de custo: regra especial > legenda da foto > contexto do operador
    const projetoInformado = legenda?.projeto_texto || contexto.projeto?.texto || null;
    const projetoTexto = centroDaRegra || projetoInformado;
    if (centroDaRegra && projetoInformado && normalizar(projetoInformado) !== normalizar(centroDaRegra)) {
        avisos.push(`Centro de custo da regra especial (${centroDaRegra}) prevaleceu sobre o projeto do operador (${projetoInformado}).`);
    }
    const resolucao = projetoTexto ? cadastros.resolverProjeto(cad, projetoTexto, pessoa) : null;
    const projetoAchado = resolucao?.projeto || null;
    campos.centro_custo = {
        texto_informado: projetoTexto,
        origem: centroDaRegra ? "regra_especial" : legenda?.projeto_texto ? "mensagem_da_foto" : contexto.projeto?.origem || null,
        nome: projetoAchado ? cadastros.nomeCentro(projetoAchado) : null,
        projeto: projetoAchado?.nome_oficial || null,
        id: resolucao?.status === "RESOLVIDO" ? projetoAchado.id_conta_azul || null : null,
        status: resolucao?.status || "NAO_INFORMADO",
        candidatos: (resolucao?.candidatos || []).map((projeto) => projeto.nome_oficial),
    };
    if (!projetoTexto) pendencias.push("Projeto/centro de custo não informado pelo operador.");
    else if (resolucao.status === "RESOLVIDO") {
        if (!resolucao.projeto.id_conta_azul) pendencias.push(`Projeto "${resolucao.projeto.nome_oficial}" sem ID do Conta Azul; sincronize os centros de custo.`);
        if (resolucao.projeto.ativo !== true) pendencias.push(`Projeto "${resolucao.projeto.nome_oficial}" ainda não confirmado como ativo.`);
    } else if (resolucao.status === "INATIVO") {
        pendencias.push(`"${projetoTexto}" corresponde a projeto inativo${projetoAchado ? ` (${projetoAchado.nome_oficial})` : ""}; confirme o centro de custo.`);
    } else {
        const opcoes = campos.centro_custo.candidatos.length ? ` Possíveis: ${campos.centro_custo.candidatos.join(" | ")}.` : "";
        pendencias.push(`Projeto "${projetoTexto}" não corresponde exatamente a um projeto cadastrado.${opcoes}`);
    }

    // Pagamento
    const declaradoPag = legenda?.pagamento || lote?.pagamento || null;
    const origemDeclarado = legenda?.pagamento ? "mensagem_da_foto" : lote?.pagamento ? "cabecalho_do_lote" : null;
    let pagamento = null;
    if (declaradoPag?.cartao && politica?.cartao && declaradoPag.cartao !== politica.cartao) {
        pendencias.push(`Cartão informado (${declaradoPag.rotulo}) diverge da orientação da gerência para o projeto (${politica.cartao}).`);
        pagamento = { forma: declaradoPag.forma, cartao: declaradoPag.cartao, origem: origemDeclarado, conflito_com_politica: politica };
    } else if (declaradoPag) {
        pagamento = { forma: declaradoPag.forma, cartao: declaradoPag.cartao, origem: origemDeclarado };
        if (!declaradoPag.cartao && politica?.cartao) avisos.push(`Pagamento excepcional declarado (${declaradoPag.rotulo}) num projeto com orientação de cartão ${politica.cartao}.`);
    } else if (politica?.cartao) {
        const cartao = cad.cartoes.find((item) => item.codigo === politica.cartao);
        pagamento = { forma: cartao?.forma_pagamento || "CARTAO_CREDITO", cartao: politica.cartao, origem: "orientacao_da_gerencia" };
    }
    if (pagamento?.cartao) {
        const cartao = cad.cartoes.find((item) => item.codigo === pagamento.cartao);
        pagamento.rotulo = cartao?.rotulo || pagamento.cartao;
        pagamento.conta_id = cartao?.conta_conta_azul_id || null;
    }
    campos.pagamento = pagamento || { forma: null, cartao: null, origem: null };
    if (!pagamento) {
        const impresso = ocr?.forma_pagamento ? ` (o cupom indica ${ocr.forma_pagamento}, mas isso não decide)` : "";
        pendencias.push(`Forma/conta de pagamento não informada${impresso}.`);
    } else if (ocr?.forma_pagamento && pagamento.forma && ocr.forma_pagamento !== pagamento.forma) {
        avisos.push(`O cupom indica ${ocr.forma_pagamento}; prevaleceu o pagamento informado (${pagamento.rotulo || pagamento.forma}).`);
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
    montarPrevia, decidirTipo, decidirPessoas, refeicaoPeloHorario,
    descricaoAbastecimento, descricaoRefeicao, litrosBr, milharBr, TIPOS,
    TIPO_ANEXO_FISCAL, TIPO_ANEXO_OUTROS,
};
