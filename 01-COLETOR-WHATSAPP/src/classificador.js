"use strict";

const fs = require("fs");
const path = require("path");
const { normalizar } = require("./legenda");
const { resolverRefeicao } = require("./refeicao");
const { resolverHospedagem } = require("./hospedagem");

const RAIZ = path.resolve(__dirname, "..");
function ler(nome) { return JSON.parse(fs.readFileSync(path.join(RAIZ, "configuracao", nome), "utf8")); }

function localizar(lista, informado, campos = ["nome", "apelidos"]) {
    const alvo = normalizar(informado);
    if (!alvo) return null;
    const candidatos = lista.filter((item) => campos.some((campo) => {
        const valores = Array.isArray(item[campo]) ? item[campo] : [item[campo]];
        return valores.filter(Boolean).some((valor) => normalizar(valor) === alvo);
    }));
    return candidatos.length === 1 ? candidatos[0] : null;
}

function categoriaEspecificaDoVeiculo(veiculo, categorias) {
    const id = veiculo?.categoria_id;
    if (!id || String(id).startsWith("PREENCHER_")) return null;
    return categorias.find((item) => String(item.id) === String(id)) || {
        nome: veiculo.categoria_nome_conta_azul || veiculo.nome || veiculo.placa,
        id,
    };
}

function textoCompletoOcr(ocr = {}) {
    return normalizar([
        ocr.produto_principal,
        ocr.nome_fantasia,
        ocr.fornecedor,
        ocr.texto_bruto,
        ...(ocr.itens || []).flatMap((item) => [item?.descricao, item?.unidade]),
    ].filter(Boolean).join(" "));
}

function contemExpressao(textoNormalizado, expressao) {
    const termo = normalizar(expressao);
    return Boolean(termo) && (` ${textoNormalizado} `).includes(` ${termo} `);
}

function evidenciaHospedagem(textoNormalizado) {
    // "Diária" sozinha também aparece em pagamentos de mão de obra. Para classificar
    // sem legenda, exige um termo inequivocamente ligado a acomodação.
    return /\b(?:hotel|hoteis|pousada|pousadas|hospedagem|hospedagens|pernoite|pernoites|quarto|quartos|apto|apartamento)\b/.test(textoNormalizado);
}

function evidenciaForteCombustivel(ocr = {}) {
    const texto = textoCompletoOcr(ocr);
    const itens = Array.isArray(ocr.itens) ? ocr.itens : [];
    const produtoExplicito = /\b(?:gasolina|etanol|diesel|combustivel|oleo\s+diesel)\b/.test(texto);
    const produtoNoItem = itens.some((item) => /\b(?:gasolina|etanol|diesel|combustivel|s10)\b/.test(normalizar(item?.descricao)));
    const litros = Number(ocr.litragem) > 0 || itens.some((item) => (
        /^(?:l|lt|litro|litros)$/.test(normalizar(item?.unidade)) && Number(item?.quantidade) > 0
    ));
    const contextoPosto = /\b(?:posto|bomba|abastec(?:imento|er|ido|ida))\b/.test(texto);
    return Boolean(produtoNoItem || (produtoExplicito && (litros || contextoPosto)));
}

