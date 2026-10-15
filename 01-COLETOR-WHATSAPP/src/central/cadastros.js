"use strict";

// =============================================================================
// CADASTROS DA CENTRAL
// =============================================================================
//
// Pessoas, projetos, frota, cartoes e fornecedores recorrentes. Todo
// "resolver" aqui devolve tambem o STATUS da resolucao, porque a regra da VMac
// e: correspondencia exata resolve; parecido NAO resolve (vai para revisao).
// =============================================================================

const fs = require("fs");
const path = require("path");
const { normalizar, contemTermo, somenteDigitos } = require("./texto");

const PASTA_PADRAO = path.resolve(__dirname, "..", "..", "configuracao");

function lerJson(arquivo, padrao) {
    try { return fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, "utf8")) : padrao; }
    catch (erro) { throw new Error(`Cadastro invalido em ${path.basename(arquivo)}: ${erro.message}`); }
}

/**
 * Carrega todos os cadastros. `pasta` permite apontar para uma copia nos testes.
 * Le do disco a cada chamada de proposito: editar um JSON vale sem reiniciar.
 */
function carregar(pasta = PASTA_PADRAO) {
    const arquivo = (nome) => path.join(pasta, nome);
    const pessoasArquivo = fs.existsSync(arquivo("pessoas.json")) ? "pessoas.json" : "pessoas.exemplo.json";
    const cad = {
        pessoas: lerJson(arquivo(pessoasArquivo), { pessoas: [] }).pessoas || [],
        projetos: lerJson(arquivo("projetos.json"), { projetos: [] }).projetos || [],
        centros: lerJson(arquivo("centros_custo.json"), []),
        veiculos: lerJson(arquivo("veiculos.json"), []),
        cartoes: lerJson(arquivo("cartoes.json"), []),
        categorias: lerJson(arquivo("categorias.json"), []),
        fornecedores: lerJson(arquivo("fornecedores_recorrentes.json"), { recorrentes: [] }),
    };
    juntarCatalogo(cad, lerJson(arquivo("catalogo_conta_azul.json"), null));
    return cad;
}

/**
 * Tudo o que existe no Conta Azul (catalogo_conta_azul.json, tirado da
 * planilha exportada) entra nos cadastros SEM sobrescrever nada: centros e
 * categorias que o programa ainda nao conhecia aparecem com o nome exato do
 * Conta Azul e sem ID (o ID vem da API); fornecedores entram na lista de
 * opcoes. A IA so escolhe sozinha o que tem regra; o resto ela aprende com
 * as revisoes.
 */
function juntarCatalogo(cad, catalogo) {
    if (!catalogo) return;
    const conhecidos = (lista) => new Set(lista.filter(Boolean).map(normalizar));
    const centros = conhecidos(cad.centros.map((centro) => centro?.nome));
    for (const centro of catalogo.centros || []) {
        if (centros.has(normalizar(centro.nome))) continue;
        cad.centros.push({ nome: centro.nome, id: null, origem: "planilha_conta_azul", usos: centro.usos, ultimo_uso: centro.ultimo_uso });
    }
    const categorias = conhecidos([
        ...cad.categorias.flatMap((categoria) => [categoria.nome, categoria.nome_conta_azul]),
        ...cad.veiculos.flatMap((veiculo) => [veiculo.categoria_nome_conta_azul, veiculo.manutencao_categoria_nome]),
    ]);
    for (const categoria of catalogo.categorias || []) {
        if (categorias.has(normalizar(categoria.nome))) continue;
        cad.categorias.push({ nome: categoria.nome, nome_conta_azul: categoria.nome, id: null, origem: "planilha_conta_azul", usos: categoria.usos, ultimo_uso: categoria.ultimo_uso });
    }
    const fornecedores = cad.fornecedores || (cad.fornecedores = { recorrentes: [] });
    const opcoes = fornecedores.opcoes || [];
    const jaTem = conhecidos(opcoes);
    for (const fornecedor of catalogo.fornecedores || []) if (!jaTem.has(normalizar(fornecedor.nome))) opcoes.push(fornecedor.nome);
    fornecedores.opcoes = opcoes;
}

// ---------------------------------------------------------------------------
// Pessoas
// ---------------------------------------------------------------------------

