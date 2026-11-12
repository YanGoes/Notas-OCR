"use strict";

// =============================================================================
// ENVIO DE UMA DESPESA APROVADA PARA O CONTA AZUL (conta de teste ou oficial)
// =============================================================================
//
// Caminho escolhido por teste real (19/10/2026, conta de teste):
//   - Captura + aceite: a previa NAO pode ser editada (405) e o PATCH da parcela
//     ignora categoria/centro -> a categoria fica a que a Captura chutou e o
//     centro vazio. Descartado.
//   - POST /v1/financeiro/contas-a-pagar (endpoint novo): grava categoria,
//     centro, fornecedor, conta financeira, descricao, observacao e forma.
//     So nao aceita a foto (a API nao tem envio de anexo). Usado aqui.
//   - Foto: a API nao anexa. Quem anexa e o robo de tela (anexo-conta-azul.js),
//     logo depois da criacao. config.central.envio_conta_azul.anexo_da_foto:
//       "arquivo" -> a IMAGEM da nota na aba Anexo do lancamento (padrao atual);
//       "link"    -> o link da foto no Google Drive na aba Anexo.
//     (link_da_foto: true | "observacao" poe o link do Drive no texto da
//     observacao, sem robo.) Com anexo ligado, nota com foto so sobe se o robo
//     estiver logado no site NA MESMA EMPRESA do envio.
//   - Contas: "teste" (empresa somente_empresa_id) e "oficial" (so depois de
//     liberada em envio_conta_azul.oficial = { habilitado, empresa_id }).
//   - O QUE VAI E O QUE ESTA NA CENTRAL, nas duas contas (decisao do Yan em
//     11/11/2026): fornecedor aprovado, categoria, centro de custo e a conta
//     financeira do cartao (cartoes.json -> conta_conta_azul), pelo nome exato.
//     Nada e trocado por parecido. Cadastro que falta: na conta de TESTE e
//     criado com o mesmo nome (centro e fornecedor pela API; categoria e conta
//     financeira pelo robo de tela, porque a API nao cria); na OFICIAL a nota
//     nao sobe e o motivo aparece.
//
//   - O lancamento NAO leva codigo de referencia (pedido do Yan em 11/11/2026).
//     Quem impede o envio repetido e a tabela envios_conta_azul; o robo confere
//     o lancamento pelo ID devolvido na criacao e pelo valor.
//
// Depois de criar, RELE o lancamento e confere campo a campo o que ficou gravado.
// Trava dura: so envia se a empresa conectada for a da conta pedida, como esta
// no config (exigirEmpresa). Nao existe DELETE na API.
// =============================================================================

const fs = require("fs");
const path = require("path");

const drive = require("./arquivo-drive");

const RAIZ = path.resolve(__dirname, "..", "..");
const PASTAS_IMAGEM = ["entrada", "simulacao", "revisao", "bloqueados", "erros", "enviados", "importados"];

const normalizar = (texto) => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
const centavos = (valor) => Math.round(Number(valor) * 100);
const soDigitos = (texto) => String(texto || "").replace(/\D/g, "");

function lerConfig() {
    try { return JSON.parse(fs.readFileSync(path.join(RAIZ, "config.json"), "utf8")); } catch (_) { return {}; }
}

function localizarFoto(arquivo) {
    if (!arquivo || path.basename(arquivo) !== arquivo) return null;
    for (const pasta of PASTAS_IMAGEM) {
        const caminho = path.join(RAIZ, "dados", pasta, arquivo);
        if (fs.existsSync(caminho)) return caminho;
    }
    return null;
}

/** O que a Central aprovou, no formato que sera comparado com o Conta Azul. */
function dadosDaDespesa(campos) {
    return {
        valor: Number(campos.valor?.valor),
        data: campos.data_competencia?.valor || null,
        tipo: campos.tipo?.valor || null,
        descricao: campos.descricao?.valor || null,
        categoria: campos.categoria?.nome || null,
        centro: campos.centro_custo?.nome || null,
        forma: campos.pagamento?.forma || null,
        cartao: campos.pagamento?.rotulo || campos.pagamento?.cartao || null,
        cartao_codigo: campos.pagamento?.cartao || null,
        fornecedor: campos.fornecedor?.valor || null,
        fornecedor_nome_lido: campos.fornecedor?.nome_lido || null,
        fornecedor_cnpj: soDigitos(campos.fornecedor?.cnpj_lido) || null,
        observacao: campos.observacao?.valor || null,
        anexo_descricao: campos.anexo?.descricao || null,
    };
}

function acharPorNome(lista, nome) {
    const alvo = normalizar(nome);
    return alvo ? lista.find((item) => normalizar(item.nome) === alvo) || null : null;
}

/** Categoria e centro da empresa conectada com o MESMO nome da Central (nunca um parecido). */
function mapear(dados, { categorias, centros }) {
    return { categoria: acharPorNome(categorias, dados.categoria), centro: acharPorNome(centros, dados.centro) };
}

/**
 * Fornecedor: o que foi aprovado na Central (ex.: SUPERMERCADO, RESTAURANTES),
 * pelo nome exato. So quando a nota nao tem fornecedor aprovado e que vale o
 * CNPJ lido — nunca um nome lido sem CNPJ, que costuma ser lixo do cupom.
 */
