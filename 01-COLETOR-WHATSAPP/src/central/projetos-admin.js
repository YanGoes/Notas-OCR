"use strict";

// =============================================================================
// CADASTRO DE PROJETOS / CENTROS DE CUSTO PELA CENTRAL
// =============================================================================
//
// Edita configuracao/projetos.json com validacao, para o cadastro acompanhar
// os projetos novos sem ninguem mexer no arquivo a mao. Toda alteracao exige
// autor e fica registrada em `alteracoes_cadastro`.
//
// Isto NAO cria nada no Conta Azul. Criar o centro la continua sendo feito no
// painel principal (com a empresa confirmada); aqui se diz ao sistema qual
// centro do Conta Azul corresponde a cada projeto e como os operadores o chamam.
// =============================================================================

const fs = require("fs");
const path = require("path");
const { agora, json, transacao } = require("./banco");
const cadastros = require("./cadastros");
const { normalizar } = require("./texto");

const SERVICOS = ["FWD", "VDROD", "IRI", "ADMINISTRATIVO"];
const CAMPOS_EDITAVEIS = ["nome_oficial", "id_sistema_projetos", "centro_conta_azul", "busca_centro_conta_azul", "ativo", "servico", "apelidos", "cartao"];

function arquivo(pasta = cadastros.PASTA_PADRAO) { return path.join(pasta, "projetos.json"); }

function lerArquivo(pasta) {
    const caminho = arquivo(pasta);
    if (!fs.existsSync(caminho)) return { projetos: [] };
    return JSON.parse(fs.readFileSync(caminho, "utf8"));
}

/** Grava sem deixar o arquivo pela metade se algo falhar no meio. */
function gravarArquivo(pasta, conteudo) {
    const caminho = arquivo(pasta);
    const temporario = `${caminho}.${process.pid}.tmp`;
    fs.writeFileSync(temporario, `${JSON.stringify(conteudo, null, 2)}\n`, "utf8");
    fs.renameSync(temporario, caminho);
}

const textoLimpo = (valor, maximo = 160) => {
    const texto = String(valor ?? "").replace(/\s+/g, " ").trim();
    if (texto.length > maximo) throw new Error(`Texto longo demais (máximo ${maximo} caracteres).`);
    return texto;
};

/** Valida e normaliza os campos enviados pela tela. `cartoes` = codigos validos (cartoes.json). */
function normalizarEntrada(entrada, cartoes = null) {
    const saida = {};
    for (const chave of Object.keys(entrada || {})) {
        if (!CAMPOS_EDITAVEIS.includes(chave)) throw new Error(`Campo não editável: ${chave}.`);
    }
    if ("nome_oficial" in entrada) {
        saida.nome_oficial = textoLimpo(entrada.nome_oficial);
        if (!saida.nome_oficial) throw new Error("Informe o nome do projeto.");
    }
    if ("id_sistema_projetos" in entrada) {
        const bruto = String(entrada.id_sistema_projetos ?? "").trim();
        if (bruto && !/^\d{1,6}$/.test(bruto)) throw new Error("ID do sistema de projetos deve ser um número.");
        saida.id_sistema_projetos = bruto ? Number(bruto) : null;
    }
    for (const chave of ["centro_conta_azul", "busca_centro_conta_azul"]) {
        if (chave in entrada) saida[chave] = textoLimpo(entrada[chave]) || null;
    }
    if ("ativo" in entrada) {
        if (![true, false, null].includes(entrada.ativo)) throw new Error("Situação inválida (ativo, inativo ou não confirmado).");
        saida.ativo = entrada.ativo;
    }
    if ("servico" in entrada) {
        const servico = textoLimpo(entrada.servico, 40).toUpperCase();
        saida.servico = servico || null;
    }
    if ("cartao" in entrada) {
        // Cartao usado no projeto: a nota desse centro ja sai com ele (se o
        // operador nao informar outro). Vazio = nao definido.
        const codigo = textoLimpo(entrada.cartao, 40).toUpperCase();
        if (codigo && cartoes && !cartoes.includes(codigo)) throw new Error(`Cartão "${codigo}" não está no cadastro de cartões.`);
        saida.cartao = codigo || null;
    }
    if ("apelidos" in entrada) {
        const lista = Array.isArray(entrada.apelidos) ? entrada.apelidos : String(entrada.apelidos || "").split(/[;\n]/);
        const vistos = new Set();
        saida.apelidos = lista.map((apelido) => textoLimpo(apelido, 80)).filter((apelido) => {
            const chave = normalizar(apelido);
            if (!chave || vistos.has(chave)) return false;
            vistos.add(chave);
            return true;
        });
    }
    return saida;
}

