"use strict";

// Motor alternativo de criacao financeira direta, trazido da branch
// refeicoes-hospedagem-conta-azul. Ele NAO substitui a Captura: a API publica
// nao vincula fornecedor, imagem/anexo, conta financeira nem baixa neste POST.

const { requisicao } = require("./conta-azul");

const CAMINHO = "/v1/financeiro/eventos-financeiros/contas-a-pagar";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dataIso(valor) {
    const texto = String(valor || "").trim();
    let partes;
    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) partes = texto.split("-").map(Number);
    else {
        const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto);
        if (!br) return null;
        partes = [Number(br[3]), Number(br[2]), Number(br[1])];
    }
    const [ano, mes, dia] = partes;
    const data = new Date(Date.UTC(ano, mes - 1, dia));
    if (data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== dia) return null;
    return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function numeroPositivo(valor) {
    let texto = String(valor ?? "").trim();
    if (texto.includes(",")) texto = texto.replace(/\./g, "").replace(",", ".");
    texto = texto.replace(/[^\d.-]/g, "");
    const numero = Number(texto);
    return Number.isFinite(numero) && numero > 0 ? Number(numero.toFixed(2)) : null;
}

function centavos(valor) {
    const numero = numeroPositivo(valor);
    return numero === null ? null : Math.round(numero * 100);
}

function uuidValido(id) {
    return UUID.test(String(id || "").trim()) && !String(id).startsWith("PREENCHER_");
}

function montarDespesa({
    descricao,
    valor,
    data,
    idCategoria,
    idCentroCusto,
    idContato = null,
    idContaFinanceira = null,
    observacao = null,
    nota = null,
    permitirSemCentro = false,
} = {}) {
    const competencia = dataIso(data);
    const bruto = numeroPositivo(valor);
    const texto = String(descricao || "").trim();
    if (!texto) throw new Error("Descricao obrigatoria.");
    if (!competencia) throw new Error(`Data invalida: ${data}. Use uma data real em AAAA-MM-DD ou DD/MM/AAAA.`);
    if (bruto === null) throw new Error(`Valor invalido: ${valor}.`);
    if (!uuidValido(idCategoria)) throw new Error("UUID da categoria ausente ou invalido.");
    if (!idCentroCusto && !permitirSemCentro) throw new Error("Centro de custo obrigatorio para o lancamento direto.");
    if (idCentroCusto && !uuidValido(idCentroCusto)) throw new Error("UUID do centro de custo ausente ou invalido.");
    if (idContato && !uuidValido(idContato)) throw new Error("UUID do contato/fornecedor invalido.");
    if (idContaFinanceira && !uuidValido(idContaFinanceira)) throw new Error("UUID da conta financeira invalido.");

    const descricaoFinal = texto.slice(0, 255);
    const observacaoFinal = String(observacao || "").trim().slice(0, 500) || null;
    const notaFinal = String(nota || observacaoFinal || descricaoFinal).trim().slice(0, 500);
    const rateio = { id_categoria: String(idCategoria), valor: bruto };
    if (idCentroCusto) {
        rateio.rateio_centro_custo = [{ id_centro_custo: String(idCentroCusto), valor: bruto }];
    }
    const parcela = {
        data_vencimento: competencia,
        descricao: descricaoFinal,
        nota: notaFinal,
        detalhe_valor: {
            valor_bruto: bruto,
            valor_liquido: bruto,
            desconto: 0,
            taxa: 0,
            multa: 0,
            juros: 0,
        },
    };
    if (idContaFinanceira) parcela.conta_financeira = String(idContaFinanceira);

    const corpo = {
        descricao: descricaoFinal,
        valor: bruto,
        data_competencia: competencia,
        condicao_pagamento: {
            tipo: "A_VISTA",
            parcelas: [parcela],
        },
        rateio: [rateio],
    };
    if (idContato) corpo.contato = String(idContato);
    if (idContaFinanceira) corpo.conta_financeira = String(idContaFinanceira);
    if (observacaoFinal) corpo.observacao = observacaoFinal;
    return corpo;
}

function idEmpresa(empresa) {
    return String(empresa?.id_empresa || empresa?.id || "").trim();
}

async function criarDespesa(dados, { empresaEsperadaId, requisicaoFn = requisicao } = {}) {
    const esperada = String(empresaEsperadaId || "").trim();
    if (!esperada) throw new Error("Informe a empresa confirmada antes do lancamento direto.");
    const empresa = await requisicaoFn("/v1/pessoas/conta-conectada");
    if (!idEmpresa(empresa) || idEmpresa(empresa) !== esperada) {
        throw new Error("A empresa conectada nao corresponde a empresa confirmada para o lancamento direto.");
    }
    const corpo = montarDespesa(dados);
    const resposta = await requisicaoFn(CAMINHO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
    });
    return {
        protocolo: String(resposta?.protocolo || resposta?.protocolId || "").trim() || null,
        status: resposta?.status || null,
        empresa_id: esperada,
        enviado: corpo,
        resposta,
    };
}

function listaDaResposta(resposta) {
    for (const chave of ["itens", "content", "dados", "data", "results"]) {
        if (Array.isArray(resposta?.[chave])) return resposta[chave];
    }
    return Array.isArray(resposta) ? resposta : [];
}

function idsUnicos(lista, chaves) {
    return [...new Set((Array.isArray(lista) ? lista : []).map((item) => {
        for (const chave of chaves) {
            const valor = String(item?.[chave] || "").trim();
            if (valor) return valor;
        }
        return null;
    }).filter(Boolean))];
}

