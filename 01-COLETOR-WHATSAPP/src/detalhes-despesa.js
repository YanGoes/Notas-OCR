"use strict";

function litragemDoOcr(ocr = {}) {
    if (Number(ocr.litragem) > 0) return Number(ocr.litragem);
    const item = (ocr.itens || []).find((x) => /^(l|lt|litro|litros)$/i.test(String(x.unidade || "").trim()) && Number(x.quantidade) > 0);
    return item ? Number(item.quantidade) : null;
}

function numeroBr(valor, casas = 3) {
    return Number(valor).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: casas });
}

function dadosAbastecimento(ocr = {}, classificacao = {}) {
    const tipo = classificacao.tipo_reconhecido?.nome || classificacao.tipo;
    if (tipo !== "combustivel") return null;
    const item = (ocr.itens || []).find((x) => Number(x.quantidade) > 0) || ocr.itens?.[0] || {};
    return {
        placa: classificacao.veiculo?.placa || classificacao.placa || ocr.placa || null,
        litragem: litragemDoOcr(ocr),
        unidade: item.unidade || "L",
        combustivel: item.descricao || ocr.produto_principal || null,
        valor_unitario: item.valor_unitario ?? null,
        quilometragem: ocr.quilometragem ?? null,
    };
}

const ROTULO_PAGAMENTO = {
    DINHEIRO: "Dinheiro",
    CARTAO_DEBITO: "Cartao de debito",
    CARTAO_CREDITO: "Cartao de credito",
    PIX: "Pix",
    BOLETO: "Boleto",
    TRANSFERENCIA: "Transferencia",
};

function rotuloFormaPagamento(pagamento) {
    if (!pagamento?.codigo) return null;
    const rotulo = ROTULO_PAGAMENTO[pagamento.codigo] || pagamento.codigo;
    return pagamento.conta_cartao ? `${rotulo} (${pagamento.conta_cartao})` : rotulo;
}

function descricaoContaAzul({ legenda, ocr = {}, classificacao = {}, pagamento = null }) {
    const dados = dadosAbastecimento(ocr, classificacao);
    const partes = [String(legenda || classificacao.tipo_reconhecido?.nome || classificacao.tipo || "Despesa").trim()];
    const formaPagamento = rotuloFormaPagamento(pagamento);
    if (formaPagamento && !/conta\/cart|pagamento/i.test(String(legenda || ""))) {
        partes.push(`Pagamento: ${formaPagamento}`);
    }
    if (dados) {
        if (dados.placa) partes.push(`Placa: ${dados.placa}`);
        if (dados.litragem) partes.push(`Litragem: ${numeroBr(dados.litragem)} ${dados.unidade}`);
        if (dados.combustivel) partes.push(`Produto: ${dados.combustivel}`);
        if (dados.valor_unitario) partes.push(`Unitario: R$ ${numeroBr(dados.valor_unitario, 2)}`);
        if (dados.quilometragem) partes.push(`Km: ${dados.quilometragem}`);
    }
    return partes.filter(Boolean).join(" | ").slice(0, 255);
}

module.exports = { litragemDoOcr, dadosAbastecimento, descricaoContaAzul, rotuloFormaPagamento };
