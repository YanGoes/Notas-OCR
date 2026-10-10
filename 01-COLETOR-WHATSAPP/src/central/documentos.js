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

// ---------------------------------------------------------------------------
// Duas notas LADO A LADO na mesma foto
// ---------------------------------------------------------------------------
//
// O Azure as vezes devolve um unico documento com o texto das duas notas
// intercalado (uma linha de cada coluna). Usando a POSICAO de cada linha na
// foto, separa em colunas quando:
//   - existe uma faixa vertical no meio da foto que quase nenhuma linha cruza;
//   - cada lado tem um pedaco grande do texto;
//   - o texto tem sinais de DUAS notas (dois "documento auxiliar"/DANFE/NFC-e
//     ou duas chaves de acesso diferentes).

const RE_CABECALHO_NOTA = /documento\s+aux|danfe|nfc-?e\b|cupom\s+fiscal|nota\s+fiscal/gi;

function centroELimites(poligono) {
    const xs = [poligono[0], poligono[2], poligono[4], poligono[6]];
    const ys = [poligono[1], poligono[3], poligono[5], poligono[7]];
    return { x0: Math.min(...xs), x1: Math.max(...xs), y: ys.reduce((a, b) => a + b, 0) / 4 };
}

function quantasNotasNoTexto(texto) {
    const cabecalhos = (String(texto).match(RE_CABECALHO_NOTA) || []).length;
    const chaves = new Set();
    for (const achado of String(texto).matchAll(/\b(?:\d{4}[\t ]*){10}\d{4}\b|\b\d{44}\b/g)) {
        const digitos = somenteDigitos(achado[0]);
        if (digitos.length === 44 && chaveNfeValida(digitos)) chaves.add(digitos);
    }
    return { cabecalhos, chaves: chaves.size };
}

/**
 * Texto de cada coluna, ou null quando a foto nao tem notas lado a lado.
 * @returns {null | string[]}
 */
function colunasDaFoto(analise) {
    const pagina = analise?.pages?.[0];
    const linhas = (pagina?.lines || []).filter((linha) => Array.isArray(linha.polygon) && linha.polygon.length >= 8 && linha.content);
    if (!pagina?.width || linhas.length < 20) return null;
    const sinais = quantasNotasNoTexto(analise.content || "");
    if (sinais.chaves < 2 && sinais.cabecalhos < 2) return null;

    const caixas = linhas.map((linha) => ({ ...centroELimites(linha.polygon), texto: linha.content }));
    const largura = pagina.width;
    let melhor = null;
    for (let corte = largura * 0.3; corte <= largura * 0.7; corte += largura / 100) {
        const cruzam = caixas.filter((c) => c.x0 < corte && c.x1 > corte).length;
        const esquerda = caixas.filter((c) => c.x1 <= corte).length;
        const direita = caixas.filter((c) => c.x0 >= corte).length;
        if (!melhor || cruzam < melhor.cruzam) melhor = { corte, cruzam, esquerda, direita };
    }
    const total = caixas.length;
    if (!melhor || melhor.cruzam > total * 0.06 || melhor.esquerda < total * 0.25 || melhor.direita < total * 0.25) return null;

    const lado = (filtro) => caixas.filter(filtro).sort((a, b) => a.y - b.y).map((c) => c.texto).join("\n");
    const colunas = [lado((c) => (c.x0 + c.x1) / 2 < melhor.corte), lado((c) => (c.x0 + c.x1) / 2 >= melhor.corte)];
    // Cada coluna precisa parecer uma nota sozinha.
    if (colunas.some((texto) => quantasNotasNoTexto(texto).cabecalhos < 1 && quantasNotasNoTexto(texto).chaves < 1)) return null;
    return colunas;
}

/**
 * Normaliza a resposta bruta do Azure em 1..N documentos.
 * @returns {Array<{indice:number, ocr:object, papel:'PRINCIPAL'|'COMPLEMENTAR', principal_indice:number|null}>}
 */
function dividirDocumentos(bruto, modelId = "prebuilt-receipt") {
    const analise = bruto?.analyzeResult || {};
    const documentos = Array.isArray(analise.documents) ? analise.documents : [];
    const conteudo = String(analise.content || "");

    const colunas = documentos.length <= 1 ? colunasDaFoto(analise) : null;
    const lidos = colunas
        // Lado a lado: cada coluna e lida pelo texto (os campos estruturados do
        // Azure misturavam as duas notas e nao servem).
        ? colunas.map((texto, i) => ({
            ...normalizarResultadoAzure({ analyzeResult: { content: texto, documents: [{ docType: documentos[0]?.docType, fields: {} }] } }, modelId),
            separada_da_foto: { metodo: "colunas_lado_a_lado", coluna: i === 0 ? "esquerda" : "direita", total: colunas.length },
        }))
        : documentos.length <= 1
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

module.exports = { dividirDocumentos, colunasDaFoto, pareceViaDePagamento, chaveNfce, impressaoDigital, textoDoDocumento };