function validarDetalheDespesa(detalhe, esperado = {}) {
    const motivos = [];
    const evento = detalhe?.evento || {};
    const rateios = Array.isArray(evento.rateio) ? evento.rateio : [];
    const protocolo = String(evento?.referencia?.id || "").trim();
    if (!esperado.protocolo || protocolo !== String(esperado.protocolo)) motivos.push("Protocolo do evento nao confere.");
    if (evento.tipo !== "DESPESA") motivos.push("O evento localizado nao e uma despesa.");
    if (dataIso(evento.data_competencia) !== dataIso(esperado.data)) motivos.push("Data de competencia nao confere.");
    if (centavos(detalhe?.valor_composicao?.valor_bruto) !== centavos(esperado.valor)) motivos.push("Valor bruto nao confere.");

    const categorias = idsUnicos(rateios, ["id_categoria", "id"]);
    if (categorias.length !== 1 || categorias[0] !== String(esperado.idCategoria || "")) {
        motivos.push("Categoria do rateio nao confere.");
    }
    const totalCategorias = rateios.reduce((total, rateio) => {
        const valor = centavos(rateio?.valor_bruto ?? rateio?.valor);
        return valor === null ? Number.NaN : total + valor;
    }, 0);
    if (totalCategorias !== centavos(esperado.valor)) motivos.push("Valor distribuido na categoria nao confere.");
    const centros = rateios.flatMap((rateio) => Array.isArray(rateio.rateio_centro_custo) ? rateio.rateio_centro_custo : []);
    const idsCentros = idsUnicos(centros, ["id_centro_custo", "id"]);
    if (esperado.idCentroCusto && (idsCentros.length !== 1 || idsCentros[0] !== String(esperado.idCentroCusto))) {
        motivos.push("Centro de custo do rateio nao confere.");
    }
    const totalCentros = centros.reduce((total, centro) => {
        const valor = centavos(centro?.valor_bruto ?? centro?.valor);
        return valor === null ? Number.NaN : total + valor;
    }, 0);
    if (esperado.idCentroCusto && totalCentros !== centavos(esperado.valor)) {
        motivos.push("Valor distribuido no centro de custo nao confere.");
    }
    return { valido: motivos.length === 0, motivos, protocolo: protocolo || null };
}

async function confirmarDespesa(dados = {}, { requisicaoFn = requisicao } = {}) {
    const dia = dataIso(dados.data);
    if (!dia) throw new Error(`Data invalida para conferencia: ${dados.data}.`);
    if (!String(dados.protocolo || "").trim()) throw new Error("Protocolo obrigatorio para uma conferencia inequivoca.");
    const busca = await requisicaoFn(`${CAMINHO}/buscar?data_vencimento_de=${dia}&data_vencimento_ate=${dia}&tamanho_pagina=200`);
    const itens = listaDaResposta(busca);
    const alvo = String(dados.descricao || "").trim().toLowerCase();
    const bruto = centavos(dados.valor);
    const candidatos = itens.filter((item) => {
        const texto = String(item?.descricao || "").trim().toLowerCase();
        const valores = [item?.total, item?.valor, item?.valor_total, item?.nao_pago]
            .map(centavos).filter((valor) => valor !== null);
        return valores.includes(bruto) && (!alvo || texto === alvo);
    });

    const avaliacoes = [];
    for (const item of candidatos) {
        let detalhe;
        try {
            detalhe = await requisicaoFn(`/v1/financeiro/eventos-financeiros/parcelas/${encodeURIComponent(item.id)}`);
        } catch (erro) {
            avaliacoes.push({ parcela_id: item.id || null, valido: false, motivos: [`Falha ao consultar detalhe: ${erro.message}`] });
            continue;
        }
        const avaliacao = validarDetalheDespesa(detalhe, dados);
        avaliacoes.push({ parcela_id: item.id || null, detalhe, ...avaliacao });
    }
    const validos = avaliacoes.filter((item) => item.valido);
    return {
        confirmado: validos.length === 1,
        ambiguo: validos.length > 1,
        lancamento: validos.length === 1 ? candidatos.find((item) => String(item.id) === String(validos[0].parcela_id)) : null,
        detalhe: validos.length === 1 ? validos[0].detalhe : null,
        avaliacoes,
        encontrados_no_dia: itens.length,
        candidatos: candidatos.length,
        resposta: busca,
    };
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ESPERAS = [3000, 5000, 8000, 15000, 30000, 30000];

async function confirmarComEspera(dados, { esperas = ESPERAS, aoTentar, confirmarFn = confirmarDespesa } = {}) {
    let ultima = { confirmado: false, encontrados_no_dia: 0 };
    for (let i = 0; i < esperas.length; i += 1) {
        await esperar(esperas[i]);
        ultima = await confirmarFn(dados);
        if (aoTentar) aoTentar(i + 1, esperas.length, ultima);
        if (ultima.confirmado) return { ...ultima, tentativas: i + 1 };
        if (ultima.ambiguo) return { ...ultima, tentativas: i + 1 };
    }
    return { ...ultima, tentativas: esperas.length };
}

module.exports = {
    montarDespesa,
    criarDespesa,
    confirmarDespesa,
    confirmarComEspera,
    validarDetalheDespesa,
    dataIso,
    numeroPositivo,
    uuidValido,
    CAMINHO,
};
