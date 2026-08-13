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

/** Placa comparavel: so letras e numeros, em caixa alta (SGR-4B54 = sgr4b54). */
function normalizarPlaca(valor) {
    return String(valor || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Encontra o veiculo cadastrado a partir da placa lida, aceitando os dois
 * padroes (antigo ABC1234 e Mercosul ABC1D23) e ignorando hifen, espaco e
 * caixa. O OCR devolve "SGR-4B54"; o cadastro costuma ter "SGR4B54" ou
 * "FIAT SCUDO - SGR4B54" — todos precisam casar.
 */
function localizarVeiculo(veiculos, informado) {
    const direto = localizar(veiculos, informado, ["nome", "placa", "apelidos"]);
    if (direto) return direto;

    const alvo = normalizarPlaca(informado);
    if (alvo.length !== 7) return null;
    const candidatos = veiculos.filter((item) => [item.placa, item.nome, ...(item.apelidos || [])]
        .filter(Boolean)
        .some((valor) => normalizarPlaca(valor).includes(alvo)));
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

    // O operador quase nunca escreve "Tipo: Abastecimento" — escreve
    // "Abastecimento CONSOL MG-050" ou so "Janta". Procura o tipo dentro da
    // legenda inteira, respeitando a mesma ordem de prioridade do OCR.
    const textoLegenda = normalizar(operador.texto_livre);
    // Ordem de desempate quando o texto casa com mais de um tipo. Os tipos
    // especificos de refeicao vem ANTES de "alimentacao": escrevendo "almoco",
    // a despesa tem que ir para "Refeição - Almoço", nao para a categoria
    // generica de lanches.
    const ordemTipos = [
        "combustivel", "hospedagem", "farmacia", "manutencao", "pedagio", "estacionamento",
        "almoco", "jantar", "cafe", "alimentacao", "deslocamento", "material",
    ];
    const porOrdem = (busca) => ordemTipos
        .map((nome) => regras.tipos_permitidos.find((x) => x.nome === nome))
        .filter(Boolean)
        .find((regra) => regra.apelidos.some((apelido) => busca.includes(normalizar(apelido))));
    const permitidoLegendaTexto = !permitidoLegenda && textoLegenda ? porOrdem(textoLegenda) : null;

    // O NOME DO ESTABELECIMENTO e a pista mais forte depois da legenda: "HOTEL
    // DECK RIO" e hospedagem, mesmo que o Azure classifique o recibo como
    // "Meal" por causa do restaurante interno. O tipo semantico do Azure so
    // distingue refeicao/combustivel, entao nao pode vencer o nome.
    const textoFornecedor = normalizar([ocr.fornecedor, ocr.nome_fantasia].filter(Boolean).join(" "));
    const permitidoFornecedor = !permitidoLegenda && !permitidoLegendaTexto && textoFornecedor
        ? porOrdem(textoFornecedor)
        : null;

    const permitidoSemanticoAzure = regras.tipos_permitidos.find((x) => x.nome === normalizar(ocr.tipo_despesa_sugerido));
    const textoOcr = normalizar([ocr.produto_principal, ocr.nome_fantasia, ocr.texto_bruto].filter(Boolean).join(" "));
    const permitidoOcr = porOrdem(textoOcr);
    const permitido = permitidoLegenda || permitidoLegendaTexto || permitidoFornecedor || permitidoSemanticoAzure || permitidoOcr || null;
    const centro = localizar(centros, operador.centro_custo_informado);
    const veiculoInformado = operador.veiculo_informado || ocr.placa;
    let veiculo = localizarVeiculo(veiculos, veiculoInformado);
    // Placa lida (na legenda ou no comprovante) que ainda nao esta cadastrada
    // em veiculos.json: vale como identificacao, mesmo sem categoria propria.
    if (!veiculo && veiculoInformado) {
        veiculo = {
            nome: veiculoInformado, placa: veiculoInformado, apelidos: [], categoria_id: null,
            origem: operador.veiculo_informado ? "legenda" : "ocr",
        };
    }
    let categoria = permitido ? localizar(categorias, permitido.categoria) : null;
    if (permitido?.exige_veiculo && veiculo) categoria = categoriaEspecificaDoVeiculo(veiculo, categorias) || categoria;
    return {
        escopo_proibido: proibido,
        tipo_reconhecido: permitido || null,
        tipo_origem: permitidoLegenda ? "legenda"
            : permitidoLegendaTexto ? "legenda_texto_livre"
                : permitidoFornecedor ? "nome_do_estabelecimento"
                    : permitidoSemanticoAzure ? "tipo_recibo_azure"
                        : permitidoOcr ? "texto_ocr_azure" : null,
        categoria_nome: categoria?.nome || null,
        categoria_id: categoria?.id || null,
        centro_custo_nome: centro?.nome || null,
        centro_custo_id: centro?.id || null,
        veiculo: veiculo || null,
    };
}

module.exports = { classificar, localizar, localizarVeiculo, normalizarPlaca, categoriaEspecificaDoVeiculo };
