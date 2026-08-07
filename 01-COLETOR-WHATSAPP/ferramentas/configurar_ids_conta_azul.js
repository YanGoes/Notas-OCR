"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { requisicao } = require("../src/conta-azul");

const RAIZ = path.resolve(__dirname, "..");
const CONFIGURACAO = path.join(RAIZ, "configuracao");
const SAIDA = path.join(RAIZ, "dados", "conta-azul");
const TAMANHO_PAGINA = 1000;

function normalizar(valor) {
    return String(valor || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function idConfigurado(id) {
    return Boolean(id) && !String(id).startsWith("PREENCHER_");
}

function itensDaResposta(resposta) {
    if (Array.isArray(resposta)) return resposta;
    if (Array.isArray(resposta?.itens)) return resposta.itens;
    if (Array.isArray(resposta?.items)) return resposta.items;
    return [];
}

async function listarPaginado(endpoint, parametros = {}) {
    const todos = [];
    for (let pagina = 1; pagina <= 100; pagina += 1) {
        const busca = new URLSearchParams({
            pagina: String(pagina),
            tamanho_pagina: String(TAMANHO_PAGINA),
            ...parametros,
        });
        const resposta = await requisicao(`${endpoint}?${busca}`);
        const itens = itensDaResposta(resposta);
        todos.push(...itens);
        const total = Number(resposta?.itens_totais ?? resposta?.total_items ?? resposta?.total);
        if (Array.isArray(resposta) || itens.length < TAMANHO_PAGINA || (Number.isFinite(total) && todos.length >= total)) break;
    }
    return [...new Map(todos.filter((item) => item?.id).map((item) => [String(item.id), item])).values()];
}

async function consultarCatalogos() {
    // Somente GET. Esta ferramenta nunca cria, altera ou exclui dados no Conta Azul.
    const [categorias, centros] = await Promise.all([
        listarPaginado("/v1/categorias", {
            tipo: "DESPESA",
            permite_apenas_filhos: "false",
            campo_ordenado_ascendente: "NOME",
        }),
        listarPaginado("/v1/centro-de-custo", {
            filtro_rapido: "ATIVO",
            campo_ordenado_ascendente: "nome",
        }),
    ]);
    return {
        categorias: categorias.filter((item) => !item.tipo || item.tipo === "DESPESA")
            .sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR")),
        centros: centros.filter((item) => item.ativo !== false)
            .sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR")),
    };
}

function salvarCatalogos({ categorias, centros }) {
    fs.mkdirSync(SAIDA, { recursive: true });
    const gravar = (nome, itens) => fs.writeFileSync(path.join(SAIDA, nome), `${JSON.stringify(itens, null, 2)}\n`, "utf8");
    gravar("categorias-despesa.json", categorias);
    gravar("centros-custo-ativos.json", centros);
}

function lerJson(nome) {
    return JSON.parse(fs.readFileSync(path.join(CONFIGURACAO, nome), "utf8"));
}

function gravarJson(nome, dados) {
    const destino = path.join(CONFIGURACAO, nome);
    fs.copyFileSync(destino, `${destino}.bak`);
    fs.writeFileSync(destino, `${JSON.stringify(dados, null, 2)}\n`, "utf8");
}

function correspondenciaExata(itemLocal, catalogo) {
    const nomes = [itemLocal.nome_conta_azul, itemLocal.nome, ...(itemLocal.apelidos || [])]
        .map(normalizar).filter(Boolean);
    const encontrados = catalogo.filter((item) => nomes.includes(normalizar(item.nome)));
    return encontrados.length === 1 ? encontrados[0] : null;
}

function correspondenciaVeiculo(veiculo, catalogo) {
    const nomeExato = correspondenciaExata({ nome: veiculo.nome, apelidos: [] }, catalogo);
    if (nomeExato) return nomeExato;
    const placa = normalizar(veiculo.placa).replace(/\s+/g, "");
    if (!placa) return null;
    const pelaPlaca = catalogo.filter((item) => normalizar(item.nome).replace(/\s+/g, "").includes(placa));
    return pelaPlaca.length === 1 ? pelaPlaca[0] : null;
}

function mostrarLista(titulo, itens) {
    console.log(`\n${titulo} (${itens.length})`);
    console.log("-".repeat(78));
    for (const item of itens) console.log(`${String(item.nome || "(sem nome)").padEnd(46)} ${item.id}`);
}

async function escolherItem(terminal, titulo, catalogo, sugestao = null) {
    if (sugestao) {
        const resposta = (await terminal.question(`\n${titulo}\nEncontrado: ${sugestao.nome} (${sugestao.id})\nUsar este ID? [S/n]: `)).trim();
        if (!resposta || /^s(im)?$/i.test(resposta)) return sugestao;
    }
    while (true) {
        const termo = (await terminal.question(`\n${titulo}\nDigite parte do nome no Conta Azul (Enter para pular): `)).trim();
        if (!termo) return null;
        const alvo = normalizar(termo);
        const encontrados = catalogo.filter((item) => normalizar(item.nome).includes(alvo));
        if (!encontrados.length) {
            console.log("Nenhum resultado. Tente outra parte do nome.");
            continue;
        }
        if (encontrados.length > 30) {
            console.log(`Foram encontrados ${encontrados.length} itens. Digite um nome mais especifico.`);
            continue;
        }
        encontrados.forEach((item, indice) => console.log(`${indice + 1}. ${item.nome} — ${item.id}`));
        const escolha = (await terminal.question("Numero desejado (Enter para pesquisar novamente): ")).trim();
        const indice = Number(escolha) - 1;
        if (Number.isInteger(indice) && encontrados[indice]) return encontrados[indice];
    }
}

async function configurarInterativamente(catalogos) {
    const terminal = readline.createInterface({ input: stdin, output: stdout });
    try {
        const categoriasLocais = lerJson("categorias.json");
        let categoriasAlteradas = false;
        for (const categoria of categoriasLocais) {
            if (idConfigurado(categoria.id) && catalogos.categorias.some((item) => String(item.id) === String(categoria.id))) continue;
            if (idConfigurado(categoria.id)) console.log(`\nAviso: o ID salvo para ${categoria.nome} nao existe na conta conectada e sera revisado.`);
            const escolhida = await escolherItem(
                terminal,
                `Categoria local: ${categoria.nome}`,
                catalogos.categorias,
                correspondenciaExata(categoria, catalogos.categorias),
            );
            if (escolhida) {
                categoria.id = escolhida.id;
                categoria.nome_conta_azul = escolhida.nome;
                categoriasAlteradas = true;
            }
        }
        if (categoriasAlteradas) gravarJson("categorias.json", categoriasLocais);

        const respostaCentros = (await terminal.question(`\nImportar os ${catalogos.centros.length} centros de custo ATIVOS para o programa? [S/n]: `)).trim();
        if (!respostaCentros || /^s(im)?$/i.test(respostaCentros)) {
            const anteriores = lerJson("centros_custo.json");
            const porId = new Map(anteriores.filter((item) => idConfigurado(item.id)).map((item) => [String(item.id), item]));
            const centros = catalogos.centros.map((item) => ({
                nome: item.nome,
                id: item.id,
                apelidos: porId.get(String(item.id))?.apelidos || [],
            }));
            if (centros.length) gravarJson("centros_custo.json", centros);
        }

        const veiculos = lerJson("veiculos.json");
        let veiculosAlterados = false;
        for (const veiculo of veiculos) {
            if (idConfigurado(veiculo.categoria_id) && catalogos.categorias.some((item) => String(item.id) === String(veiculo.categoria_id))) continue;
            if (idConfigurado(veiculo.categoria_id)) console.log(`\nAviso: a categoria salva para ${veiculo.nome} nao existe na conta conectada e sera revisada.`);
            const escolhida = await escolherItem(
                terminal,
                `Categoria de combustivel do veiculo: ${veiculo.nome}`,
                catalogos.categorias,
                correspondenciaVeiculo(veiculo, catalogos.categorias),
            );
            if (escolhida) {
                veiculo.categoria_id = escolhida.id;
                veiculo.categoria_nome_conta_azul = escolhida.nome;
                veiculosAlterados = true;
            }
        }
        if (veiculosAlterados) gravarJson("veiculos.json", veiculos);

        console.log("\nConfiguracao local concluida. Nenhum dado foi alterado no Conta Azul.");
        console.log("Arquivos .bak foram criados antes de cada alteracao.");
    } finally {
        terminal.close();
    }
}

function aplicarCorrespondenciasExatas(catalogos) {
    const categorias = lerJson("categorias.json");
    let categoriasAlteradas = false;
    for (const item of categorias) {
        if (idConfigurado(item.id)) continue;
        const encontrada = correspondenciaExata(item, catalogos.categorias);
        if (!encontrada) continue;
        item.id = encontrada.id;
        item.nome_conta_azul = encontrada.nome;
        categoriasAlteradas = true;
    }
    if (categoriasAlteradas) gravarJson("categorias.json", categorias);

    const anteriores = lerJson("centros_custo.json");
    const porId = new Map(anteriores.filter((item) => idConfigurado(item.id)).map((item) => [String(item.id), item]));
    const centros = catalogos.centros.map((item) => ({ nome: item.nome, id: item.id, apelidos: porId.get(String(item.id))?.apelidos || [] }));
    if (centros.length) gravarJson("centros_custo.json", centros);

    const veiculos = lerJson("veiculos.json");
    let veiculosAlterados = false;
    for (const item of veiculos) {
        if (idConfigurado(item.categoria_id)) continue;
        const encontrada = correspondenciaVeiculo(item, catalogos.categorias);
        if (!encontrada) continue;
        item.categoria_id = encontrada.id;
        item.categoria_nome_conta_azul = encontrada.nome;
        veiculosAlterados = true;
    }
    if (veiculosAlterados) gravarJson("veiculos.json", veiculos);
    return { categoriasAlteradas, centrosImportados: centros.length, veiculosAlterados };
}

async function iniciar() {
    const argumentos = new Set(process.argv.slice(2));
    console.log("Consulta segura de IDs do Conta Azul (somente leitura na API).\n");
    const catalogos = await consultarCatalogos();
    salvarCatalogos(catalogos);
    console.log(`Encontradas ${catalogos.categorias.length} categorias de DESPESA e ${catalogos.centros.length} centros de custo ativos.`);
    console.log(`Catalogos salvos em: ${SAIDA}`);

    if (argumentos.has("--somente-listar")) {
        mostrarLista("CATEGORIAS DE DESPESA", catalogos.categorias);
        mostrarLista("CENTROS DE CUSTO ATIVOS", catalogos.centros);
        return;
    }
    if (argumentos.has("--automatico")) {
        const resultado = aplicarCorrespondenciasExatas(catalogos);
        console.log("Sincronizacao automatica local concluida:", resultado);
        const pendentes = lerJson("categorias.json").filter((item) => !idConfigurado(item.id)).map((item) => item.nome);
        console.log(pendentes.length
            ? `Categorias ainda pendentes: ${pendentes.join(", ")}. Use o modo interativo somente se a area financeira definir o destino correto.`
            : "Todas as categorias locais possuem ID configurado.");
        return;
    }
    await configurarInterativamente(catalogos);
}

if (require.main === module) {
    iniciar().catch((erro) => {
        console.error(`\nFalha ao consultar/configurar IDs: ${erro.message}`);
        console.error("Conecte o Conta Azul primeiro com CONECTAR_CONTA_AZUL.bat e tente novamente.");
        process.exitCode = 1;
    });
}

module.exports = { normalizar, idConfigurado, itensDaResposta, correspondenciaExata, correspondenciaVeiculo, aplicarCorrespondenciasExatas };