/** Variantes do telefone brasileiro: com e sem o 9 extra do celular. */
function variantesTelefone(telefone) {
    const digitos = somenteDigitos(telefone);
    if (!digitos) return [];
    const variantes = new Set([digitos]);
    const semPais = digitos.startsWith("55") ? digitos.slice(2) : digitos;
    if (semPais.length === 11 && semPais[2] === "9") variantes.add(`55${semPais.slice(0, 2)}${semPais.slice(3)}`);
    if (semPais.length === 10) variantes.add(`55${semPais.slice(0, 2)}9${semPais.slice(2)}`);
    return [...variantes];
}

/**
 * Identifica a pessoa pelo id do WhatsApp. Nunca pelo nome exibido: o nome
 * so aparece como SUGESTAO para a Central confirmar o vinculo.
 *
 * @param {object} cad — cadastros carregados
 * @param {string} whatsappId — ex.: 5561999998888@s.whatsapp.net ou 1234@lid
 * @param {object} [opcoes]
 * @param {Map<string,string>} [opcoes.vinculos] — whatsapp_id -> pessoa_id confirmados
 * @param {string} [opcoes.nomeExibido]
 */
function identificarPessoa(cad, whatsappId, { vinculos = new Map(), nomeExibido = "" } = {}) {
    const id = String(whatsappId || "");
    if (vinculos.has(id)) {
        const pessoa = cad.pessoas.find((item) => item.id === vinculos.get(id));
        if (pessoa) return { status: "IDENTIFICADA", pessoa, origem: "vinculo_confirmado" };
    }
    if (id.endsWith("@s.whatsapp.net")) {
        const numero = somenteDigitos(id.split("@")[0]);
        const pessoa = cad.pessoas.find((item) => variantesTelefone(item.telefone).includes(numero));
        if (pessoa) return { status: "IDENTIFICADA", pessoa, origem: "telefone" };
    }
    const sugestao = nomeExibido
        ? cad.pessoas.find((item) => normalizar(item.nome) === normalizar(nomeExibido)
            || normalizar(nomeExibido).split(" ")[0] === normalizar(item.nome))
        : null;
    return { status: "NAO_VINCULADA", pessoa: null, sugestao: sugestao || null, origem: null };
}

// ---------------------------------------------------------------------------
// Projetos / centros de custo
// ---------------------------------------------------------------------------

function nomesDoProjeto(projeto) {
    return [projeto.nome_oficial, projeto.centro_conta_azul, ...(projeto.apelidos || [])].map(normalizar).filter(Boolean);
}

/** Nome do centro de custo no Conta Azul (pode diferir do nome no sistema de projetos). */
function nomeCentro(projeto) {
    return projeto?.centro_conta_azul || projeto?.nome_oficial || null;
}

/**
 * Junta projetos.json com os centros sincronizados do Conta Azul
 * (centros_custo.json), pelo nome do centro. Centro sincronizado que ainda nao
 * esta em projetos.json tambem entra, com `ativo: null` (precisa ser confirmado).
 */
function projetosComId(cad) {
    const porNome = new Map(cad.centros.map((centro) => [normalizar(centro.nome), centro]));
    const projetos = cad.projetos.map((projeto) => {
        let centro = porNome.get(normalizar(nomeCentro(projeto)));
        // Nome exato ainda desconhecido: aceita o UNICO centro sincronizado que contenha o trecho.
        if (!centro && !projeto.centro_conta_azul && projeto.busca_centro_conta_azul) {
            const achados = cad.centros.filter((item) => item?.nome && contemTermo(item.nome, projeto.busca_centro_conta_azul));
            if (achados.length === 1) centro = achados[0];
        }
        return {
            ...projeto,
            centro_conta_azul: projeto.centro_conta_azul || (centro && centro.nome !== projeto.nome_oficial ? centro.nome : null),
            id_conta_azul: projeto.id_conta_azul || centro?.id || null,
            apelidos: [...new Set([...(projeto.apelidos || []), ...(centro?.apelidos || [])])],
        };
    });
    const conhecidos = new Set(projetos.flatMap((projeto) => [projeto.nome_oficial, projeto.centro_conta_azul])
        .filter(Boolean).map(normalizar));
    for (const centro of cad.centros) {
        if (!centro?.nome || conhecidos.has(normalizar(centro.nome))) continue;
        projetos.push({ nome_oficial: centro.nome, id_conta_azul: centro.id || null, ativo: null, servico: null, apelidos: centro.apelidos || [],
            origem: centro.origem === "planilha_conta_azul" ? "planilha_conta_azul" : "centros_custo_sincronizados", ultimo_uso: centro.ultimo_uso || null, usos: centro.usos || null });
    }
    return projetos;
}

