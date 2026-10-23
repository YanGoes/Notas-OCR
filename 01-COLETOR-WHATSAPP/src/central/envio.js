"use strict";

// =============================================================================
// ENVIO DE UMA DESPESA APROVADA PARA O CONTA AZUL (somente empresa de teste)
// =============================================================================
//
// Caminho escolhido por teste real (19/10/2026, conta de teste):
//   - Captura + aceite: a previa NAO pode ser editada (405) e o PATCH da parcela
//     ignora categoria/centro -> a categoria fica a que a Captura chutou e o
//     centro vazio. Descartado.
//   - POST /v1/financeiro/contas-a-pagar (endpoint novo): grava categoria,
//     centro, fornecedor, conta financeira, descricao, observacao e forma.
//     So nao aceita a foto (a API nao tem envio de anexo). Usado aqui.
//
// Depois de criar, RELE o lancamento e confere campo a campo o que ficou gravado.
// Trava dura: so envia se a empresa conectada for a de teste configurada em
// config.central.envio_conta_azul.somente_empresa_id. Nao existe DELETE na API.
// =============================================================================

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..", "..");
const PASTAS_IMAGEM = ["entrada", "simulacao", "revisao", "bloqueados", "erros", "enviados", "importados"];

// Na conta de teste as categorias da VMac nao existem: usa a mais parecida
// e avisa no relatorio. Na conta oficial isso nunca e usado.
const SUBSTITUTOS_TESTE = {
    ALMOCO: "Refeição - Almoço",
    JANTAR: "Refeição - Jantar",
    CAFE_DA_MANHA: "Refeição - Café da Manhã",
    LANCHE: "Lanches e Refeições",
    AGUA: "Lanches e Refeições",
    ABASTECIMENTO: "Combustíveis",
    PEDAGIO: "Pedágios",
    HOSPEDAGEM: "HOSPEDAGEM",
    MANUTENCAO: "Manutenção de Veículos",
    ESTACIONAMENTO: "Estacionamento",
    MERCADO: "Lanches e Refeições",
    OUTROS: "Despesas a identificar",
};
// Categorias da VMac sem tipo proprio que tem equivalente na conta de teste.
const SUBSTITUTOS_TESTE_POR_CATEGORIA = {
    "material de campo": "Materiais Aplicados na Prestação de Serviços",
};
const CENTRO_TESTE = "TESTE CC";

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

/**
 * Traduz categoria e centro para os IDs da empresa conectada. Na empresa de
 * teste, quando o nome da VMac nao existe, usa um substituto e registra.
 */
function mapear(dados, { categorias, centros }, { teste }) {
    const substituicoes = [];
    let categoria = acharPorNome(categorias, dados.categoria);
    if (!categoria && teste) {
        categoria = acharPorNome(categorias, SUBSTITUTOS_TESTE_POR_CATEGORIA[normalizar(dados.categoria)] || SUBSTITUTOS_TESTE[dados.tipo]);
        if (categoria) substituicoes.push(`categoria "${dados.categoria}" não existe na conta de teste → usada "${categoria.nome.trim()}"`);
    }
    let centro = acharPorNome(centros, dados.centro);
    if (!centro && teste) {
        centro = acharPorNome(centros, CENTRO_TESTE);
        if (centro) substituicoes.push(`centro "${dados.centro}" não existe na conta de teste → usado "${centro.nome}"`);
    }
    return { categoria, centro, substituicoes };
}

/**
 * Fornecedor: pelo CNPJ lido na nota; sem CNPJ, pelo fornecedor generico
 * aprovado na revisao (ex.: RESTAURANTES) — nunca por um nome lido sem CNPJ,
 * que costuma ser lixo do cupom ("Sua senha").
 * `criar` (so na conta de teste) cadastra o que faltar: CNPJ + nome lido, ou
 * o generico aprovado.
 */