/**
 * Um nome ou apelido nao pode apontar para dois projetos: senao a resolucao
 * "so por correspondencia exata" deixaria de ser exata.
 */
function verificarConflitos(projetos, indiceIgnorado) {
    const dono = new Map();
    projetos.forEach((projeto, indice) => {
        const nomes = [projeto.nome_oficial, projeto.centro_conta_azul, ...(projeto.apelidos || [])].filter(Boolean);
        for (const nome of new Set(nomes.map(normalizar))) {
            if (dono.has(nome) && dono.get(nome) !== indice) {
                // Aponta o OUTRO projeto (nao o que esta sendo salvo).
                const outro = projetos[dono.get(nome) === indiceIgnorado ? indice : dono.get(nome)].nome_oficial;
                const escrito = nomes.find((item) => normalizar(item) === nome);
                throw new Error(`"${escrito}" já é usado pelo projeto "${outro}". Cada nome ou apelido só pode apontar para um projeto.`);
            }
            dono.set(nome, indice);
        }
    });
}

function registrar(db, { chave, acao, antes, depois, autor }) {
    db.prepare(`INSERT INTO alteracoes_cadastro (cadastro, chave, acao, antes, depois, autor, em) VALUES ('projetos', ?, ?, ?, ?, ?, ?)`)
        .run(chave, acao, json(antes), json(depois), autor, agora());
}

function exigirAutor(autor) {
    const quem = textoLimpo(autor, 60);
    if (!quem) throw new Error("Informe quem está alterando o cadastro.");
    return quem;
}

/** Lista para a tela: projetos do cadastro + centros sincronizados ainda sem projeto. */
function listar({ pasta } = {}) {
    const cad = cadastros.carregar(pasta);
    const doArquivo = new Set(cad.projetos.map((projeto) => normalizar(projeto.nome_oficial)));
    return {
        servicos: SERVICOS,
        projetos: cadastros.projetosComId(cad).map((projeto) => ({
            nome_oficial: projeto.nome_oficial,
            id_sistema_projetos: projeto.id_sistema_projetos ?? null,
            centro_conta_azul: projeto.centro_conta_azul || null,
            busca_centro_conta_azul: projeto.busca_centro_conta_azul || null,
            centro_usado: cadastros.nomeCentro(projeto),
            id_conta_azul: projeto.id_conta_azul || null,
            ativo: projeto.ativo ?? null,
            servico: projeto.servico || null,
            apelidos: projeto.apelidos || [],
            cartao: projeto.cartao || null,
            origem: projeto.origem || null, ultimo_uso: projeto.ultimo_uso || null, usos: projeto.usos || null,
            no_cadastro: doArquivo.has(normalizar(projeto.nome_oficial)),
            atencao: projeto._atencao || null,
        })),
        centros_sincronizados: cad.centros.length,
    };
}

