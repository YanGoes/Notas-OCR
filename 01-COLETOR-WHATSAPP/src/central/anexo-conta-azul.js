"use strict";

// =============================================================================
// ROBO DE TELA: ANEXO DA FOTO NO LANCAMENTO DO CONTA AZUL
// =============================================================================
//
// A API publica nao grava anexo. O site grava com os servicos internos dele
// (observados em 11/11/2026, conta de teste):
//
//   1. POST https://services.contaazul.com/attachment-service/v1/files
//        multipart, campo "file" -> { id, name, tenantId, size, type }
//   2. PATCH https://services.contaazul.com/finance-pro/v1/financial-events/{evento}
//        { "version": N, "attachments": [ ...os que ja existem,
//          { name, reference: <id do arquivo>, url: null, description, type: "OTHERS", contentType: "FILE" } ] }
//      (anexo por link: { name: null, reference: null, url, ..., contentType: "URL" })
//   3. GET  https://services.contaazul.com/app/user -> { idEmpresa } (quem esta logado)
//
// Essas chamadas so valem com a sessao de quem esta logado no site (cookies),
// por isso rodam DENTRO da pagina do navegador do robo (navegador-conta-azul.js).
// Regras aprendidas no teste:
//   - a lista enviada SUBSTITUI a anterior: quem fica de fora e excluido. Por
//     isso sempre se manda os anexos vivos que ja existem + o novo;
//   - `version` e a versao atual do evento (lida antes de gravar).
// Cada conta (teste, oficial) tem a sua janela e o seu perfil de navegador, e o
// robo confere a empresa logada antes de qualquer coisa.
// Como sao servicos internos, podem mudar sem aviso: tudo e relido e conferido,
// e a falha nunca derruba o envio (o lancamento ja foi criado pela API).
// =============================================================================

const fs = require("fs");
const path = require("path");
const navegador = require("./navegador-conta-azul");

const SITE = "https://pro.contaazul.com/";
const SERVICO = "https://services.contaazul.com/finance-pro/v1/financial-events";
const ARQUIVOS = "https://services.contaazul.com/attachment-service/v1/files";
const USUARIO = "https://services.contaazul.com/app/user";
const ID_EVENTO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAMANHO_MAXIMO = 10 * 1024 * 1024;
const TIPOS = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".bmp": "image/bmp", ".webp": "image/webp", ".pdf": "application/pdf" };

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pasta do perfil do navegador de cada conta (a de teste e a pasta original). */
function perfilDaConta(conta = "teste") {
    return conta === "oficial" ? `${navegador.PERFIL_PADRAO}-oficial` : navegador.PERFIL_PADRAO;
}

/** Anexo no formato que o site envia para "Forma do anexo: Link" + "Tipo: Outros". */
function anexoPorLink(url, descricao = "Foto da nota") {
    return { name: null, reference: null, url: String(url), description: String(descricao || "Foto da nota").slice(0, 255), type: "OTHERS", contentType: "URL" };
}

/** Anexo no formato que o site envia para "Forma do anexo: Arquivo" + "Tipo: Outros". */
function anexoPorArquivo(nome, idArquivo, descricao = null) {
    return { name: String(nome), reference: String(idArquivo), url: null, description: descricao ? String(descricao).slice(0, 255) : null, type: "OTHERS", contentType: "FILE" };
}

/** So os campos que o site reenvia de um anexo que ja existe. */
function anexoExistente(anexo) {
    return { name: anexo.name ?? null, id: anexo.id, reference: anexo.reference ?? null, url: anexo.url ?? null, description: anexo.description ?? null, type: anexo.type, contentType: anexo.contentType };
}

const mesmoAnexo = (a, novo) => (novo.contentType === "URL" ? a.contentType === "URL" && a.url === novo.url : a.contentType === "FILE" && a.name === novo.name);

/**
 * Lista a enviar: os anexos vivos que ja existem + o novo. Devolve null quando
 * o mesmo link (ou um arquivo com o mesmo nome) ja esta anexado.
 */
function listaComNovo(existentes, novo) {
    const vivos = (existentes || []).filter((anexo) => !anexo.deletedAt);
    if (vivos.some((anexo) => mesmoAnexo(anexo, novo))) return null;
    return [...vivos.map(anexoExistente), novo];
}

/**
 * JavaScript que roda dentro da pagina logada. `novo` e o anexo por link, ou o
 * anexo por arquivo sem `reference` (o arquivo vai em `arquivo`: { base64, tipo }
 * e so e enviado ao site depois de conferido o lancamento). `valor` confere
 * que o lancamento aberto e o que foi criado. Devolve { ok, ... }.
 */
