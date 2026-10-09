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
    return {
        pessoas: lerJson(arquivo(pessoasArquivo), { pessoas: [] }).pessoas || [],
        projetos: lerJson(arquivo("projetos.json"), { projetos: [] }).projetos || [],
        centros: lerJson(arquivo("centros_custo.json"), []),
        veiculos: lerJson(arquivo("veiculos.json"), []),
        cartoes: lerJson(arquivo("cartoes.json"), []),
        categorias: lerJson(arquivo("categorias.json"), []),
        fornecedores: lerJson(arquivo("fornecedores_recorrentes.json"), { recorrentes: [] }),
    };
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
        const centro = porNome.get(normalizar(nomeCentro(projeto)));
        return {
            ...projeto,
            id_conta_azul: projeto.id_conta_azul || centro?.id || null,
            apelidos: [...new Set([...(projeto.apelidos || []), ...(centro?.apelidos || [])])],
        };
    });
    const conhecidos = new Set(cad.projetos.flatMap((projeto) => [projeto.nome_oficial, projeto.centro_conta_azul])
        .filter(Boolean).map(normalizar));
    for (const centro of cad.centros) {
        if (!centro?.nome || conhecidos.has(normalizar(centro.nome))) continue;
        projetos.push({ nome_oficial: centro.nome, id_conta_azul: centro.id || null, ativo: null, servico: null, apelidos: centro.apelidos || [], origem: "centros_custo_sincronizados" });
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
function resolverFornecedor(cad, nomeLido) {
    const lido = String(nomeLido || "").replace(/\s+/g, " ").trim();
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

module.exports = {
    carregar, identificarPessoa, variantesTelefone,
    resolverProjeto, pareceProjeto, projetosComId, nomeCentro,
    resolverCartao, resolverVeiculo, resolverVeiculoPorTexto, placaCanonica, placaComparavel,
    resolverFornecedor, categoriaPorNome, PASTA_PADRAO,
};