function criar(db, entrada, autor, { pasta } = {}) {
    const quem = exigirAutor(autor);
    const dados = normalizarEntrada(entrada, cadastros.carregar(pasta).cartoes.map((cartao) => cartao.codigo));
    if (!dados.nome_oficial) throw new Error("Informe o nome do projeto.");
    const conteudo = lerArquivo(pasta);
    const projetos = conteudo.projetos || [];
    const novo = {
        nome_oficial: dados.nome_oficial,
        id_sistema_projetos: dados.id_sistema_projetos ?? null,
        centro_conta_azul: dados.centro_conta_azul ?? null,
        id_conta_azul: null,
        ativo: "ativo" in dados ? dados.ativo : null,
        servico: dados.servico ?? null,
        apelidos: dados.apelidos || [],
    };
    if (dados.busca_centro_conta_azul) novo.busca_centro_conta_azul = dados.busca_centro_conta_azul;
    if (dados.cartao) novo.cartao = dados.cartao;
    const lista = [...projetos, novo];
    verificarConflitos(lista, lista.length - 1);
    transacao(db, () => {
        registrar(db, { chave: novo.nome_oficial, acao: "CRIADO", antes: null, depois: novo, autor: quem });
        gravarArquivo(pasta, { ...conteudo, projetos: lista });
    });
    return novo;
}

/**
 * Altera um projeto do cadastro. Centro sincronizado que ainda nao estava no
 * cadastro (aparece como "nao confirmado") entra no arquivo na primeira edicao.
 */
function editar(db, nomeAtual, alteracoes, autor, { pasta } = {}) {
    const quem = exigirAutor(autor);
    const dados = normalizarEntrada(alteracoes, cadastros.carregar(pasta).cartoes.map((cartao) => cartao.codigo));
    if (!Object.keys(dados).length) throw new Error("Nenhuma alteração enviada.");
    const conteudo = lerArquivo(pasta);
    const projetos = [...(conteudo.projetos || [])];
    let indice = projetos.findIndex((projeto) => normalizar(projeto.nome_oficial) === normalizar(nomeAtual));
    let antes;
    if (indice < 0) {
        const cad = cadastros.carregar(pasta);
        const sincronizado = cad.centros.find((centro) => normalizar(centro.nome) === normalizar(nomeAtual));
        if (!sincronizado) throw new Error(`Projeto "${nomeAtual}" não encontrado.`);
        projetos.push({ nome_oficial: sincronizado.nome, id_sistema_projetos: null, centro_conta_azul: sincronizado.nome, id_conta_azul: null, ativo: null, servico: null, apelidos: [] });
        indice = projetos.length - 1;
        antes = null;
    } else {
        antes = { ...projetos[indice] };
    }
    const atualizado = { ...projetos[indice], ...dados };
    // Renomear nao pode quebrar o que ja foi dito com o nome antigo (mensagens,
    // orientacao de cartao da gerencia): o nome antigo vira apelido.
    const nomeAnterior = projetos[indice].nome_oficial;
    if (dados.nome_oficial && normalizar(dados.nome_oficial) !== normalizar(nomeAnterior)
        && !(atualizado.apelidos || []).some((apelido) => normalizar(apelido) === normalizar(nomeAnterior))) {
        atualizado.apelidos = [...(atualizado.apelidos || []), nomeAnterior];
    }
    if (dados.centro_conta_azul && atualizado.busca_centro_conta_azul) delete atualizado.busca_centro_conta_azul;
    projetos[indice] = atualizado;
    verificarConflitos(projetos, indice);
    transacao(db, () => {
        registrar(db, { chave: atualizado.nome_oficial, acao: antes ? "ALTERADO" : "CONFIRMADO_DA_SINCRONIZACAO", antes, depois: atualizado, autor: quem });
        gravarArquivo(pasta, { ...conteudo, projetos });
    });
    return atualizado;
}

function historico(db, limite = 50) {
    return db.prepare("SELECT chave, acao, antes, depois, autor, em FROM alteracoes_cadastro WHERE cadastro = 'projetos' ORDER BY id DESC LIMIT ?")
        .all(limite).map((linha) => ({ ...linha, antes: JSON.parse(linha.antes), depois: JSON.parse(linha.depois) }));
}

module.exports = { listar, criar, editar, historico, SERVICOS };