async function resolverFornecedor(api, dados) {
    const ativo = (lista) => lista.find((p) => p.ativo !== false && (p.perfis || []).includes("Fornecedor")) || null;
    if (dados.fornecedor) {
        const lista = await api.buscarPessoas({ busca: dados.fornecedor });
        const achado = ativo(lista.filter((p) => normalizar(p.nome) === normalizar(dados.fornecedor)));
        return achado ? { ...achado, por: "fornecedor aprovado na Central" } : null;
    }
    if ([11, 14].includes(String(dados.fornecedor_cnpj || "").length)) {
        const achado = ativo(await api.buscarPessoas({ documentos: dados.fornecedor_cnpj }));
        if (achado) return { ...achado, por: "CNPJ da nota (a nota não tem fornecedor aprovado)" };
    }
    return null;
}

/** O que cadastrar quando o fornecedor nao existe: o aprovado; sem ele, o CNPJ + nome lido. */
function fornecedorParaCriar(dados) {
    if (dados.fornecedor) return { nome: dados.fornecedor };
    if ([11, 14].includes(String(dados.fornecedor_cnpj || "").length) && dados.fornecedor_nome_lido) return { nome: dados.fornecedor_nome_lido, documento: dados.fornecedor_cnpj };
    return null;
}

/** Trava: so a empresa de teste configurada. Devolve a empresa ou lanca erro. */
async function exigirEmpresaDeTeste(api, config) {
    const regra = config.central?.envio_conta_azul || {};
    if (!regra.habilitado) throw new Error("Envio ao Conta Azul desligado (config.central.envio_conta_azul.habilitado).");
    const permitida = String(regra.somente_empresa_id || "").trim();
    if (!permitida) throw new Error("Falta config.central.envio_conta_azul.somente_empresa_id: nada é enviado sem saber qual empresa é a de teste.");
    const empresa = await api.empresaConectada();
    const id = String(empresa?.id_empresa || empresa?.id || "");
    if (id !== permitida) throw new Error(`Empresa conectada (${id || "?"}) não é a empresa de teste ${permitida}. Envio bloqueado.`);
    return { id, nome: empresa?.razao_social || empresa?.nome || "" };
}

/** Empresa de cada conta, como esta no config (teste: somente_empresa_id; oficial: oficial.empresa_id). */
function empresaDaConta(config, conta = "teste") {
    const regra = config.central?.envio_conta_azul || {};
    return String((conta === "oficial" ? regra.oficial?.empresa_id : regra.somente_empresa_id) || "").trim();
}

/**
 * Trava por conta. "teste": a empresa de teste configurada. "oficial": so
 * depois de liberada no config, com o ID da empresa gravado la (a liberacao e
 * uma decisao de quem manda, nunca automatica). Devolve a empresa ou lanca erro.
 */
async function exigirEmpresa(api, config, conta = "teste") {
    if (conta === "teste") return exigirEmpresaDeTeste(api, config);
    if (conta !== "oficial") throw new Error("Conta inválida: use teste ou oficial.");
    const regra = config.central?.envio_conta_azul || {};
    if (!regra.habilitado) throw new Error("Envio ao Conta Azul desligado (config.central.envio_conta_azul.habilitado).");
    const empresa = await api.empresaConectada();
    const id = String(empresa?.id_empresa || empresa?.id || "");
    const nome = empresa?.razao_social || empresa?.nome || "";
    const permitida = empresaDaConta(config, "oficial");
    if (!regra.oficial?.habilitado || !permitida) {
        throw new Error(`O envio para a conta OFICIAL ainda não foi liberado. Empresa conectada: ${id || "?"} (${nome}). Para liberar, grave em config.json → central.envio_conta_azul.oficial: { "habilitado": true, "empresa_id": "${id}" }.`);
    }
    if (id !== permitida) throw new Error(`Empresa conectada (${id || "?"}) não é a empresa oficial liberada (${permitida}). Envio bloqueado.`);
    return { id, nome };
}

function carregarDespesa(db, despesaId) {
    const linha = db.prepare(`SELECT d.id, d.estado, d.campos, d.midia_id, m.arquivo FROM despesas d
        LEFT JOIN midias m ON m.id = d.midia_id WHERE d.id = ?`).get(despesaId);
    if (!linha) throw new Error(`Despesa #${despesaId} não encontrada.`);
    return { ...linha, campos: JSON.parse(linha.campos) };
}

function envioAnterior(db, despesaId, empresaId) {
    return db.prepare(`SELECT * FROM envios_conta_azul WHERE despesa_id = ? AND empresa_id = ?
        AND status IN ('ENVIADO', 'ENVIADO_INCOMPLETO', 'EM_ANDAMENTO', 'INCERTO') ORDER BY id DESC LIMIT 1`).get(despesaId, empresaId);
}

/**
 * Libera o reenvio de uma nota ja enviada para a conta de TESTE (ex.: subiu
 * com dado errado). O envio antigo fica marcado como SUBSTITUIDO; o lancamento
 * antigo continua no Conta Azul de teste e so sai pela tela de la. Na conta
 * oficial isso nao existe: reenviar criaria um lancamento duplicado de verdade.
 */