function classificar(operador, ocr = {}) {
    const regras = ler("regras.json");
    const categorias = ler("categorias.json");
    const centros = ler("centros_custo.json");
    const veiculos = ler("veiculos.json");
    const tipo = normalizar(operador.tipo_despesa);
    const proibido = regras.tipos_proibidos.some((x) => tipo.includes(normalizar(x)));
    const permitidoLegenda = regras.tipos_permitidos.find((x) => x.apelidos.some((a) => normalizar(a) === tipo));
    const permitidoSemanticoAzure = regras.tipos_permitidos.find((x) => x.nome === normalizar(ocr.tipo_despesa_sugerido));
    const textoOcr = textoCompletoOcr(ocr);
    const prioridadeOcr = ["combustivel", "hospedagem", "farmacia", "manutencao", "alimentacao", "deslocamento", "material"];
    const permitidoOcr = prioridadeOcr.map((nome) => regras.tipos_permitidos.find((x) => x.nome === nome)).filter(Boolean)
        .find((regra) => regra.nome === "hospedagem"
            ? evidenciaHospedagem(textoOcr)
            : regra.apelidos.some((apelido) => contemExpressao(textoOcr, apelido)));
    const combustivelForte = evidenciaForteCombustivel(ocr);
    const permitidoCombustivelForte = combustivelForte
        ? regras.tipos_permitidos.find((regra) => regra.nome === "combustivel")
        : null;
    // Evidencia fiscal forte de combustivel vence o rótulo genérico "Meal" do Azure.
    // Nos demais casos, a legenda continua sendo a escolha principal, mas qualquer conflito
    // com o documento fica registrado e obrigatoriamente segue para revisão.
    const permitidoDocumento = permitidoCombustivelForte || permitidoOcr || permitidoSemanticoAzure || null;
    const permitido = permitidoCombustivelForte || permitidoLegenda || permitidoOcr || permitidoSemanticoAzure || null;
    const tipoConflito = permitidoLegenda && permitidoDocumento && permitidoLegenda.nome !== permitidoDocumento.nome
        ? { legenda: permitidoLegenda.nome, documento: permitidoDocumento.nome }
        : null;
    const centro = localizar(centros, operador.centro_custo_informado);
    const veiculoInformado = operador.veiculo_informado || ocr.placa;
    let veiculo = localizar(veiculos, veiculoInformado, ["nome", "placa", "apelidos"]);
    if (!veiculo && ocr.placa) veiculo = { nome: ocr.placa, placa: ocr.placa, apelidos: [], categoria_id: null, origem: "ocr" };
    let categoria = permitido ? localizar(categorias, permitido.categoria) : null;
    if (permitido?.exige_veiculo && veiculo) categoria = categoriaEspecificaDoVeiculo(veiculo, categorias) || categoria;
    const refeicao = permitido?.nome === "alimentacao"
        ? resolverRefeicao({
            hora: ocr.hora,
            horasAlternativas: ocr.hora_candidatos,
            horaOrigem: ocr.hora_origem,
            legenda: [operador.tipo_despesa, operador.observacao].filter(Boolean).join(" "),
            pessoas: operador.pessoas,
            faixas: regras.refeicao?.faixas,
        })
        : null;
    if (refeicao?.categoria) categoria = localizar(categorias, refeicao.categoria) || categoria;
    const hospedagem = permitido?.nome === "hospedagem"
        ? resolverHospedagem({
            pessoas: operador.pessoas,
            diarias: operador.diarias,
            ocr,
            legenda: [operador.tipo_despesa, operador.observacao].filter(Boolean).join(" "),
            config: regras.hospedagem,
        })
        : null;
    const origemCombustivel = permitidoCombustivelForte && permitidoOcr?.nome === "combustivel"
        ? "texto_ocr_azure"
        : permitidoCombustivelForte ? "evidencia_forte_ocr" : null;
    return {
        refeicao,
        hospedagem,
        escopo_proibido: proibido,
        tipo_reconhecido: permitido || null,
        tipo_origem: origemCombustivel || (permitidoLegenda ? "legenda" : permitidoOcr ? "texto_ocr_azure" : permitidoSemanticoAzure ? "tipo_recibo_azure" : null),
        tipo_detectado_documento: permitidoDocumento?.nome || null,
        tipo_origem_documento: permitidoCombustivelForte
            ? "evidencia_forte_ocr"
            : permitidoOcr ? "texto_ocr_azure" : permitidoSemanticoAzure ? "tipo_recibo_azure" : null,
        tipo_conflito: tipoConflito,
        evidencia_combustivel_forte: combustivelForte,
        categoria_nome: categoria?.nome || null,
        categoria_id: categoria?.id || null,
        centro_custo_nome: centro?.nome || null,
        centro_custo_id: centro?.id || null,
        veiculo: veiculo || null,
    };
}

module.exports = {
    classificar, localizar, categoriaEspecificaDoVeiculo, evidenciaForteCombustivel,
    evidenciaHospedagem, contemExpressao, textoCompletoOcr,
};