async function resolverFornecedor(api, dados, { criar = false } = {}) {
    const ativo = (lista) => lista.find((p) => p.ativo !== false && (p.perfis || []).includes("Fornecedor")) || null;
    const cnpjValido = [11, 14].includes(String(dados.fornecedor_cnpj || "").length);
    if (cnpjValido) {
        const achado = ativo(await api.buscarPessoas({ documentos: dados.fornecedor_cnpj }));
        if (achado) return { ...achado, por: "CNPJ da nota" };
        if (criar && dados.fornecedor_nome_lido) {
            const novo = await api.criarFornecedor({ nome: dados.fornecedor_nome_lido, documento: dados.fornecedor_cnpj });
            return { ...novo, por: "CNPJ da nota (cadastrado agora na conta de teste)" };
        }
    }
    if (dados.fornecedor) {
        const lista = await api.buscarPessoas({ busca: dados.fornecedor });
        const achado = ativo(lista.filter((p) => normalizar(p.nome) === normalizar(dados.fornecedor)));
        if (achado) return { ...achado, por: "fornecedor aprovado" };
        if (criar) {
            const novo = await api.criarFornecedor({ nome: dados.fornecedor });
            return { ...novo, por: "fornecedor aprovado (cadastrado agora na conta de teste)" };
        }
    }
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

function carregarDespesa(db, despesaId) {
    const linha = db.prepare(`SELECT d.id, d.estado, d.campos, m.arquivo FROM despesas d
        LEFT JOIN midias m ON m.id = d.midia_id WHERE d.id = ?`).get(despesaId);
    if (!linha) throw new Error(`Despesa #${despesaId} não encontrada.`);
    return { ...linha, campos: JSON.parse(linha.campos) };
}

function envioAnterior(db, despesaId, empresaId) {
    return db.prepare(`SELECT * FROM envios_conta_azul WHERE despesa_id = ? AND empresa_id = ?
        AND status IN ('ENVIADO', 'ENVIADO_INCOMPLETO', 'EM_ANDAMENTO', 'INCERTO') ORDER BY id DESC LIMIT 1`).get(despesaId, empresaId);
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

/** Monta o plano sem gravar nada no Conta Azul (so leituras). */
async function planejar(db, despesaId, { api, config = lerConfig(), catalogo = null, criarFornecedor = false, empresa: empresaConferida = null } = {}) {
    const empresa = empresaConferida || await exigirEmpresaDeTeste(api, config);
    const despesa = carregarDespesa(db, despesaId);
    if (despesa.estado !== "APROVADO") throw new Error(`Despesa #${despesaId} está ${despesa.estado}; só aprovadas são enviadas.`);
    const anterior = envioAnterior(db, despesaId, empresa.id);
    if (anterior) throw new Error(`Despesa #${despesaId} já foi enviada para esta empresa (envio ${anterior.id}, ${anterior.status}).`);
    const dados = dadosDaDespesa(despesa.campos);
    if (!(dados.valor > 0) || !dados.data) throw new Error(`Despesa #${despesaId} sem valor ou data.`);
    const { categorias, centros, contas } = catalogo || await carregarCatalogo(api);
    const mapa = mapear(dados, { categorias, centros }, { teste: true });
    if (!mapa.categoria) throw new Error(`Categoria "${dados.categoria}" não encontrada no Conta Azul.`);
    // Conta de teste tem uma unica conta financeira ("Teste"); a conta oficial
    // vai precisar do de-para cartao -> conta financeira.
    const conta = contas.find((c) => c.conta_padrao) || contas[0] || null;
    if (!conta) throw new Error("Nenhuma conta financeira ativa no Conta Azul.");
    const fornecedor = await resolverFornecedor(api, dados, { criar: criarFornecedor });
    if (!fornecedor) throw new Error(`Fornecedor não encontrado no Conta Azul (CNPJ ${dados.fornecedor_cnpj || "não lido"}, nome "${dados.fornecedor_nome_lido || dados.fornecedor || "-"}"). Cadastre-o no Conta Azul antes de enviar.`);
    return { empresa, despesa_id: despesaId, foto: localizarFoto(despesa.arquivo), dados, mapa, conta, fornecedor };
}

/** Observacao final: a da despesa + a descricao do anexo (ex.: REEMBOLSO X), sem repetir. */
function observacaoFinal(dados) {
    const partes = [dados.observacao, dados.anexo_descricao].filter(Boolean);
    return [...new Set(partes)].join(" | ") || null;
}

function corpoDoLancamento(plano) {
    const { dados, mapa, conta, fornecedor } = plano;
    const valor = Number(dados.valor.toFixed(2));
    const rateio = { id_categoria: mapa.categoria.id, valor };
    if (mapa.centro) rateio.rateio_centro_custo = [{ id_centro_custo: mapa.centro.id, valor }];
    const descricao = String(dados.descricao || mapa.categoria.nome.trim()).slice(0, 255);
    const observacao = observacaoFinal(dados);
    return {
        descricao, data_competencia: dados.data, valor, conta_financeira: conta.id, id_fornecedor: fornecedor.id,
        ...(observacao ? { observacao } : {}),
        referencia_externa: `central-${plano.despesa_id}`,
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
        linha("foto anexada", "foto da nota", "não enviada", false, "a API do Conta Azul não tem envio de anexo; a foto fica no arquivo do Drive"),
    ];
}

/**
 * Envia de verdade. Sempre devolve um relatorio e registra em
 * envios_conta_azul para nunca enviar a mesma despesa duas vezes.
 */
async function enviar(db, despesaId, { api, config = lerConfig(), autor = "sistema", ...opcoes } = {}) {
    const plano = await planejar(db, despesaId, { api, config, ...opcoes });
    const agora = () => new Date().toISOString();
    const envioId = Number(db.prepare(`INSERT INTO envios_conta_azul (despesa_id, empresa_id, status, autor, criado_em, atualizado_em)
        VALUES (?, ?, 'EM_ANDAMENTO', ?, ?, ?)`).run(despesaId, plano.empresa.id, autor, agora(), agora()).lastInsertRowid);
    const relatorio = { envio_id: envioId, despesa_id: despesaId, empresa: plano.empresa, substituicoes: plano.mapa.substituicoes, etapas: [] };
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
    try {
        const parcela = await api.obterParcelaFinanceira(relatorio.parcela_id);
        const busca = await api.buscarContasPagar({ data_vencimento_de: corpo.data_competencia, data_vencimento_ate: corpo.data_competencia });
        const item = (busca?.itens || busca?.items || []).find((i) => i.id === relatorio.parcela_id) || null;
        relatorio.etapas.push({ etapa: "lançamento relido no Conta Azul", ok: Boolean(parcela && item) });
        relatorio.conferencia = conferir(plano, corpo, { criado, parcela, busca: item });
    } catch (erro) {
        return salvar("ENVIADO_INCOMPLETO", { erro: `Criado, mas a releitura falhou: ${erro.message}` });
    }
    // A foto nunca vai pela API: isso nao torna o envio incompleto, so e informado.
    const faltou = relatorio.conferencia.filter((c) => !c.ok && c.campo !== "foto anexada").map((c) => c.campo);
    relatorio.completo = faltou.length === 0;
    relatorio.faltou = faltou;
    return salvar(faltou.length ? "ENVIADO_INCOMPLETO" : "ENVIADO");
}

/** Texto curto para o terminal / assistente. */
function relatorioEmTexto(r) {
    const linhas = [`Despesa #${r.despesa_id} → empresa ${r.empresa?.id} (${r.empresa?.nome}) · ${r.status}`];
    if (r.evento_id) linhas.push(`Lançamento ${r.evento_id} · parcela ${r.parcela_id || "-"}`);
    for (const e of r.etapas || []) linhas.push(`  ${e.ok ? "✓" : "✗"} ${e.etapa}`);
    for (const s of r.substituicoes || []) linhas.push(`  ⚠ ${s}`);
    for (const c of r.conferencia || []) {
        const marca = c.ok ? "✓" : c.campo === "foto anexada" ? "–" : "✗";
        linhas.push(`  ${marca} ${c.campo}: enviado ${JSON.stringify(c.esperado)} · no Conta Azul ${JSON.stringify(c.lido)}${c.nota ? ` (${c.nota})` : ""}`);
    }
    if (r.erro) linhas.push(`  Erro: ${r.erro}`);
    return linhas.join("\n");
}

module.exports = {
    SUBSTITUTOS_TESTE, dadosDaDespesa, mapear, resolverFornecedor, exigirEmpresaDeTeste, planejar,
    carregarCatalogo, pendentesDeEnvio,
    corpoDoLancamento, enviar, conferir, relatorioEmTexto, localizarFoto,
};