function scriptDeAnexar(eventoId, novo, { valor = null, arquivo = null } = {}) {
    return `(async () => {
        const base = ${JSON.stringify(`${SERVICO}/${eventoId}`)};
        const novo = ${JSON.stringify(novo)};
        const valor = ${JSON.stringify(valor == null ? null : Math.round(Number(valor) * 100))};
        const arquivo = ${JSON.stringify(arquivo)};
        const cab = { Accept: 'application/json' };
        const existente = ${anexoExistente.toString()};
        const mesmo = ${mesmoAnexo.toString()};
        const ler = async () => {
            const r = await fetch(base, { credentials: 'include', headers: cab });
            const texto = await r.text();
            let corpo = null; try { corpo = JSON.parse(texto); } catch (_) { /* nao e JSON */ }
            return { http: r.status, corpo, texto: texto.slice(0, 300) };
        };
        for (let tentativa = 0; tentativa < 2; tentativa += 1) {
            const atual = await ler();
            if (atual.http !== 200 || !atual.corpo) return { ok: false, http: atual.http, erro: atual.http === 404 ? 'lançamento não encontrado na empresa logada no site' : atual.texto };
            if (valor != null && Math.round(Number(atual.corpo.value) * 100) !== valor) return { ok: false, erro: 'o lançamento aberto no site não é o que foi criado (valor diferente)' };
            const vivos = (atual.corpo.attachments || []).filter((a) => !a.deletedAt);
            const igual = vivos.find((a) => mesmo(a, novo));
            if (igual) return { ok: true, ja_tinha: true, anexo_id: igual.id };
            if (arquivo && !novo.reference) {
                const bytes = Uint8Array.from(atob(arquivo.base64), (c) => c.charCodeAt(0));
                const form = new FormData();
                form.append('file', new Blob([bytes], { type: arquivo.tipo }), novo.name);
                const envio = await fetch(${JSON.stringify(ARQUIVOS)}, { method: 'POST', credentials: 'include', body: form });
                const texto = await envio.text();
                let dados = null; try { dados = JSON.parse(texto); } catch (_) { /* nao e JSON */ }
                if (!envio.ok || !dados || !dados.id) return { ok: false, http: envio.status, erro: 'o site não aceitou o arquivo: ' + texto.slice(0, 200) };
                if (dados.size !== bytes.length) return { ok: false, erro: 'o arquivo chegou ao site com tamanho diferente' };
                novo.reference = dados.id;
            }
            const r = await fetch(base, { method: 'PATCH', credentials: 'include', headers: { ...cab, 'Content-Type': 'application/json' },
                body: JSON.stringify({ version: atual.corpo.version, attachments: [...vivos.map(existente), novo] }) });
            if ((r.status === 409 || r.status === 412) && tentativa === 0) continue;
            if (!r.ok) return { ok: false, http: r.status, erro: (await r.text()).slice(0, 300) };
            const depois = await ler();
            const gravado = ((depois.corpo && depois.corpo.attachments) || []).find((a) => !a.deletedAt && mesmo(a, novo));
            return gravado ? { ok: true, anexo_id: gravado.id, versao: depois.corpo.version, outros_anexos: vivos.length }
                : { ok: false, erro: 'o site respondeu que salvou, mas o anexo não apareceu na releitura' };
        }
        return { ok: false, erro: 'o lançamento foi alterado por outra pessoa durante a gravação' };
    })()`;
}

/**
 * Robo ligado ao navegador proprio de uma conta. `verificar` confere a sessao e
 * a empresa logada (abre a janela se estiver fechada); `anexarArquivo` e
 * `anexarLink` gravam o anexo no lancamento.
 */
