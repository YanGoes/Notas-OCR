"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { litragemDoOcr } = require("./detalhes-despesa");

function hashArquivo(arquivo) { return crypto.createHash("sha256").update(fs.readFileSync(arquivo)).digest("hex"); }
function chaveFiscal(ocr) {
    const valor = Number(ocr.valor);
    return [ocr.cnpj || "", ocr.data || "", Number.isFinite(valor) && valor > 0 ? valor.toFixed(2) : "0.00"].join("|");
}
function idValido(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || ""));
}

function validar({ operador, ocr, classificacao, regras, duplicado }) {
    const motivos = [];
    let bloqueado = false;
    if (classificacao.escopo_proibido) { motivos.push("Despesa fora do escopo permitido."); bloqueado = true; }
    if (duplicado) { motivos.push("Possivel documento duplicado."); bloqueado = true; }
    if (!operador.tipo_despesa && !classificacao.tipo_reconhecido) motivos.push("Tipo da despesa ausente e nao identificado no comprovante.");
    if (!operador.centro_custo_informado) motivos.push("Centro de custo nao informado na legenda nem configurado como padrao do grupo.");
    if (!classificacao.tipo_reconhecido && !classificacao.escopo_proibido) motivos.push("Tipo de despesa nao reconhecido.");
    if (classificacao.tipo_conflito) {
        motivos.push(`Tipo informado na legenda (${classificacao.tipo_conflito.legenda}) diverge do tipo identificado no comprovante (${classificacao.tipo_conflito.documento}).`);
    }
    if (!idValido(classificacao.categoria_id) && !classificacao.escopo_proibido) motivos.push(classificacao.categoria_nome
        ? `Categoria ${classificacao.categoria_nome} reconhecida, mas o ID do Conta Azul ainda nao foi configurado.`
        : "Categoria nao identificada ou sem mapeamento no Conta Azul.");
    if (operador.centro_custo_informado && !idValido(classificacao.centro_custo_id) && !classificacao.escopo_proibido) motivos.push("Centro de custo informado nao foi encontrado no mapeamento do Conta Azul.");
    if (classificacao.tipo_reconhecido?.nome === "combustivel") {
        if (!(classificacao.veiculo?.placa || ocr.placa)) motivos.push("Placa do veiculo nao identificada no comprovante nem na legenda.");
        if (!litragemDoOcr(ocr)) motivos.push("Litragem do abastecimento nao identificada no comprovante.");
    } else if (classificacao.tipo_reconhecido?.exige_veiculo && !classificacao.veiculo) motivos.push("Veiculo obrigatorio, ausente ou nao reconhecido.");
    if (classificacao.tipo_reconhecido?.nome === "alimentacao") {
        const refeicao = classificacao.refeicao || {};
        // Sem a hora impressa não é seguro separar café, almoço, lanche e jantar.
        if (!refeicao.hora) motivos.push("Horario nao identificado no comprovante; periodo da refeicao nao confirmado.");
        else if (refeicao.hora_ambigua) motivos.push(`O comprovante possui horarios que caem em periodos diferentes (${refeicao.horas_candidatas.join(", ")}); confirme o periodo da refeicao.`);
        else if (refeicao.divergente) motivos.push(`Periodo pelo horario (${refeicao.hora} = ${refeicao.periodo}) diverge do informado na legenda (${refeicao.periodo_legenda}).`);
    }
    if (classificacao.tipo_reconhecido?.nome === "hospedagem") {
        const hospedagem = classificacao.hospedagem || {};
        // "Diaria" também pode significar pagamento de mão de obra; nunca deve virar hotel automaticamente.
        if (hospedagem.freelancer) {
            motivos.push("Menciona freelancer/mao de obra: pode ser 'DIARIA - FREELANCER', nao hospedagem.");
            bloqueado = true;
        }
        if (!hospedagem.diarias) motivos.push("Quantidade de diarias nao informada na legenda nem identificada no documento.");
        if (hospedagem.diarias_divergentes) {
            motivos.push(`Quantidade de diarias da legenda (${hospedagem.diarias}) diverge do documento (${hospedagem.diarias_documento}).`);
        }
        if (hospedagem.valor && !hospedagem.valor.coerente) {
            motivos.push(`Valor R$ ${Number(ocr.valor).toFixed(2)} nao fecha com ${hospedagem.pessoas} pessoa(s) x ${hospedagem.diarias} diaria(s); esperado por volta de R$ ${hospedagem.valor.esperado.toFixed(2)}.`);
        }
    }
    if (classificacao.tipo_reconhecido?.sempre_revisar) motivos.push("Tipo 'outros' exige revisao humana obrigatoria.");
    if (ocr.erro_leitura) motivos.push(`Leitura automatica inconclusiva: ${ocr.erro_leitura}`);
    if (!Number.isFinite(Number(ocr.valor)) || Number(ocr.valor) <= 0) motivos.push("Valor nao identificado com seguranca pelo OCR.");
    if (!ocr.data) motivos.push("Data nao identificada pelo OCR.");
    if (Number(ocr.confianca || 0) < Number(regras.confianca_minima)) motivos.push("Confianca do OCR abaixo do minimo; requer leitura humana.");
    const divergencia = operador.valor_informado !== null && ocr.valor !== null
        ? Math.abs(Number(operador.valor_informado) - Number(ocr.valor)) : 0;
    if (divergencia > Number(regras.tolerancia_valor)) motivos.push("Valor da legenda diverge do comprovante.");
    return {
        escopo_permitido: !classificacao.escopo_proibido,
        valor_confere: divergencia <= Number(regras.tolerancia_valor),
        duplicado: Boolean(duplicado),
        confianca_suficiente: Number(ocr.confianca || 0) >= Number(regras.confianca_minima),
        bloqueado,
        revisao_necessaria: !bloqueado && motivos.length > 0,
        motivos,
    };
}

module.exports = { hashArquivo, chaveFiscal, validar, idValido };