/**
 * Resolve o projeto citado num texto livre.
 *
 * - RESOLVIDO: o texto e exatamente o nome oficial ou um apelido de UM projeto
 *   nao inativo.
 * - AMBIGUO: mais de um projeto casa, ou so ha semelhanca parcial.
 * - INATIVO: casou exatamente com um projeto marcado como inativo.
 * - DESCONHECIDO: nada parecido.
 *
 * `pessoa.apelidos_projeto` traduz o jeito como AQUELA pessoa escreve
 * ("Goinfra G.O" do Almir = GOINFRA FWD). Tambem e correspondencia exata.
 */
function resolverProjeto(cad, texto, pessoa = null) {
    const alvo = normalizar(texto);
    if (!alvo) return { status: "DESCONHECIDO", projeto: null, candidatos: [] };
    const projetos = projetosComId(cad);
    const daPessoa = Object.entries(pessoa?.apelidos_projeto || {}).find(([apelido]) => normalizar(apelido) === alvo);
    const exatos = daPessoa
        ? projetos.filter((projeto) => nomesDoProjeto(projeto).includes(normalizar(daPessoa[1])))
        : projetos.filter((projeto) => nomesDoProjeto(projeto).includes(alvo));
    const exatosValidos = exatos.filter((projeto) => projeto.ativo !== false);
    if (exatosValidos.length === 1) return { status: "RESOLVIDO", projeto: exatosValidos[0], candidatos: [] };
    if (exatosValidos.length > 1) return { status: "AMBIGUO", projeto: null, candidatos: exatosValidos };
    if (exatos.length) return { status: "INATIVO", projeto: exatos.length === 1 ? exatos[0] : null, candidatos: exatos };

    // Semelhanca parcial (todas as palavras do texto aparecem no nome) so gera
    // SUGESTAO. "Goinfra" nao pode escolher sozinho entre FWD e VDROD.
    const parecidos = parecidosCom(projetos, alvo).filter((projeto) => projeto.ativo !== false);
    return { status: parecidos.length ? "AMBIGUO" : "DESCONHECIDO", projeto: null, candidatos: parecidos };
}

function parecidosCom(projetos, alvo) {
    const palavras = alvo.split(" ").filter((palavra) => palavra.length >= 3);
    return palavras.length ? projetos.filter((projeto) => nomesDoProjeto(projeto)
        .some((nome) => palavras.every((palavra) => contemTermo(nome, palavra)))) : [];
}

/**
 * Diz se o texto inteiro parece ser so o nome de um projeto (linha solta no
 * WhatsApp). Projetos inativos contam: a linha continua sendo o projeto do
 * operador, e a previa avisa que ele esta inativo.
 */
function pareceProjeto(cad, texto, pessoa = null) {
    const resultado = resolverProjeto(cad, texto, pessoa);
    if (resultado.status !== "DESCONHECIDO") return true;
    return parecidosCom(projetosComId(cad), normalizar(texto)).length > 0;
}

// ---------------------------------------------------------------------------
// Cartoes
// ---------------------------------------------------------------------------

/** "CRÉDITO INTER", "credito c6", "no inter" -> cartao do cadastro. */
function resolverCartao(cad, texto) {
    const conteudo = normalizar(texto);
    if (!conteudo) return null;
    const achados = cad.cartoes.filter((cartao) => [cartao.rotulo, cartao.codigo, ...(cartao.apelidos || [])]
        .some((nome) => contemTermo(conteudo, nome)));
    return achados.length === 1 ? achados[0] : null;
}

// ---------------------------------------------------------------------------
// Frota
// ---------------------------------------------------------------------------

