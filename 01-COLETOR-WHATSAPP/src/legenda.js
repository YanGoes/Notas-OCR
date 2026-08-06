"use strict";

const aliases = {
    tipo_despesa: ["tipo", "despesa", "tipo de despesa"],
    centro_custo_informado: ["centro", "centro de custo", "cc"],
    veiculo_informado: ["veiculo", "veículo", "placa"],
    conta_informada: ["conta", "cartao", "cartão", "conta/cartao", "conta/cartão"],
    pessoas: ["pessoas", "quantidade de pessoas", "qtd pessoas"],
    observacao: ["observacao", "observação", "obs"],
    valor_informado: ["valor"],
};

function normalizar(texto) {
    return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function interpretarLegenda(texto) {
    const resultado = {
        tipo_despesa: null, centro_custo_informado: null, veiculo_informado: null,
        conta_informada: null, pessoas: null, observacao: null, valor_informado: null,
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
    return resultado;
}

module.exports = { interpretarLegenda, normalizar };
