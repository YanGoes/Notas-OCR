"use strict";

const { requisicao } = require("./conta-azul");

const CAMINHO = "/v1/financeiro/eventos-financeiros/contas-a-pagar";

function dataIso(valor) {
    const texto = String(valor || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return texto;
    const br = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return br ? `${br[3]}-${br[2]}-${br[1]}` : null;
}

function centavos(valor) {
    const numero = Number(valor);
    return Number.isFinite(numero) && numero > 0 ? Number(numero.toFixed(2)) : null;
}

function idUsavel(id) {
    return Boolean(id) && !String(id).startsWith("PREENCHER_");
}

// Nomes conferidos contra a API em 03/08/2026; ver API-CONTA-AZUL.md.
// Cuidado: a escrita exige "detalhe_valor", a leitura devolve "valor_composicao".
function montarDespesa({ descricao, valor, data, idCategoria, idCentroCusto } = {}) {
    const competencia = dataIso(data);
    const bruto = centavos(valor);
    const texto = String(descricao || "").trim();
    if (!texto) throw new Error("Descricao obrigatoria.");
    if (!competencia) throw new Error(`Data invalida: ${data}. Use AAAA-MM-DD ou DD/MM/AAAA.`);
    if (bruto === null) throw new Error(`Valor invalido: ${valor}.`);
    if (!idUsavel(idCategoria)) throw new Error("id da categoria ausente ou ainda com placeholder PREENCHER_.");
    if (idCentroCusto !== undefined && idCentroCusto !== null && !idUsavel(idCentroCusto)) {
        throw new Error("id do centro de custo ainda com placeholder PREENCHER_.");
    }
    const rateio = { id_categoria: idCategoria, valor: bruto };
    // O centro de custo mora dentro do rateio e e uma lista, nao um id solto.
    if (idCentroCusto) rateio.rateio_centro_custo = [{ id_centro_custo: idCentroCusto, valor: bruto }];
    return {
        descricao: texto.slice(0, 255),
        valor: bruto,
        data_competencia: competencia,
        condicao_pagamento: {
            tipo: "A_VISTA",
            parcelas: [{
                data_vencimento: competencia,
                // A descricao que aparece na listagem e no export e a DA PARCELA, nao a do evento:
                // a do evento nao volta em nenhum endpoint. Por isso o mesmo texto nos dois lugares.
                descricao: texto.slice(0, 255),
                detalhe_valor: { valor_bruto: bruto, valor_liquido: bruto, desconto: 0, taxa: 0, multa: 0, juros: 0 },
            }],
        },
        rateio: [rateio],
    };
}

async function criarDespesa(dados) {
    const corpo = montarDespesa(dados);
    const resposta = await requisicao(CAMINHO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
    });
    return { protocolo: resposta?.protocolo || null, status: resposta?.status || null, enviado: corpo, resposta };
}

function listaDaResposta(resposta) {
    for (const chave of ["itens", "content", "dados", "data", "results"]) {
        if (Array.isArray(resposta?.[chave])) return resposta[chave];
    }
    return Array.isArray(resposta) ? resposta : [];
}

// "PENDING" so diz que entrou na fila. A API aceita e descarta em silencio (categoria
// inexistente, por exemplo), entao nunca confie no protocolo: confira na busca.
//
// A busca devolve PARCELAS, nao eventos: o valor vem em "total" e a descricao e a da parcela.
// Passando o protocolo, a conferencia vira exata — ele reaparece em evento.referencia.id no
// detalhe da parcela, que e o unico lugar onde da para amarrar o POST ao registro criado.
async function confirmarDespesa({ data, descricao, valor, protocolo } = {}) {
    const dia = dataIso(data);
    if (!dia) throw new Error(`Data invalida para conferencia: ${data}.`);
    const busca = await requisicao(`${CAMINHO}/buscar?data_vencimento_de=${dia}&data_vencimento_ate=${dia}&tamanho_pagina=200`);
    const itens = listaDaResposta(busca);
    const alvo = String(descricao || "").trim().toLowerCase();
    const bruto = centavos(valor);
    const candidatos = itens.filter((item) => {
        const texto = String(item?.descricao || "").trim().toLowerCase();
        const valores = [item?.total, item?.valor, item?.valor_total, item?.nao_pago].map(centavos).filter((x) => x !== null);
        const valorBate = bruto === null || valores.some((x) => Math.abs(x - bruto) < 0.01);
        return valorBate && (!alvo || texto === alvo);
    });
    if (!protocolo) {
        const achado = candidatos[0] || null;
        return { confirmado: Boolean(achado), lancamento: achado, encontrados_no_dia: itens.length, resposta: busca };
    }
    for (const item of candidatos) {
        const detalhe = await requisicao(`/v1/financeiro/eventos-financeiros/parcelas/${encodeURIComponent(item.id)}`).catch(() => null);
        if (detalhe?.evento?.referencia?.id === protocolo) {
            return { confirmado: true, lancamento: item, detalhe, encontrados_no_dia: itens.length, resposta: busca };
        }
    }
    return { confirmado: false, lancamento: null, encontrados_no_dia: itens.length, resposta: busca };
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fila e lenta e irregular: medido em 07/08/2026, quase tudo aparece em ~3 s, mas um
// lancamento levou mais de um minuto. Desistir cedo faz concluir "descartado" o que so
// estava atrasado — e ai a tentacao e relancar, criando duplicata que nao da para apagar.
const ESPERAS = [3000, 5000, 8000, 15000, 30000, 30000];

async function confirmarComEspera(dados, { esperas = ESPERAS, aoTentar } = {}) {
    let ultima = { confirmado: false, encontrados_no_dia: 0 };
    for (let i = 0; i < esperas.length; i += 1) {
        await esperar(esperas[i]);
        ultima = await confirmarDespesa(dados);
        if (aoTentar) aoTentar(i + 1, esperas.length, ultima);
        if (ultima.confirmado) return { ...ultima, tentativas: i + 1 };
    }
    return { ...ultima, tentativas: esperas.length };
}

module.exports = { montarDespesa, criarDespesa, confirmarDespesa, confirmarComEspera, dataIso, CAMINHO };
