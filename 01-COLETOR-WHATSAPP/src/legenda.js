"use strict";

const aliases = {
    tipo_despesa: ["tipo", "despesa", "tipo de despesa"],
    centro_custo_informado: ["centro", "centro de custo", "cc", "projeto", "obra"],
    veiculo_informado: ["veiculo", "veículo", "placa"],
    conta_informada: ["conta", "cartao", "cartão", "conta/cartao", "conta/cartão"],
    pessoas: ["pessoas", "quantidade de pessoas", "qtd pessoas"],
    observacao: ["observacao", "observação", "obs"],
    valor_informado: ["valor"],
};

function normalizar(texto) {
    return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// Placa antiga (ABC1234) ou Mercosul (ABC1D23), com ou sem hifen/espaco.
const PADRAO_PLACA = "([A-Za-z]{3})[-\\s]?([0-9][A-Za-z0-9][0-9]{2})";

/**
 * Le a placa escrita na legenda mesmo sem o formato "Veiculo: X".
 * O operador escreve "Placa JKM0I96", "placa: abc1d23" ou so a placa solta —
 * todos precisam funcionar, porque e assim que ele digita no campo.
 */
function placaDaLegenda(texto) {
    const bruto = String(texto || "");
    const rotulada = bruto.match(new RegExp(`\\b(?:placa|ve[ií]culo|carro)\\s*:?\\s*${PADRAO_PLACA}\\b`, "i"));
    if (rotulada) return `${rotulada[1]}${rotulada[2]}`.toUpperCase();
    const solta = bruto.match(new RegExp(`\\b${PADRAO_PLACA}\\b`));
    return solta ? `${solta[1]}${solta[2]}`.toUpperCase() : null;
}

function interpretarLegenda(texto) {
    const resultado = {
        tipo_despesa: null, centro_custo_informado: null, veiculo_informado: null,
        conta_informada: null, pessoas: null, observacao: null, valor_informado: null,
        // Legenda inteira, para o classificador procurar o tipo da despesa em
        // texto livre (o operador raramente escreve "Tipo: ...").
        texto_livre: String(texto || "").trim() || null,
    };
    const mapa = new Map();
    for (const [campo, nomes] of Object.entries(aliases)) for (const nome of nomes) mapa.set(normalizar(nome), campo);
    for (const linha of String(texto || "").split(/\r?\n/)) {
        const match = linha.match(/^\s*([^:]+)\s*:\s*(.+?)\s*$/);
        if (!match) continue;
        const campo = mapa.get(normalizar(match[1]));
        if (!campo) continue;
        resultado[campo] = match[2].trim();
    }
    if (!resultado.tipo_despesa) {
        const linhasLivres = String(texto || "").split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean);
        if (linhasLivres.length === 1 && !linhasLivres[0].includes(":")) resultado.tipo_despesa = linhasLivres[0];
    }
    if (resultado.valor_informado) {
        const numero = resultado.valor_informado.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
        resultado.valor_informado = Number.isFinite(Number(numero)) ? Number(numero) : null;
    }
    if (resultado.pessoas) resultado.pessoas = Number(resultado.pessoas.replace(/\D/g, "")) || null;
    // Placa escrita solta na legenda, sem o rotulo "Veiculo:".
    if (!resultado.veiculo_informado) resultado.veiculo_informado = placaDaLegenda(texto);
    return resultado;
}

module.exports = { interpretarLegenda, normalizar, placaDaLegenda };