function criarRobo({ conta = "teste", perfil = perfilDaConta(conta), navegadorExe = null } = {}) {
    let sessao = null;

    async function pagina() {
        // Janela fechada ou aba que saiu do site (ex.: caiu no login): liga de novo.
        if (sessao && !sessao.fechada()) {
            const url = await sessao.avaliar("location.href").catch(() => "");
            if (String(url).startsWith(SITE)) return sessao;
        }
        if (sessao) { sessao.fechar(); sessao = null; }
        const { porta, reaproveitado } = await navegador.abrir({ perfil, navegador: navegadorExe, url: SITE });
        let abas = await navegador.listarAbas(porta);
        if (!abas.some((aba) => /contaazul\.com/.test(aba.url))) { await navegador.novaAba(porta, SITE); }
        // O site redireciona sozinho: para o painel (logado) ou para o login.
        const limite = Date.now() + (reaproveitado ? 4000 : 20000);
        let alvo = null;
        while (Date.now() < limite) {
            abas = await navegador.listarAbas(porta);
            alvo = abas.find((aba) => aba.url.startsWith(SITE) && aba.url.length > SITE.length);
            if (alvo) break;
            await esperar(500);
        }
        if (!alvo) {
            const noLogin = abas.some((aba) => aba.url.includes("login.contaazul.com"));
            throw new Error(noLogin ? `Robô sem login no Conta Azul (conta ${conta}): entre com o usuário na janela do robô que abriu e tente de novo.`
                : `A janela do robô (conta ${conta}) não abriu o Conta Azul. Abra-a pelo atalho 18 e entre com o usuário.`);
        }
        sessao = await navegador.conectar(porta, { aba: alvo });
        return sessao;
    }

    /** Confere a sessao e, se informada, a empresa logada na janela. Nao grava nada. */
    async function verificar({ empresaId = null } = {}) {
        const s = await pagina();
        const r = await s.avaliar(`fetch(${JSON.stringify(USUARIO)}, { credentials: 'include', headers: { Accept: 'application/json' } })
            .then(async (resp) => ({ http: resp.status, dados: resp.ok ? await resp.json().catch(() => null) : null })).catch(() => ({ http: 0 }))`);
        if (r.http === 0) throw new Error(`A janela do robô (conta ${conta}) não conseguiu falar com o Conta Azul (sem internet ou página fora do site).`);
        if (r.http !== 200 || !r.dados?.idEmpresa) throw new Error(`A sessão do robô no Conta Azul expirou (conta ${conta}): entre de novo na janela do robô.`);
        const logada = String(r.dados.idEmpresa);
        if (empresaId && logada !== String(empresaId)) {
            throw new Error(`A janela do robô (conta ${conta}) está logada na empresa ${logada}, e o envio é para a empresa ${empresaId}. Entre com o usuário da empresa certa nessa janela.`);
        }
        return { ok: true, empresa_id: logada, usuario: r.dados.nome || null };
    }

    async function anexar(eventoId, novo, opcoes) {
        if (!ID_EVENTO.test(String(eventoId || ""))) return { ok: false, erro: "id do lançamento inválido" };
        try {
            const s = await pagina();
            return await s.avaliar(scriptDeAnexar(eventoId, novo, opcoes));
        } catch (erro) {
            return { ok: false, erro: erro.message };
        }
    }

    async function anexarLink(eventoId, { url, descricao = "Foto da nota", valor = null } = {}) {
        if (!/^https:\/\//.test(String(url || ""))) return { ok: false, erro: "link da foto inválido" };
        return { tipo: "link", ...await anexar(eventoId, anexoPorLink(url, descricao), { valor }) };
    }

    /** Envia a imagem ao site e grava como anexo (Forma: Arquivo, Tipo: Outros). */
    async function anexarArquivo(eventoId, { arquivo, nome = null, descricao = null, valor = null } = {}) {
        let bytes;
        try { bytes = fs.readFileSync(arquivo); } catch (_) { return { tipo: "arquivo", ok: false, erro: "foto não encontrada no programa" }; }
        const tipo = TIPOS[path.extname(nome || arquivo).toLowerCase()];
        if (!tipo) return { tipo: "arquivo", ok: false, erro: "formato de foto não aceito" };
        if (!bytes.length || bytes.length > TAMANHO_MAXIMO) return { tipo: "arquivo", ok: false, erro: "foto vazia ou maior que 10 MB" };
        const novo = anexoPorArquivo(nome || path.basename(arquivo), "", descricao);
        novo.reference = null;
        return { tipo: "arquivo", nome: novo.name, ...await anexar(eventoId, novo, { valor, arquivo: { base64: bytes.toString("base64"), tipo } }) };
    }

    /** Roda um script de cadastro dentro da pagina. Nunca lanca erro: devolve { ok, ... }. */
    async function cadastrar(script) {
        try { return await (await pagina()).avaliar(script); } catch (erro) { return { ok: false, erro: erro.message }; }
    }

    /**
     * Cadastra uma categoria de despesa pelo site (a API publica nao cria
     * categoria). Usado so para a conta de teste ficar com os mesmos nomes da
     * oficial. Se ja existir uma com o mesmo nome, devolve a existente.
     */
    function criarCategoriaDespesa(nome) {
        return cadastrar(scriptDeCategoria(String(nome || "").trim()));
    }

    /** Cadastra uma conta financeira ("Outras contas") pelo site, com o nome dado. So para a conta de teste. */
    function criarContaFinanceira(nome) {
        return cadastrar(scriptDeContaFinanceira(String(nome || "").trim()));
    }

    function fechar() { if (sessao) { sessao.fechar(); sessao = null; } }

    return { conta, verificar, anexarLink, anexarArquivo, criarCategoriaDespesa, criarContaFinanceira, fechar };
}

// -----------------------------------------------------------------------------
// Cadastros pelo site (observados em 11/11/2026, conta de teste):
//   categoria: POST services.contaazul.com/app/finance/v2/categories { name, parentId, type: "EXPENSE" }
//              (grupos em GET search-engine-core/v1/financial/categories/view?type=EXPENSE)
//   conta:     POST services.contaazul.com/app/financial-accounts
//              { bankInstitutionCode: -20, name, initialBalance: 0, initialBalanceDate, type: "OTHERACCOUNT", active: true }
// -----------------------------------------------------------------------------
const GRUPOS_CATEGORIA = "https://services.contaazul.com/search-engine-core/v1/financial/categories/view?page=1&page_size=200&type=EXPENSE&searchTerm=";
const CATEGORIAS = "https://services.contaazul.com/app/finance/v2/categories";
const CONTAS = "https://services.contaazul.com/app/financial-accounts";
const CONTAS_LISTA = "https://services.contaazul.com/finance-pro/v1/financial-accounts?page_size=1000&active_only=false&page=1";

/** Grupo onde a categoria nova entra: as de veiculo (com placa, manutencao, gerador) em "Veículos"; o resto em "Vendas e Serviços". */
function grupoDaCategoria(nome) {
    return /[A-Z]{3}-?\d[A-Z0-9]\d{2}\b|ve[ií]culo|manuten|gerador|combust/i.test(String(nome || "")) ? "veiculos" : "servicos";
}

function scriptDeCategoria(nome) {
    return `(async () => {
        const nome = ${JSON.stringify(nome)};
        if (!nome) return { ok: false, erro: 'categoria sem nome' };
        const igual = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
        const cab = { Accept: 'application/json', 'Content-Type': 'application/json' };
        const lista = await fetch(${JSON.stringify(GRUPOS_CATEGORIA)}, { credentials: 'include', headers: cab });
        if (!lista.ok) return { ok: false, http: lista.status, erro: 'o site não listou as categorias' };
        const grupos = (await lista.json()).items || [];
        const todas = []; const andar = (itens) => { for (const i of itens || []) { todas.push(i); andar(i.children); } }; andar(grupos);
        const existente = todas.find((c) => igual(c.name, nome));
        if (existente) return { ok: true, ja_existia: true, id: existente.uuid, nome: existente.name };
        const alvo = ${JSON.stringify(grupoDaCategoria(nome))} === 'veiculos' ? /ve[ií]culos/i : /vendas e servi[cç]os/i;
        const grupo = grupos.find((g) => /^Despesas/i.test(String(g.name).replace(/^[\\d. ]+/, '')) && alvo.test(g.name)) || grupos.find((g) => alvo.test(g.name)) || grupos[0];
        if (!grupo) return { ok: false, erro: 'a conta não tem grupo de despesa para receber a categoria' };
        const r = await fetch(${JSON.stringify(CATEGORIAS)}, { method: 'POST', credentials: 'include', headers: cab, body: JSON.stringify({ name: nome, parentId: grupo.uuid, type: 'EXPENSE' }) });
        const texto = await r.text();
        let dados = null; try { dados = JSON.parse(texto); } catch (_) { /* nao e JSON */ }
        return r.ok && dados && dados.id ? { ok: true, id: dados.id, nome: dados.name, grupo: grupo.name } : { ok: false, http: r.status, erro: texto.slice(0, 200) };
    })()`;
}

function scriptDeContaFinanceira(nome) {
    return `(async () => {
        const nome = ${JSON.stringify(nome)};
        if (!nome) return { ok: false, erro: 'conta financeira sem nome' };
        const igual = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
        const cab = { Accept: 'application/json', 'Content-Type': 'application/json' };
        const lista = await fetch(${JSON.stringify(CONTAS_LISTA)}, { credentials: 'include', headers: cab });
        if (!lista.ok) return { ok: false, http: lista.status, erro: 'o site não listou as contas financeiras' };
        const existente = ((await lista.json()).items || []).find((c) => igual(c.name, nome));
        if (existente) return { ok: true, ja_existia: true, id: existente.id, nome: existente.name };
        const r = await fetch(${JSON.stringify(CONTAS)}, { method: 'POST', credentials: 'include', headers: cab,
            body: JSON.stringify({ bankInstitutionCode: -20, name: nome, initialBalance: 0, initialBalanceDate: '2025-01-01', type: 'OTHERACCOUNT', active: true }) });
        const texto = await r.text();
        let dados = null; try { dados = JSON.parse(texto); } catch (_) { /* nao e JSON */ }
        return r.ok && dados && dados.id ? { ok: true, id: dados.id, nome: dados.name } : { ok: false, http: r.status, erro: texto.slice(0, 200) };
    })()`;
}

module.exports = { criarRobo, perfilDaConta, anexoPorLink, anexoPorArquivo, anexoExistente, listaComNovo, scriptDeAnexar, scriptDeCategoria, scriptDeContaFinanceira, grupoDaCategoria, SITE, SERVICO, ARQUIVOS };