/** Placa comparavel: so letras e numeros, maiusculas. */
function placaCanonica(valor) {
    return String(valor || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Forma "tolerante" so para comparar: o OCR confunde I/1 e O/0 nas posicoes
 * numericas da placa (JKM0I96 x JKM0196). As 3 primeiras sao sempre letras.
 */
function placaComparavel(valor) {
    const placa = placaCanonica(valor);
    if (placa.length !== 7) return placa;
    const corpo = placa.slice(3).replace(/I/g, "1").replace(/O/g, "0");
    return placa.slice(0, 3) + corpo;
}

function resolverVeiculo(cad, placa) {
    const alvo = placaComparavel(placa);
    if (alvo.length !== 7) return null;
    const achados = cad.veiculos.filter((veiculo) => placaComparavel(veiculo.placa) === alvo);
    return achados.length === 1 ? achados[0] : null;
}

// Caracteres que o OCR confunde entre si (8/B, 0/O/D/Q, 1/I/L, 5/S, 2/Z, 6/G).
const SOSIAS = { 8: "B", B: "B", 0: "0", O: "0", D: "0", Q: "0", 1: "1", I: "1", L: "1", 5: "5", S: "5", 2: "2", Z: "2", 6: "6", G: "6" };
const placaSosia = (valor) => [...placaCanonica(valor)].map((c) => SOSIAS[c] || c).join("");

/**
 * Placa lida com troca de OCR em QUALQUER posicao ("SGR4854" = SGR4B54 da
 * frota, 8 no lugar de B). So resolve quando as diferencas sao todas entre
 * caracteres parecidos e um UNICO veiculo da frota bate.
 * @returns {{veiculo:object, lida:string}|null}
 */
function veiculoPorSosia(cad, placa) {
    const lida = placaCanonica(placa);
    if (lida.length !== 7) return null;
    const alvo = placaSosia(lida);
    const achados = cad.veiculos.filter((veiculo) => placaSosia(veiculo.placa) === alvo);
    return achados.length === 1 ? { veiculo: achados[0], lida } : null;
}

/**
 * Placa ilegivel ("JKMOISE") comparada com a frota. So SUGERE: as 3 letras
 * iniciais tem que bater com um UNICO veiculo e o resto pode diferir em ate 2
 * caracteres (depois de corrigir as trocas tipicas do OCR). Nunca decide sozinho.
 */
function veiculoAproximado(cad, placaBruta) {
    const lida = placaComparavel(placaBruta);
    if (lida.length !== 7) return null;
    const mesmoPrefixo = cad.veiculos.filter((veiculo) => placaComparavel(veiculo.placa).slice(0, 3) === lida.slice(0, 3));
    if (mesmoPrefixo.length !== 1) return null;
    const alvo = placaComparavel(mesmoPrefixo[0].placa);
    const diferencas = [...lida.slice(3)].filter((caractere, i) => caractere !== alvo[3 + i]).length;
    return diferencas <= 2 ? { veiculo: mesmoPrefixo[0], diferencas } : null;
}

/**
 * Veiculo citado pelo nome na mensagem ("Fiat Scudo", "Hilux").
 * So resolve quando o modelo e unico na frota; com duas Hilux devolve AMBIGUO.
 */
function resolverVeiculoPorTexto(cad, texto) {
    const alvo = normalizar(texto);
    if (!alvo) return { status: "DESCONHECIDO", veiculo: null, candidatos: [] };
    const porPlaca = resolverVeiculo(cad, texto);
    if (porPlaca) return { status: "RESOLVIDO", veiculo: porPlaca, candidatos: [] };
    const candidatos = cad.veiculos.filter((veiculo) => [veiculo.nome, veiculo.modelo, ...(veiculo.apelidos || [])]
        .filter(Boolean).some((nome) => normalizar(nome) === alvo));
    if (candidatos.length === 1) return { status: "RESOLVIDO", veiculo: candidatos[0], candidatos: [] };
    return { status: candidatos.length ? "AMBIGUO" : "DESCONHECIDO", veiculo: null, candidatos };
}

// ---------------------------------------------------------------------------
// Fornecedores
// ---------------------------------------------------------------------------

const PALAVRAS_MERCADO = ["supermercado", "supermercados", "mercado", "mercearia", "atacadao", "atacadista", "hipermercado", "minimercado"];

/**
 * Fornecedor final a partir do nome lido na nota.
 * Recorrente -> nome oficial; mercado nao recorrente -> generico; resto -> nome lido.
 */
function resolverFornecedor(cad, nomeLido, tipo = null) {
    const lido = String(nomeLido || "").replace(/\s+/g, " ").trim();
    // Padrao da VMac: posto, restaurante e hotel vao com o fornecedor GENERICO,
    // seja qual for o nome impresso na nota (que fica guardado em nome_lido).
    const generico = tipo ? cad.fornecedores.genericos_por_tipo?.[tipo] : null;
    if (generico) return { nome: generico, origem: "fornecedor_generico_do_tipo", nome_lido: lido || null };
    if (!lido) return { nome: null, origem: null };
    const recorrente = (cad.fornecedores.recorrentes || []).find((item) => [item.nome, ...(item.apelidos || [])]
        .some((nome) => contemTermo(lido, nome)));
    if (recorrente) return { nome: recorrente.nome, origem: "fornecedor_recorrente" };
    if (PALAVRAS_MERCADO.some((palavra) => contemTermo(lido, palavra))) {
        return { nome: cad.fornecedores.fornecedor_generico_mercado || "MERCADO", origem: "mercado_nao_recorrente", nome_lido: lido };
    }
    return { nome: lido.toUpperCase(), origem: "nome_lido_na_nota" };
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

/** Categoria do cadastro por nome interno (ex.: "JANTAR"), com ID valido ou nao. */
function categoriaPorNome(cad, nomeInterno) {
    const alvo = normalizar(nomeInterno);
    const categoria = cad.categorias.find((item) => normalizar(item.nome) === alvo);
    if (!categoria) return null;
    const idValido = Boolean(categoria.id) && !String(categoria.id).startsWith("PREENCHER_");
    return { nome: categoria.nome_conta_azul || categoria.nome, nome_interno: categoria.nome, id: idValido ? categoria.id : null };
}

/** "Gabriel Lorran" -> "gabriel_lorran" (sem repetir um id que ja existe). */
function idDaPessoa(nome, existentes) {
    const baseId = normalizar(nome).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "pessoa";
    let id = baseId;
    for (let n = 2; existentes.has(id); n += 1) id = `${baseId}_${n}`;
    return id;
}

/**
 * Cadastra uma pessoa nova em pessoas.json (o unico lugar onde ficam
 * telefones; o arquivo nao vai para o Git). Devolve so o final do telefone.
 */
function adicionarPessoa({ nome, telefone, papel = "OPERADOR" } = {}, pasta = PASTA_PADRAO) {
    const nomeLimpo = String(nome || "").replace(/\s+/g, " ").trim();
    if (nomeLimpo.length < 2) throw new Error("Informe o nome da pessoa.");
    let digitos = somenteDigitos(telefone);
    if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
    if (!/^55\d{10,11}$/.test(digitos)) throw new Error("Telefone inválido. Use DDD + número, ex.: 62 99999-9999.");
    const papelLimpo = ["OPERADOR", "GESTOR", "ADMINISTRATIVO"].includes(String(papel).toUpperCase()) ? String(papel).toUpperCase() : "OPERADOR";
    const arquivo = path.join(pasta, "pessoas.json");
    const atual = fs.existsSync(arquivo) ? lerJson(arquivo, { pessoas: [] }) : { pessoas: [] };
    const pessoas = Array.isArray(atual.pessoas) ? atual.pessoas : [];
    const variantes = new Set(variantesTelefone(digitos));
    const repetida = pessoas.find((pessoa) => variantesTelefone(pessoa.telefone).some((tel) => variantes.has(tel)));
    if (repetida) throw new Error(`Esse telefone já é de ${repetida.nome}.`);
    const pessoa = { id: idDaPessoa(nomeLimpo, new Set(pessoas.map((item) => item.id))), nome: nomeLimpo, telefone: digitos, papel: papelLimpo, pasta_drive: nomeLimpo.split(" ")[0] };
    pessoas.push(pessoa);
    fs.writeFileSync(arquivo, JSON.stringify({ ...atual, pessoas }, null, 2) + "\n", "utf8");
    return { id: pessoa.id, nome: pessoa.nome, papel: pessoa.papel, telefone_final: digitos.slice(-4) };
}

module.exports = {
    carregar, identificarPessoa, variantesTelefone, adicionarPessoa,
    resolverProjeto, pareceProjeto, projetosComId, nomeCentro,
    resolverCartao, resolverVeiculo, resolverVeiculoPorTexto, veiculoAproximado, veiculoPorSosia, placaCanonica, placaComparavel,
    resolverFornecedor, categoriaPorNome, PASTA_PADRAO,
};
