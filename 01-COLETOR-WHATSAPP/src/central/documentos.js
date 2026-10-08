"use strict";

// =============================================================================
// DOCUMENTOS DENTRO DE UMA FOTO
// =============================================================================
//
// Regras da VMac:
//   - uma foto com DUAS notas de compras diferentes = DUAS despesas, ambas com
//     a mesma foto anexada;
//   - cupom fiscal + via da maquininha da MESMA compra = UMA despesa (o segundo
//     papel e evidencia, nao despesa nova);
//   - a mesma nota fotografada de novo = nenhuma despesa nova.
//
// O Azure (prebuilt-receipt) devolve um item em `documents` para cada recibo
// que ele separa na imagem. Cada um e normalizado com o texto do proprio trecho.
// =============================================================================

const { normalizarResultadoAzure, chaveNfeValida } = require("../azure-ocr");
const { normalizar, centavos, somenteDigitos } = require("./texto");

/** Texto do documento a partir dos `spans` que o Azure aponta no conteudo total. */
function textoDoDocumento(conteudo, documento) {
    const spans = Array.isArray(documento?.spans) ? documento.spans : [];
    if (!spans.length) return conteudo;
    return spans.map((span) => conteudo.slice(span.offset, span.offset + span.length)).join("\n");
}

const RE_VIA_PAGAMENTO = /\bvia\s+(?:do\s+)?(?:cliente|estabelecimento|portador)\b|\bcomprovante\s+de\s+(?:pagamento|venda|transa[cç][aã]o)\b|\b(?:nsu|aut(?:orizacao|oriza[cç][aã]o)?|cv|doc)\s*[:.]\s*\d/i;

/** O papel e so o comprovante da maquininha (sem itens, sem chave fiscal)? */
function pareceViaDePagamento(ocr) {
    const semItens = !(ocr.itens || []).length;
    return Boolean(semItens && !ocr.chave_fiscal && RE_VIA_PAGAMENTO.test(String(ocr.texto_bruto || "")));
}

/** Quanto de informacao fiscal o documento tem (para escolher o principal). */
function pesoFiscal(ocr) {
    return (ocr.chave_fiscal ? 4 : 0) + (ocr.cnpj ? 2 : 0) + Math.min((ocr.itens || []).length, 3) + (ocr.fornecedor ? 1 : 0);
}

/**
 * Normaliza a resposta bruta do Azure em 1..N documentos.
 * @returns {Array<{indice:number, ocr:object, papel:'PRINCIPAL'|'COMPLEMENTAR', principal_indice:number|null}>}
 */
function dividirDocumentos(bruto, modelId = "prebuilt-receipt") {
    const analise = bruto?.analyzeResult || {};
    const documentos = Array.isArray(analise.documents) ? analise.documents : [];
    const conteudo = String(analise.content || "");

    const lidos = documentos.length <= 1
        ? [normalizarResultadoAzure(bruto, modelId)]
        : documentos.map((documento) => normalizarResultadoAzure({
            ...bruto,
            analyzeResult: { ...analise, content: textoDoDocumento(conteudo, documento), documents: [documento] },
        }, modelId));

    const resultado = lidos.map(({ resposta_bruta: _bruta, ...ocr }, indice) => ({
        indice, ocr, papel: "PRINCIPAL", principal_indice: null,
    }));

    // Mesma compra em dois papeis: mesmo valor e mesma data (ou data ausente em um).
    for (const atual of resultado) {
        if (atual.papel !== "PRINCIPAL") continue;
        for (const outro of resultado) {
            if (outro === atual || outro.papel !== "PRINCIPAL") continue;
            const mesmoValor = centavos(atual.ocr.valor) !== null && centavos(atual.ocr.valor) === centavos(outro.ocr.valor);
            const datasCompativeis = !atual.ocr.data || !outro.ocr.data || atual.ocr.data === outro.ocr.data;
            if (!mesmoValor || !datasCompativeis) continue;
            if (!pareceViaDePagamento(atual.ocr) && !pareceViaDePagamento(outro.ocr)) continue;
            const [principal, complementar] = pesoFiscal(atual.ocr) >= pesoFiscal(outro.ocr) ? [atual, outro] : [outro, atual];
            complementar.papel = "COMPLEMENTAR";
            complementar.principal_indice = principal.indice;
        }
    }
    return resultado;
}

/** Chave NFC-e/NF-e de 44 digitos valida (identidade forte do documento). */
function chaveNfce(ocr) {
    const chave = somenteDigitos(ocr?.chave_fiscal);
    return chave.length === 44 && chaveNfeValida(chave) ? chave : null;
}

/**
 * Impressao digital "fraca" do documento: emissor + data + valor + hora.
 * Igualdade gera POSSIVEL duplicidade (revisao), nunca bloqueio automatico:
 * dois colegas almocando no mesmo lugar podem gastar o mesmo valor.
 */
function impressaoDigital(ocr) {
    const valor = centavos(ocr?.valor);
    if (!ocr?.data || !valor) return null;
    const emissor = somenteDigitos(ocr.cnpj) || normalizar(ocr.fornecedor) || "sem-emissor";
    return [emissor, ocr.data, valor, ocr.hora || "sem-hora"].join("|");
}

module.exports = { dividirDocumentos, pareceViaDePagamento, chaveNfce, impressaoDigital, textoDoDocumento };
