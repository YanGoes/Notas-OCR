"use strict";

const fs = require("fs");
const path = require("path");
const { normalizar } = require("./legenda");

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

function classificar(operador, ocr = {}) {
    const regras = ler("regras.json");
    const categorias = ler("categorias.json");
    const centros = ler("centros_custo.json");
    const veiculos = ler("veiculos.json");
    const tipo = normalizar(operador.tipo_despesa);
    const proibido = regras.tipos_proibidos.some((x) => tipo.includes(normalizar(x)));
    const permitidoLegenda = regras.tipos_permitidos.find((x) => x.apelidos.some((a) => normalizar(a) === tipo));
    const permitidoSemanticoAzure = regras.tipos_permitidos.find((x) => x.nome === normalizar(ocr.tipo_despesa_sugerido));
    const textoOcr = normalizar([ocr.produto_principal, ocr.nome_fantasia, ocr.texto_bruto].filter(Boolean).join(" "));
    const prioridadeOcr = ["combustivel", "hospedagem", "farmacia", "manutencao", "alimentacao", "deslocamento", "material"];
    const permitidoOcr = prioridadeOcr.map((nome) => regras.tipos_permitidos.find((x) => x.nome === nome)).filter(Boolean)
        .find((regra) => regra.apelidos.some((apelido) => textoOcr.includes(normalizar(apelido))));
    const permitido = permitidoLegenda || permitidoSemanticoAzure || permitidoOcr || null;
    const centro = localizar(centros, operador.centro_custo_informado);
    const veiculoInformado = operador.veiculo_informado || ocr.placa;
    let veiculo = localizar(veiculos, veiculoInformado, ["nome", "placa", "apelidos"]);
    if (!veiculo && ocr.placa) veiculo = { nome: ocr.placa, placa: ocr.placa, apelidos: [], categoria_id: null, origem: "ocr" };
    let categoria = permitido ? localizar(categorias, permitido.categoria) : null;
    if (permitido?.exige_veiculo && veiculo) categoria = categoriaEspecificaDoVeiculo(veiculo, categorias) || categoria;
    return {
        escopo_proibido: proibido,
        tipo_reconhecido: permitido || null,
        tipo_origem: permitidoLegenda ? "legenda" : permitidoSemanticoAzure ? "tipo_recibo_azure" : permitidoOcr ? "texto_ocr_azure" : null,
        categoria_nome: categoria?.nome || null,
        categoria_id: categoria?.id || null,
        centro_custo_nome: centro?.nome || null,
        centro_custo_id: centro?.id || null,
        veiculo: veiculo || null,
    };
}

module.exports = { classificar, localizar, categoriaEspecificaDoVeiculo };