function liberarReenvio(db, despesaId, { config = lerConfig(), conta = "teste" } = {}) {
    if (conta !== "teste") throw new Error("Reenvio só existe na conta de teste. Na oficial, corrija o lançamento pela tela do Conta Azul.");
    const empresaId = empresaDaConta(config, "teste");
    const r = db.prepare(`UPDATE envios_conta_azul SET status = 'SUBSTITUIDO', atualizado_em = ? WHERE despesa_id = ? AND empresa_id = ?
        AND status IN ('ENVIADO', 'ENVIADO_INCOMPLETO', 'INCERTO')`).run(new Date().toISOString(), despesaId, empresaId);
    return { liberados: Number(r.changes) };
}

/** Categorias, centros e contas da empresa conectada (uma leitura por lote). */
async function carregarCatalogo(api) {
    const [categorias, centros, contas] = await Promise.all([api.listarCategoriasDespesa(), api.listarCentrosCusto(), api.listarContasFinanceiras()]);
    return { categorias, centros, contas };
}

/** Despesas aprovadas que ainda nao subiram (ou cuja tentativa falhou sem criar nada). */
function pendentesDeEnvio(db, empresaId) {
    return db.prepare(`SELECT d.id FROM despesas d WHERE d.estado = 'APROVADO' AND NOT EXISTS (
        SELECT 1 FROM envios_conta_azul e WHERE e.despesa_id = d.id AND e.empresa_id = ?
        AND e.status IN ('ENVIADO', 'ENVIADO_INCOMPLETO', 'EM_ANDAMENTO', 'INCERTO')) ORDER BY d.id`).all(empresaId).map((l) => l.id);
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Como a foto vai para o lancamento:
 *   arquivo    -> a IMAGEM na aba Anexo (anexo_da_foto: "arquivo"), pelo robo de tela;
 *   link       -> o link do Drive na aba Anexo (anexo_da_foto: "link"), pelo robo de tela;
 *   observacao -> o link do Drive no texto da observacao (link_da_foto: true | "observacao").
 * (link_da_foto: "anexo" e "ambos" continuam valendo para quem ja tinha configurado.)
 */
function modoDaFoto(config) {
    const regra = config.central?.envio_conta_azul || {};
    const anexo = String(regra.anexo_da_foto || "").toLowerCase();
    const texto = String(regra.link_da_foto || "").toLowerCase();
    return {
        arquivo: anexo === "arquivo",
        link: anexo === "link" || (anexo !== "arquivo" && ["anexo", "ambos"].includes(texto)),
        observacao: regra.link_da_foto === true || ["observacao", "ambos"].includes(texto),
    };
}

// Um robo por conta: cada uma tem a sua janela e o seu login.
const robosCompartilhados = new Map();
function roboPadrao(config, conta = "teste") {
    // Teste automatico nunca abre o navegador de verdade nem fala com o site: tem de passar um robo falso.
    if (process.env.NODE_TEST_CONTEXT) throw new Error("O robô de tela de verdade não é usado em teste automático: passe um robô falso.");
    if (!robosCompartilhados.has(conta)) {
        const opcoes = config.central?.robo_conta_azul || {};
        robosCompartilhados.set(conta, require("./anexo-conta-azul").criarRobo({ conta, navegadorExe: opcoes.navegador || null }));
    }
    return robosCompartilhados.get(conta);
}
/** Solta a ligacao com as janelas do robo (as janelas continuam abertas). */
function fecharRobo() {
    for (const robo of robosCompartilhados.values()) robo.fechar();
    robosCompartilhados.clear();
}

function lerCartoes() {
    try { return JSON.parse(fs.readFileSync(path.join(RAIZ, "configuracao", "cartoes.json"), "utf8")); } catch (_) { return []; }
}

/**
 * Conta financeira do lancamento: a do cartao/forma de pagamento da nota,
 * como esta em cartoes.json (conta_conta_azul = nome no Conta Azul;
 * conta_conta_azul_id = ID, quando preenchido). Devolve { nome, conta } —
 * conta nula quando ela ainda nao existe na empresa conectada.
 */
function contaFinanceira(dados, contas, cartoes = []) {
    const cartao = (Array.isArray(cartoes) ? cartoes : []).find((c) => (dados.cartao_codigo && normalizar(c.codigo) === normalizar(dados.cartao_codigo))
        || (dados.cartao && normalizar(c.rotulo) === normalizar(dados.cartao)));
    if (!cartao) throw new Error(`A nota não diz de qual cartão ou conta saiu o pagamento ("${dados.cartao || dados.forma || "não informado"}"): corrija o Pagamento na Central.`);
    if (!cartao.conta_conta_azul && !cartao.conta_conta_azul_id) {
        throw new Error(`O cartão "${cartao.rotulo}" está sem a conta financeira do Conta Azul: preencha conta_conta_azul em configuracao/cartoes.json.`);
    }
    const conta = contas.find((c) => cartao.conta_conta_azul_id && c.id === cartao.conta_conta_azul_id)
        || contas.find((c) => cartao.conta_conta_azul && normalizar(c.nome) === normalizar(cartao.conta_conta_azul)) || null;
    return { nome: cartao.conta_conta_azul || cartao.rotulo, conta };
}

/**
 * Link da foto no Drive para o lancamento. Desligado no config ou nota sem
 * foto: null. Ligado e sem link: erro (nao sobe lancamento sem a foto). Se o
 * Drive ainda esta enviando a foto, espera ate `esperaLinkMs`.
 */
async function linkParaEnvio(db, despesa, { config, linkDaFoto, esperaLinkMs }) {
    const modo = modoDaFoto(config);
    if (!modo.link && !modo.observacao) return null;
    if (!despesa.midia_id || despesa.campos.sem_comprovante?.valor) return null;
    const limite = Date.now() + esperaLinkMs;
    for (;;) {
        const resultado = linkDaFoto(db, despesa.midia_id, { config });
        if (resultado.link) return resultado;
        if (!resultado.aguardar || Date.now() >= limite) {
            throw new Error(`Despesa #${despesa.id} não foi enviada: sem o link da foto no Drive (${resultado.motivo}). Confira se o Google Drive está aberto e tente de novo.`);
        }
        await esperar(1000);
    }
}

/** Monta o plano sem gravar nada no Conta Azul (so leituras). */
async function planejar(db, despesaId, { api, config = lerConfig(), catalogo = null, empresa: empresaConferida = null,
    conta: contaCa = "teste", cartoes = null, linkDaFoto = drive.linkDaFoto, localizar = localizarFoto, esperaLinkMs = 0, robo = null } = {}) {
    const empresa = empresaConferida || await exigirEmpresa(api, config, contaCa);
    const teste = contaCa === "teste";
    const despesa = carregarDespesa(db, despesaId);
    if (despesa.estado !== "APROVADO") throw new Error(`Despesa #${despesaId} está ${despesa.estado}; só aprovadas são enviadas.`);
    const anterior = envioAnterior(db, despesaId, empresa.id);
    if (anterior) throw new Error(`Despesa #${despesaId} já foi enviada para esta empresa (envio ${anterior.id}, ${anterior.status}).`);
    const dados = dadosDaDespesa(despesa.campos);
    if (!(dados.valor > 0) || !dados.data) throw new Error(`Despesa #${despesaId} sem valor ou data.`);
    const fotoDrive = await linkParaEnvio(db, despesa, { config, linkDaFoto, esperaLinkMs });
    const modo = modoDaFoto(config);
    const temFoto = Boolean(despesa.midia_id && !despesa.campos.sem_comprovante?.valor);
    const foto = localizar(despesa.arquivo);
    if (modo.arquivo && temFoto && !foto) throw new Error(`Despesa #${despesaId} não foi enviada: a foto da nota não está mais no programa (${despesa.arquivo || "sem arquivo"}).`);
    // "arquivo" = a imagem; "link" = o link do Drive. Nota sem comprovante nao tem anexo.
    const anexar = modo.arquivo && temFoto ? "arquivo" : (modo.link && fotoDrive?.link ? "link" : null);
    // Robo sem sessao no site (ou logado em outra empresa) = nao cria o lancamento (ele ficaria sem a foto).
    const roboUsado = anexar ? (robo || roboPadrao(config, contaCa)) : null;
    if (roboUsado) await roboUsado.verificar({ empresaId: empresa.id });
    const cat = catalogo || await carregarCatalogo(api);
    if (!dados.categoria) throw new Error(`Despesa #${despesaId} está sem categoria: corrija na Central.`);
    const mapa = mapear(dados, cat);
    const financeira = contaFinanceira(dados, cat.contas, cartoes || lerCartoes());
    const fornecedor = await resolverFornecedor(api, dados);
    // O que a Central diz e ainda nao existe na empresa conectada. Nada e trocado por parecido.
    const faltam = [
        mapa.categoria ? null : { tipo: "categoria", nome: dados.categoria },
        dados.centro && !mapa.centro ? { tipo: "centro de custo", nome: dados.centro } : null,
        financeira.conta ? null : { tipo: "conta financeira", nome: financeira.nome },
        fornecedor ? null : { tipo: "fornecedor", nome: fornecedorParaCriar(dados)?.nome || dados.fornecedor_nome_lido || "(nota sem fornecedor aprovado)" },
    ].filter(Boolean);
    // Na conta de teste o cadastro que falta e criado com o mesmo nome na hora do envio (plano.faltam); na oficial, nunca.
    const podeCriar = teste && (!faltam.some((f) => f.tipo === "fornecedor") || fornecedorParaCriar(dados));
    if (faltam.length && !podeCriar) {
        throw new Error(`Despesa #${despesaId} não foi enviada: ${faltam.map((f) => `${f.tipo} "${f.nome}"`).join(", ")} não existe(m) no Conta Azul (conta ${teste ? "de teste" : "oficial"}). ${teste ? "Corrija o fornecedor da nota na Central." : "Cadastre no Conta Azul com o mesmo nome, ou corrija a nota na Central."}`);
    }
    // Categoria e conta financeira so o robo cria: ele precisa estar logado mesmo sem anexo.
    const precisaRobo = faltam.some((f) => ["categoria", "conta financeira"].includes(f.tipo));
    const roboDosCadastros = roboUsado || (precisaRobo ? (robo || roboPadrao(config, contaCa)) : null);
    if (precisaRobo && !roboUsado) await roboDosCadastros.verificar({ empresaId: empresa.id });
    const fotoNome = foto ? drive.nomeDoArquivo([{ id: despesaId, tipo: dados.tipo, valor: dados.valor }], despesa.arquivo) : null;
    return {
        empresa, conta_ca: contaCa, despesa_id: despesaId, foto, foto_nome: fotoNome, foto_drive: fotoDrive,
        link_na_observacao: modo.observacao && fotoDrive?.link ? fotoDrive.link : null, anexar, robo: roboDosCadastros,
        dados, mapa, conta: financeira.conta, conta_nome: financeira.nome, fornecedor, faltam, catalogo: cat,
    };
}

/** Observacao final: a da despesa + a descricao do anexo (ex.: REEMBOLSO X) + o link da foto, sem repetir. */
function observacaoFinal(dados, linkFoto = null) {
    const partes = [dados.observacao, dados.anexo_descricao, linkFoto ? `Foto: ${linkFoto}` : null].filter(Boolean);
    return [...new Set(partes)].join(" | ") || null;
}

function corpoDoLancamento(plano) {
    const { dados, mapa, conta, fornecedor } = plano;
    const valor = Number(dados.valor.toFixed(2));
    const rateio = { id_categoria: mapa.categoria.id, valor };
    if (mapa.centro) rateio.rateio_centro_custo = [{ id_centro_custo: mapa.centro.id, valor }];
    const descricao = String(dados.descricao || mapa.categoria.nome.trim()).slice(0, 255);
    const observacao = observacaoFinal(dados, plano.link_na_observacao);
    return {
        descricao, data_competencia: dados.data, valor, conta_financeira: conta.id, id_fornecedor: fornecedor.id,
        ...(observacao ? { observacao } : {}),
        rateio: [rateio],
        condicao_pagamento: { parcelas: [{
            descricao, data_vencimento: dados.data, conta_financeira: conta.id,
            detalhe_valor: { valor_bruto: valor },
            ...(dados.forma ? { metodo_pagamento: dados.forma } : {}),
        }] },
    };
}

/** Compara o que foi pedido com o que o Conta Azul devolve ao reler. */
function conferir(plano, corpo, { criado, parcela, busca }) {
    const rateio = parcela?.evento?.rateio || [];
    const centroLido = rateio[0]?.rateio_centro_custo?.[0] || null;
    const linha = (campo, esperado, lido, ok, nota = null) => ({ campo, esperado, lido, ok, ...(nota ? { nota } : {}) });
    return [
        linha("valor", corpo.valor, parcela?.valor_composicao?.valor_bruto ?? busca?.total ?? null,
            centavos(parcela?.valor_composicao?.valor_bruto ?? busca?.total) === centavos(corpo.valor)),
        linha("data", corpo.data_competencia, parcela?.evento?.data_competencia || null, parcela?.evento?.data_competencia === corpo.data_competencia),
        linha("categoria", plano.mapa.categoria.nome.trim(), rateio[0]?.nome_categoria?.trim() || null, rateio[0]?.id_categoria === plano.mapa.categoria.id),
        linha("centro de custo", plano.mapa.centro?.nome || null, centroLido?.nome_centro_custo || null,
            plano.mapa.centro ? centroLido?.id_centro_custo === plano.mapa.centro.id : !centroLido),
        linha("fornecedor", plano.fornecedor.nome, busca?.fornecedor?.nome || null, busca?.fornecedor?.id === plano.fornecedor.id,
            `achado pelo ${plano.fornecedor.por}`),
        linha("conta financeira", plano.conta.nome, parcela?.conta_financeira?.nome || null, parcela?.conta_financeira?.id === plano.conta.id),
        linha("forma de pagamento", plano.dados.forma, parcela?.metodo_pagamento || null, !plano.dados.forma || parcela?.metodo_pagamento === plano.dados.forma),
        linha("descrição", corpo.descricao, parcela?.descricao || null, parcela?.descricao === corpo.descricao),
        linha("observação", corpo.observacao || null, criado?.observacao || null, (criado?.observacao || null) === (corpo.observacao || null),
            "a leitura da parcela não devolve a observação; conferida na resposta da criação"),
        plano.link_na_observacao
            ? linha("link da foto", plano.link_na_observacao, String(criado?.observacao || "").includes(plano.link_na_observacao) ? plano.link_na_observacao : null,
                String(criado?.observacao || "").includes(plano.link_na_observacao), "o link da foto no Drive vai na observação")
            : null,
        // Sem link nenhum: so informa (nao torna o envio incompleto). Com robo, a linha do anexo entra depois.
        !plano.link_na_observacao && !plano.anexar
            ? linha("foto anexada", "foto da nota", "não enviada", false, "a API do Conta Azul não tem envio de anexo; a foto fica no arquivo do Drive")
            : null,
    ].filter(Boolean);
}

/**
 * Conta de teste: cadastra, com o MESMO nome da Central, o que ainda nao existe
 * la (centro e fornecedor pela API; categoria e conta financeira pelo robo) e
 * completa o plano. Devolve a lista do que criou. Se algum cadastro falhar,
 * lanca erro: o lancamento nao e criado com dado trocado.
 */
async function criarCadastrosQueFaltam(plano, api) {
    const criados = [];
    for (const falta of plano.faltam || []) {
        let novo = null;
        if (falta.tipo === "centro de custo") {
            const r = await api.criarCentroCusto({ nome: falta.nome });
            novo = r?.id ? { id: r.id, nome: r.nome || falta.nome } : null;
            if (novo) { plano.catalogo.centros.push(novo); plano.mapa.centro = novo; }
        } else if (falta.tipo === "fornecedor") {
            const r = await api.criarFornecedor(fornecedorParaCriar(plano.dados));
            novo = r?.id ? { ...r, nome: r.nome || falta.nome } : null;
            if (novo) plano.fornecedor = { ...novo, por: "fornecedor aprovado na Central (cadastrado agora na conta de teste)" };
        } else if (falta.tipo === "categoria") {
            const r = await plano.robo.criarCategoriaDespesa(falta.nome);
            novo = r?.ok ? { id: r.id, nome: r.nome || falta.nome } : null;
            if (novo) { plano.catalogo.categorias.push(novo); plano.mapa.categoria = novo; }
            else throw new Error(`Não consegui cadastrar a categoria "${falta.nome}" na conta de teste: ${r?.erro || "sem resposta do robô"}.`);
        } else if (falta.tipo === "conta financeira") {
            const r = await plano.robo.criarContaFinanceira(falta.nome);
            novo = r?.ok ? { id: r.id, nome: r.nome || falta.nome } : null;
            if (novo) { plano.catalogo.contas.push(novo); plano.conta = novo; }
            else throw new Error(`Não consegui cadastrar a conta financeira "${falta.nome}" na conta de teste: ${r?.erro || "sem resposta do robô"}.`);
        }
        if (!novo) throw new Error(`Não consegui cadastrar ${falta.tipo} "${falta.nome}" na conta de teste.`);
        criados.push(`${falta.tipo} "${falta.nome}" cadastrado(a) na conta de teste`);
    }
    plano.faltam = [];
    return criados;
}

const CAMPO_ANEXO = "anexo da foto";

/** Linha da conferencia para o anexo gravado pelo robo (a imagem ou o link). */
function linhaDoAnexo(esperado, resultado) {
    const ok = Boolean(resultado?.ok);
    const oQue = resultado?.tipo === "link" ? "link" : "imagem";
    return {
        campo: CAMPO_ANEXO, esperado, lido: ok ? esperado : null, ok,
        nota: ok ? `${oQue} na aba Anexo do lançamento (robô de tela${resultado.ja_tinha ? "; já estava lá" : ""})`
            : `o robô de tela não gravou o anexo: ${resultado?.erro || "sem resposta"}`,
    };
}

/** `anexo`: { tipo: "arquivo", arquivo, nome } ou { tipo: "link", link }. Nunca lanca erro. */
async function anexarComRobo(robo, eventoId, anexo, { descricao, valor }) {
    try {
        if (anexo.tipo === "arquivo") return await robo.anexarArquivo(eventoId, { arquivo: anexo.arquivo, nome: anexo.nome, descricao: descricao || null, valor });
        return await robo.anexarLink(eventoId, { url: anexo.link, descricao: descricao || "Foto da nota", valor });
    } catch (erro) { return { tipo: anexo.tipo, ok: false, erro: erro.message }; }
}

const anexoDoPlano = (plano) => (plano.anexar === "arquivo" ? { tipo: "arquivo", arquivo: plano.foto, nome: plano.foto_nome } : { tipo: "link", link: plano.foto_drive.link });
const esperadoDoAnexo = (anexo) => (anexo.tipo === "arquivo" ? anexo.nome : anexo.link);

/**
 * Envia de verdade. Sempre devolve um relatorio e registra em
 * envios_conta_azul para nunca enviar a mesma despesa duas vezes.
 */
async function enviar(db, despesaId, { api, config = lerConfig(), autor = "sistema", ...opcoes } = {}) {
    const plano = await planejar(db, despesaId, { api, config, ...opcoes });
    const cadastrosCriados = await criarCadastrosQueFaltam(plano, api);
    const agora = () => new Date().toISOString();
    const envioId = Number(db.prepare(`INSERT INTO envios_conta_azul (despesa_id, empresa_id, status, autor, criado_em, atualizado_em)
        VALUES (?, ?, 'EM_ANDAMENTO', ?, ?, ?)`).run(despesaId, plano.empresa.id, autor, agora(), agora()).lastInsertRowid);
    const relatorio = { envio_id: envioId, despesa_id: despesaId, conta: plano.conta_ca, empresa: plano.empresa, cadastros_criados: cadastrosCriados, foto_drive: plano.foto_drive?.link || null, etapas: [] };
    const salvar = (status, extra = {}) => {
        Object.assign(relatorio, extra, { status });
        db.prepare(`UPDATE envios_conta_azul SET status = ?, evento_id = ?, parcela_id = ?, relatorio = ?, atualizado_em = ? WHERE id = ?`)
            .run(status, relatorio.evento_id || null, relatorio.parcela_id || null, JSON.stringify(relatorio), agora(), envioId);
        return relatorio;
    };
    const corpo = corpoDoLancamento(plano);
    let criado;
    try {
        criado = await api.criarContaPagarDireta(corpo);
    } catch (erro) {
        // Erro de validacao (400) = nada foi criado. Outros (rede, 500) = pode ter criado: conferir antes de reenviar.
        const nadaCriado = /Conta Azul (400|401|422|429):/.test(erro.message);
        return salvar(nadaCriado ? "FALHOU" : "INCERTO", { erro: erro.message });
    }
    relatorio.evento_id = criado?.id || null;
    relatorio.parcela_id = criado?.condicao_pagamento?.parcelas?.[0]?.id || null;
    relatorio.etapas.push({ etapa: "lançamento criado", ok: Boolean(relatorio.evento_id) });
    if (!relatorio.parcela_id) return salvar("INCERTO", { erro: "O Conta Azul não devolveu a parcela criada: conferir antes de reenviar." });
    if (plano.anexar) {
        relatorio.anexo_descricao = plano.dados.anexo_descricao || null;
        relatorio.anexo = await anexarComRobo(plano.robo, relatorio.evento_id, anexoDoPlano(plano), { descricao: relatorio.anexo_descricao, valor: corpo.valor });
        relatorio.etapas.push({ etapa: plano.anexar === "arquivo" ? "foto anexada ao lançamento (robô de tela)" : "link da foto gravado na aba Anexo (robô de tela)", ok: Boolean(relatorio.anexo.ok) });
    }
    try {
        const parcela = await api.obterParcelaFinanceira(relatorio.parcela_id);
        const busca = await api.buscarContasPagar({ data_vencimento_de: corpo.data_competencia, data_vencimento_ate: corpo.data_competencia });
        const item = (busca?.itens || busca?.items || []).find((i) => i.id === relatorio.parcela_id) || null;
        relatorio.etapas.push({ etapa: "lançamento relido no Conta Azul", ok: Boolean(parcela && item) });
        relatorio.conferencia = conferir(plano, corpo, { criado, parcela, busca: item });
        if (plano.anexar) relatorio.conferencia.push(linhaDoAnexo(esperadoDoAnexo(anexoDoPlano(plano)), relatorio.anexo));
    } catch (erro) {
        return salvar("ENVIADO_INCOMPLETO", { erro: `Criado, mas a releitura falhou: ${erro.message}` });
    }
    // A foto nunca vai pela API: isso nao torna o envio incompleto, so e informado.
    const faltou = relatorio.conferencia.filter((c) => !c.ok && c.campo !== "foto anexada").map((c) => c.campo);
    relatorio.completo = faltou.length === 0;
    relatorio.faltou = faltou;
    return salvar(faltou.length ? "ENVIADO_INCOMPLETO" : "ENVIADO");
}

/**
 * Tenta de novo o anexo dos lancamentos de uma conta que subiram sem ele (robo
 * fora do ar na hora, sessao expirada). Com `antigos`, inclui os enviados
 * antes de o robo existir. O que vai (imagem ou link) e o que foi tentado no
 * envio; nos antigos, o que o config manda hoje.
 */
async function anexarPendentes(db, { robo = null, config = lerConfig(), conta = "teste", antigos = false, linkDaFoto = drive.linkDaFoto, localizar = localizarFoto } = {}) {
    const empresaId = empresaDaConta(config, conta);
    if (!empresaId) throw new Error(`Sem empresa configurada para a conta ${conta}.`);
    const roboUsado = robo || roboPadrao(config, conta);
    await roboUsado.verificar({ empresaId });
    const modo = modoDaFoto(config);
    const linhas = db.prepare(`SELECT e.id, e.despesa_id, e.evento_id, e.relatorio, d.midia_id, d.campos, m.arquivo FROM envios_conta_azul e
        JOIN despesas d ON d.id = e.despesa_id LEFT JOIN midias m ON m.id = d.midia_id
        WHERE e.empresa_id = ? AND e.status IN ('ENVIADO', 'ENVIADO_INCOMPLETO') AND e.evento_id IS NOT NULL ORDER BY e.id`).all(empresaId);
    const resultados = [];
    for (const l of linhas) {
        const relatorio = JSON.parse(l.relatorio || "{}");
        if (relatorio.anexo?.ok) continue;
        const pendente = Boolean(relatorio.anexo);
        if (!pendente && !antigos) continue;
        const tipo = relatorio.anexo?.tipo || (modo.arquivo ? "arquivo" : "link");
        const camposDaNota = JSON.parse(l.campos || "{}");
        let anexo;
        if (tipo === "arquivo") {
            const campos = camposDaNota;
            const foto = campos.sem_comprovante?.valor ? null : localizar(l.arquivo);
            if (!foto) { resultados.push({ despesa_id: l.despesa_id, ok: false, erro: "foto da nota não encontrada no programa" }); continue; }
            anexo = { tipo, arquivo: foto, nome: relatorio.anexo?.nome || drive.nomeDoArquivo([{ id: l.despesa_id, tipo: campos.tipo?.valor || null, valor: campos.valor?.valor ?? null }], l.arquivo) };
        } else {
            const link = relatorio.foto_drive || linkDaFoto(db, l.midia_id, { config }).link;
            if (!link) { resultados.push({ despesa_id: l.despesa_id, ok: false, erro: "sem link da foto no Drive" }); continue; }
            anexo = { tipo, link };
            relatorio.foto_drive = link;
        }
        const resultado = await anexarComRobo(roboUsado, l.evento_id, anexo, { descricao: relatorio.anexo_descricao, valor: Number(camposDaNota.valor?.valor) || null });
        relatorio.anexo = resultado;
        relatorio.conferencia = [...(relatorio.conferencia || []).filter((c) => c.campo !== CAMPO_ANEXO && c.campo !== "foto anexada"), linhaDoAnexo(esperadoDoAnexo(anexo), resultado)];
        relatorio.faltou = relatorio.conferencia.filter((c) => !c.ok).map((c) => c.campo);
        relatorio.completo = relatorio.faltou.length === 0;
        relatorio.status = relatorio.completo ? "ENVIADO" : "ENVIADO_INCOMPLETO";
        db.prepare("UPDATE envios_conta_azul SET status = ?, relatorio = ?, atualizado_em = ? WHERE id = ?")
            .run(relatorio.status, JSON.stringify(relatorio), new Date().toISOString(), l.id);
        resultados.push({ despesa_id: l.despesa_id, ok: Boolean(resultado.ok), ja_tinha: Boolean(resultado.ja_tinha), erro: resultado.erro || null });
    }
    return resultados;
}

/**
 * Envia varias despesas aprovadas para UMA conta ("teste" ou "oficial"), uma a
 * uma, e devolve um resumo. Quem chama deve estar dentro de
 * contaAzul.comPerfil(conta, ...) para a API usar a conta certa. Cada nota tem
 * o seu resultado: o erro de uma nao impede as outras.
 */
async function enviarLote(db, ids, { api, config = lerConfig(), conta = "teste", autor = "sistema", pausaMs = 1500, aoAvancar = null, sinal = null, ...opcoes } = {}) {
    const empresa = await exigirEmpresa(api, config, conta);
    const modo = modoDaFoto(config);
    // Trava antes de comecar: robo sem sessao ou em outra empresa nao deixa criar nada.
    const robo = opcoes.robo || (modo.arquivo || modo.link ? roboPadrao(config, conta) : null);
    if (robo) await robo.verificar({ empresaId: empresa.id });
    const catalogo = opcoes.catalogo || await carregarCatalogo(api);
    const resultados = [];
    let parado = false;
    for (const [n, id] of ids.entries()) {
        // Pedido de parada (botao Parar): as notas ja enviadas ficam; as demais nem comecam.
        if (sinal?.parar) { parado = true; break; }
        let r = null;
        for (let tentativa = 0; tentativa < 2; tentativa += 1) {
            try {
                r = await enviar(db, id, { api, config, conta, autor, catalogo, empresa, ...opcoes, robo });
            } catch (erro) {
                r = { despesa_id: id, status: "NAO_ENVIADO", erro: erro.message };
            }
            // Limite da API (429): espera e tenta a mesma nota de novo.
            if (/429/.test(r.erro || "") && tentativa === 0) { await esperar(60000); continue; }
            break;
        }
        const resultado = { despesa_id: id, status: r.status, evento_id: r.evento_id || null, faltou: r.faltou || [], cadastros_criados: r.cadastros_criados || [], erro: r.erro || null };
        resultados.push(resultado);
        if (aoAvancar) { try { aoAvancar(resultado, n + 1, ids.length); } catch (_) { /* quem acompanha nao derruba o envio */ } }
        if (n < ids.length - 1 && pausaMs) await esperar(pausaMs);
    }
    const contar = (...status) => resultados.filter((r) => status.includes(r.status)).length;
    return {
        enviado: contar("ENVIADO", "ENVIADO_INCOMPLETO") > 0, conta, empresa, parado, pedidas: ids.length,
        resumo: { completas: contar("ENVIADO"), incompletas: contar("ENVIADO_INCOMPLETO"), incertas: contar("INCERTO"), nao_enviadas: contar("FALHOU", "NAO_ENVIADO") },
        resultados,
    };
}

/** Texto curto para o terminal / assistente. */
function relatorioEmTexto(r) {
    const linhas = [`Despesa #${r.despesa_id} → empresa ${r.empresa?.id} (${r.empresa?.nome}) · ${r.status}`];
    if (r.evento_id) linhas.push(`Lançamento ${r.evento_id} · parcela ${r.parcela_id || "-"}`);
    for (const e of r.etapas || []) linhas.push(`  ${e.ok ? "✓" : "✗"} ${e.etapa}`);
    for (const s of r.cadastros_criados || r.substituicoes || []) linhas.push(`  ⚠ ${s}`);
    for (const c of r.conferencia || []) {
        const marca = c.ok ? "✓" : c.campo === "foto anexada" ? "–" : "✗";
        linhas.push(`  ${marca} ${c.campo}: enviado ${JSON.stringify(c.esperado)} · no Conta Azul ${JSON.stringify(c.lido)}${c.nota ? ` (${c.nota})` : ""}`);
    }
    if (r.erro) linhas.push(`  Erro: ${r.erro}`);
    return linhas.join("\n");
}

module.exports = {
    dadosDaDespesa, mapear, fornecedorParaCriar, liberarReenvio, resolverFornecedor, exigirEmpresaDeTeste, exigirEmpresa, empresaDaConta, planejar,
    carregarCatalogo, pendentesDeEnvio, observacaoFinal, modoDaFoto, contaFinanceira, anexarPendentes, enviarLote, fecharRobo,
    corpoDoLancamento, enviar, conferir, relatorioEmTexto, localizarFoto,
};
