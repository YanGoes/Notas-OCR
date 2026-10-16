"use strict";

// =============================================================================
// FERRAMENTAS DO ASSISTENTE DA CENTRAL
// =============================================================================
//
// O assistente (Claude, pela assinatura da empresa) NAO le o banco direto:
// pede dados por estas ferramentas, com regras fixas. Assim ele so ve o que a
// ferramenta devolve e nunca ve telefone.
//
// Cada ferramenta: { nome, descricao, esquema (JSON Schema), grava, executar }.
// `grava: true` = NAO executa na hora: vira proposta que so roda com o
// Confirmar de uma pessoa autorizada na tela.
// =============================================================================

const fs = require("fs");
const path = require("path");
const { lerJson, agora, json } = require("../central/banco");
const cadastros = require("../central/cadastros");
const { normalizar, contemTermo } = require("../central/texto");

const RAIZ = path.resolve(__dirname, "..", "..");
const LIMITE_LINHAS = 60;
const ESTADOS_VALIDOS = ["AGUARDANDO_REVISAO", "CLASSIFICADO", "APROVADO"];

const hojeIso = () => new Date().toISOString().slice(0, 10);
const dataBr = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : null);
const centavos = (valor) => Math.round(Number(valor || 0) * 100) / 100;

/** Despesas da Central em forma simples (sem telefone, sem caminho de arquivo). */
function despesasCentral(db, { incluirDescartadas = false } = {}) {
    const linhas = db.prepare(`
        SELECT d.id, d.estado, d.campos, d.pendencias, d.criado_em, m.remetente_nome, m.pessoa_id, m.grupo_id
        FROM despesas d LEFT JOIN mensagens m ON m.id = d.mensagem_ref`).all();
    return linhas.filter((linha) => incluirDescartadas || ESTADOS_VALIDOS.includes(linha.estado)).map((linha) => {
        const campos = lerJson(linha.campos, {});
        return {
            id: linha.id, estado: linha.estado,
            operador: campos.remetente?.valor || linha.remetente_nome || "Não identificado", pessoa_id: linha.pessoa_id || null,
            data: campos.data_competencia?.valor || String(linha.criado_em || "").slice(0, 10), valor: Number(campos.valor?.valor) || 0,
            tipo: campos.tipo?.valor || null, fornecedor: campos.fornecedor?.valor || null, categoria: campos.categoria?.nome || null,
            centro: campos.centro_custo?.nome || campos.centro_custo?.texto_informado || null, pagamento: campos.pagamento?.cartao || campos.pagamento?.forma || null,
            descricao: campos.descricao?.valor || null, pessoas: campos.pessoas?.valor ?? null,
            pendencias: lerJson(linha.pendencias, []).length, privado: !String(linha.grupo_id || "").endsWith("@g.us"),
        };
    });
}

function lancamentosPlanilha() {
    const dados = lerJson(fs.existsSync(arquivoLancamentos()) ? fs.readFileSync(arquivoLancamentos(), "utf8") : null, null);
    return { fonte: dados?.fonte || null, gerado_em: dados?.gerado_em || null, lancamentos: dados?.lancamentos || [] };
}
const arquivoLancamentos = () => path.join(RAIZ, "dados", "aprendizado", "lancamentos-conta-azul.json");

function filtrarPeriodo(lista, de, ate) {
    return lista.filter((item) => item.data && (!de || item.data >= de) && (!ate || item.data <= ate));
}

function agrupar(lista, chave) {
    const grupos = new Map();
    for (const item of lista) {
        const nome = (chave === "mes" ? String(item.data || "").slice(0, 7) : item[chave]) || "(não informado)";
        const atual = grupos.get(nome) || { grupo: nome, quantidade: 0, total: 0 };
        atual.quantidade += 1;
        atual.total += Math.abs(item.valor);
        grupos.set(nome, atual);
    }
    return [...grupos.values()].map((g) => ({ ...g, total: centavos(g.total), media: centavos(g.total / g.quantidade) }))
        .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------

function relatorioGastos(ctx, { de, ate, agrupar_por = "operador", fonte = "central", operador, centro, categoria } = {}) {
    const inicio = de || `${hojeIso().slice(0, 7)}-01`;
    const fim = ate || hojeIso();
    let lista;
    let origem;
    if (fonte === "planilha") {
        const planilha = lancamentosPlanilha();
        if (!planilha.lancamentos.length) throw new Error("Planilha do Conta Azul ainda não importada (atalho 14).");
        lista = planilha.lancamentos.map((item) => ({ ...item, operador: item.referencia || null }));
        origem = `planilha do Conta Azul (${planilha.fonte}, exportada em ${dataBr(planilha.gerado_em)})`;
    } else {
        lista = despesasCentral(ctx.db);
        origem = "notas da Central (coletadas do WhatsApp desde 11/10/2026; inclui as ainda em revisão)";
    }
    lista = filtrarPeriodo(lista, inicio, fim)
        .filter((item) => !operador || contemTermo(item.operador || "", operador))
        .filter((item) => !centro || contemTermo(item.centro || "", centro))
        .filter((item) => !categoria || contemTermo(item.categoria || "", categoria));
    const total = centavos(lista.reduce((soma, item) => soma + Math.abs(item.valor), 0));
    const chave = { operador: "operador", centro: "centro", categoria: "categoria", tipo: "tipo", fornecedor: "fornecedor", dia: "data", mes: "mes" }[agrupar_por] || "operador";
    return {
        fonte: origem, periodo: { de: inicio, ate: fim }, quantidade: lista.length, total,
        media_por_lancamento: lista.length ? centavos(total / lista.length) : 0,
        grupos: agrupar(lista, chave).slice(0, LIMITE_LINHAS),
        observacao: fonte === "planilha" ? "Na planilha, 'operador' é o código de referência (ex.: RESP. VITOR), nem sempre preenchido." : undefined,
    };
}

function ultimoEnvioPorOperador(ctx) {
    const nomes = new Map(ctx.cad.pessoas.map((pessoa) => [pessoa.id, pessoa.nome]));
    const linhas = ctx.db.prepare(`
        SELECT COALESCE(pessoa_id, remetente_nome, remetente_id) AS quem, pessoa_id, MAX(enviada_em) AS ultima,
            SUM(CASE WHEN tem_midia = 1 THEN 1 ELSE 0 END) AS fotos,
            SUM(CASE WHEN tem_midia = 1 AND enviada_em >= ? THEN 1 ELSE 0 END) AS fotos_7_dias
        FROM mensagens GROUP BY quem ORDER BY ultima DESC`).all(new Date(Date.now() - 7 * 86400000).toISOString());
    const hoje = Date.now();
    return linhas.filter((linha) => linha.fotos > 0).map((linha) => ({
        operador: nomes.get(linha.pessoa_id) || (String(linha.quem).includes("@") ? "Não identificado" : linha.quem),
        ultimo_envio: linha.ultima, dias_sem_enviar: Math.floor((hoje - Date.parse(linha.ultima)) / 86400000),
        fotos_total: linha.fotos, fotos_ultimos_7_dias: linha.fotos_7_dias,
    }));
}

function buscarDespesas(ctx, { operador, estado, de, ate, tipo, centro, texto, valor_min, valor_max, limite = 30 } = {}) {
    const estados = { revisar: "AGUARDANDO_REVISAO", classificadas: "CLASSIFICADO", aprovadas: "APROVADO", descartadas: "DESCARTADO" };
    const alvoEstado = estado ? (estados[String(estado).toLowerCase()] || String(estado).toUpperCase()) : null;
    const lista = despesasCentral(ctx.db, { incluirDescartadas: alvoEstado === "DESCARTADO" })
        .filter((item) => !alvoEstado || item.estado === alvoEstado)
        .filter((item) => (!de || item.data >= de) && (!ate || item.data <= ate))
        .filter((item) => !operador || contemTermo(item.operador || "", operador))
        .filter((item) => !tipo || normalizar(item.tipo || "") === normalizar(tipo))
        .filter((item) => !centro || contemTermo(item.centro || "", centro))
        .filter((item) => !texto || contemTermo([item.fornecedor, item.descricao, item.categoria, item.centro].join(" "), texto))
        .filter((item) => (valor_min == null || Math.abs(item.valor) >= valor_min) && (valor_max == null || Math.abs(item.valor) <= valor_max))
        .sort((a, b) => String(b.data).localeCompare(String(a.data)));
    return { encontradas: lista.length, despesas: lista.slice(0, Math.min(Number(limite) || 30, LIMITE_LINHAS)) };
}

function detalharDespesa(ctx, { id } = {}) {
    const linha = ctx.db.prepare("SELECT * FROM despesas WHERE id = ?").get(Number(id));
    if (!linha) throw new Error(`Despesa #${id} não existe.`);
    const campos = lerJson(linha.campos, {});
    const mensagem = linha.mensagem_ref ? ctx.db.prepare("SELECT remetente_nome, enviada_em, texto FROM mensagens WHERE id = ?").get(linha.mensagem_ref) : null;
    const correcoes = ctx.db.prepare("SELECT campo, valor_anterior, valor_novo, tipo_erro, observacao, autor, em FROM correcoes WHERE despesa_id = ? ORDER BY id").all(linha.id);
    const resumo = Object.fromEntries(Object.entries(campos).map(([chave, valor]) => [chave, valor && typeof valor === "object"
        ? Object.fromEntries(Object.entries(valor).filter(([k]) => ["valor", "nome", "origem", "cartao", "forma", "texto_informado", "status", "sugestao", "litros", "odometro", "placa"].includes(k)))
        : valor]));
    return {
        id: linha.id, estado: linha.estado, campos: resumo, pendencias: lerJson(linha.pendencias, []), avisos: lerJson(linha.avisos, []),
        mensagem_do_operador: mensagem ? { quem: mensagem.remetente_nome, quando: mensagem.enviada_em, texto: mensagem.texto } : null,
        correcoes,
    };
}

function consultarDrive(ctx, { operador, ano, mes } = {}) {
    const config = lerJson(fs.existsSync(path.join(RAIZ, "config.json")) ? fs.readFileSync(path.join(RAIZ, "config.json"), "utf8") : null, {});
    const drive = config.arquivo_drive || {};
    if (!drive.raiz) throw new Error("Pasta do Drive não configurada (config.json, arquivo_drive.raiz).");
    const anoAlvo = String(ano || new Date().getFullYear());
    const base = path.join(drive.raiz, anoAlvo, String(drive.modelo_pasta_ano || "Despesas de Campo {ano}").replace("{ano}", anoAlvo));
    if (!fs.existsSync(base)) return { pasta: `${anoAlvo}/${path.basename(base)}`, existe: false, aviso: "Pasta não encontrada (o Google Drive está sincronizado neste PC?)." };
    const pastas = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const arquivos = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !/^desktop\.ini$/i.test(e.name)).length;
    const operadores = pastas(base).filter((nome) => !operador || contemTermo(nome, operador));
    const mesAlvo = mes ? `${String(mes).padStart(2, "0")}.${anoAlvo.slice(2)}` : null;
    const resultado = operadores.map((nome) => {
        const meses = pastas(path.join(base, nome)).filter((m) => !mesAlvo || m === mesAlvo).map((m) => {
            const dias = pastas(path.join(base, nome, m));
            const porDia = dias.map((d) => ({ dia: d, comprovantes: arquivos(path.join(base, nome, m, d)) }));
            return { mes: m, dias_com_comprovante: porDia.filter((d) => d.comprovantes).length, comprovantes: porDia.reduce((s, d) => s + d.comprovantes, 0),
                ultimo_dia: porDia.filter((d) => d.comprovantes).map((d) => d.dia).sort((a, b) => a.split(".").reverse().join("").localeCompare(b.split(".").reverse().join(""))).pop() || null };
        });
        return { operador: nome, meses };
    });
    return { pasta: `${anoAlvo}/${path.basename(base)}`, operadores: resultado };
}

async function situacaoDoSistema(ctx) {
    const resultado = {};
    try {
        const resposta = await fetch("http://127.0.0.1:3211/api/status", { signal: AbortSignal.timeout(4000) });
        const status = await resposta.json();
        resultado.whatsapp = { status: status.whatsapp?.status, conectado_desde: status.whatsapp?.conectado_desde,
            grupos_monitorados: status.grupos?.grupos_permitidos?.length || 0, contatos_no_privado: status.grupos?.contatos_permitidos?.length || 0 };
    } catch (_) { resultado.whatsapp = { status: "coleta fora do ar" }; }
    try { resultado.azure = JSON.parse(fs.readFileSync(path.join(RAIZ, "dados", "azure-uso.json"), "utf8")); } catch (_) { resultado.azure = null; }
    const backups = path.join(RAIZ, "dados", "backups");
    resultado.ultimo_backup = fs.existsSync(backups) ? fs.readdirSync(backups).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().pop() || null : null;
    const contagem = ctx.db.prepare("SELECT estado, COUNT(*) AS n FROM despesas GROUP BY estado").all();
    resultado.notas = Object.fromEntries(contagem.map((linha) => [linha.estado, linha.n]));
    try {
        const log = fs.readFileSync(path.join(RAIZ, "dados", "logs", "whatsapp-conexao.log"), "utf8").trim().split(/\r?\n/).slice(-5);
        resultado.ultimos_eventos_whatsapp = log.map((linha) => linha.slice(0, 160));
    } catch (_) { /* sem log */ }
    resultado.conta_azul = "Conectado à conta de TESTE do Conta Azul. Lançamento real desligado (fase de testes).";
    return resultado;
}

function maturidadeDaIa() {
    const arquivo = path.join(RAIZ, "dados", "aprendizado", "medicao-aprovadas.json");
    if (!fs.existsSync(arquivo)) return { aviso: "Ainda não medida (atalho 14)." };
    const medicao = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    return { medida_em: medicao.gerado_em, aprovadas: medicao.aprovadas, ...medicao.maturidade };
}

function consultarCadastros(ctx, { tipo = "centros", busca } = {}) {
    const filtro = (texto) => !busca || contemTermo(String(texto || ""), busca);
    const cad = ctx.cad;
    switch (tipo) {
        case "centros": return cadastros.projetosComId(cad).filter((p) => filtro([p.nome_oficial, p.centro_conta_azul, ...(p.apelidos || [])].join(" ")))
            .slice(0, LIMITE_LINHAS).map((p) => ({ projeto: p.nome_oficial, centro_conta_azul: cadastros.nomeCentro(p), ativo: p.ativo ?? null, cartao: p.cartao || null, ultimo_uso: p.ultimo_uso || null }));
        case "categorias": return cad.categorias.filter((c) => filtro([c.nome, c.nome_conta_azul].join(" "))).slice(0, LIMITE_LINHAS)
            .map((c) => ({ nome: c.nome_conta_azul || c.nome, interno: c.nome, tem_id: Boolean(c.id && !String(c.id).startsWith("PREENCHER")) }));
        case "fornecedores": return (cad.fornecedores.opcoes || []).filter(filtro).slice(0, LIMITE_LINHAS);
        case "cartoes": return cad.cartoes.map((c) => ({ codigo: c.codigo, rotulo: c.rotulo }));
        case "veiculos": return cad.veiculos.filter((v) => filtro([v.nome, v.placa].join(" "))).map((v) => ({ nome: v.nome, placa: v.placa, ativo: v.ativo ?? null }));
        case "pessoas": return cad.pessoas.filter((p) => filtro(p.nome)).map((p) => ({ nome: p.nome, papel: p.papel || null }));
        default: throw new Error("Tipo de cadastro desconhecido: use centros, categorias, fornecedores, cartoes, veiculos ou pessoas.");
    }
}

function registrarSugestao(ctx, { texto, tipo = "melhoria" } = {}) {
    const limpo = String(texto || "").trim();
    if (limpo.length < 5) throw new Error("Escreva a sugestão.");
    const { lastInsertRowid } = ctx.db.prepare("INSERT INTO assistente_sugestoes (pessoa, texto, tipo, conversa_id, em) VALUES (?, ?, ?, ?, ?)")
        .run(ctx.pessoa || "?", limpo.slice(0, 2000), String(tipo).slice(0, 30), ctx.conversaId || null, agora());
    return { registrada: true, id: Number(lastInsertRowid), mensagem: "Sugestão anotada para o Yan avaliar." };
}

function resumoLancamento({ ids = [] } = {}) {
    return `Lançar no Conta Azul ${ids.length} despesa(s) aprovada(s): ${ids.map((id) => `#${id}`).join(", ")}`;
}

/**
 * Executa um lancamento CONFIRMADO por uma pessoa. Enquanto o lancamento
 * estiver desligado no config (fase de testes), nao envia nada e diz por que.
 */
function lancarConfirmado(ctx, { ids = [] } = {}) {
    const lista = ids.map(Number).filter(Number.isInteger);
    if (!lista.length) throw new Error("Nenhuma despesa informada.");
    const estados = ctx.db.prepare(`SELECT id, estado FROM despesas WHERE id IN (${lista.map(() => "?").join(",")})`).all(...lista);
    const naoAprovadas = lista.filter((id) => estados.find((linha) => linha.id === id)?.estado !== "APROVADO");
    if (naoAprovadas.length) throw new Error(`Só despesas aprovadas na Central podem ser lançadas. Não aprovadas: ${naoAprovadas.map((id) => `#${id}`).join(", ")}.`);
    const config = lerJson(fs.readFileSync(path.join(RAIZ, "config.json"), "utf8"), {});
    if (!config.central?.lancamento_habilitado) {
        return { enviado: false, motivo: "Lançamento pelo assistente está desligado (fase de testes). Nada foi enviado ao Conta Azul. Para ligar: config.json → central.lancamento_habilitado." };
    }
    if (typeof ctx.lancar !== "function") throw new Error("Envio ao Conta Azul não disponível neste processo.");
    return ctx.lancar(lista);
}

/** Retreino confirmado: catalogo + treino + medicao + refaz as previas em revisao (igual ao atalho 14). */
async function treinarConfirmado(ctx) {
    const { execFile } = require("child_process");
    const rodar = (args) => new Promise((resolver, rejeitar) => execFile(process.execPath, args, { cwd: RAIZ, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
        (erro, saida) => (erro ? rejeitar(new Error(String(erro.message).slice(0, 300))) : resolver(String(saida)))));
    const planilha = [path.join(RAIZ, "..", "visao_contas_a_pagar (3).xlsx"), "C:\\Users\\vmac_\\Desktop\\APRENDIZADO DE IA - DESPESAS\\visao_contas_a_pagar (1).xls"].find((p) => fs.existsSync(p));
    if (planilha) {
        await rodar([path.join("ferramentas", "importar-catalogo-conta-azul.js"), planilha]);
        await rodar([path.join("ferramentas", "treinar-central.js"), planilha]);
    }
    const medicao = await rodar([path.join("ferramentas", "medir-contra-aprovadas.js")]);
    const regeradas = typeof ctx.regerar === "function" ? ctx.regerar() : null;
    return { treinado: Boolean(planilha), resumo: medicao.split(/\r?\n/).filter((l) => /notas inteiras|TOTAL|MATURIDADE|Próximo estágio/.test(l)).join("\n"), previas_refeitas: regeradas };
}

// ---------------------------------------------------------------------------

const DATA ={ type: "string", description: "Data AAAA-MM-DD" };
const FERRAMENTAS = [
    { nome: "relatorio_gastos", grava: false, executar: relatorioGastos,
        descricao: "Total, quantidade e média de gastos num período, agrupados por operador, centro, categoria, tipo, fornecedor, dia ou mês. Fonte 'central' (notas do WhatsApp desde 11/10/2026) ou 'planilha' (exportação do Conta Azul, meses anteriores).",
        esquema: { type: "object", properties: { de: DATA, ate: DATA, agrupar_por: { type: "string", enum: ["operador", "centro", "categoria", "tipo", "fornecedor", "dia", "mes"] },
            fonte: { type: "string", enum: ["central", "planilha"] }, operador: { type: "string" }, centro: { type: "string" }, categoria: { type: "string" } } } },
    { nome: "ultimo_envio_por_operador", grava: false, executar: ultimoEnvioPorOperador,
        descricao: "Último dia em que cada operador mandou nota no WhatsApp, dias sem enviar e fotos dos últimos 7 dias.", esquema: { type: "object", properties: {} } },
    { nome: "buscar_despesas", grava: false, executar: buscarDespesas,
        descricao: "Procura notas na Central por operador, estado (revisar, classificadas, aprovadas, descartadas), período, tipo, centro, texto ou faixa de valor.",
        esquema: { type: "object", properties: { operador: { type: "string" }, estado: { type: "string" }, de: DATA, ate: DATA, tipo: { type: "string" }, centro: { type: "string" },
            texto: { type: "string" }, valor_min: { type: "number" }, valor_max: { type: "number" }, limite: { type: "integer" } } } },
    { nome: "detalhar_despesa", grava: false, executar: detalharDespesa,
        descricao: "Tudo sobre uma nota (#id): campos e de onde veio cada um, pendências, avisos, mensagem do operador e correções feitas.",
        esquema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
    { nome: "consultar_drive", grava: false, executar: consultarDrive,
        descricao: "Comprovantes arquivados no Google Drive por operador e mês (quantos, dias com comprovante, último dia). Só leitura.",
        esquema: { type: "object", properties: { operador: { type: "string" }, ano: { type: "integer" }, mes: { type: "integer" } } } },
    { nome: "situacao_do_sistema", grava: false, executar: situacaoDoSistema,
        descricao: "Estado do programa: WhatsApp conectado?, grupos e contatos monitorados, cota do Azure, último backup, notas por estado, últimos eventos da conexão.", esquema: { type: "object", properties: {} } },
    { nome: "maturidade_da_ia", grava: false, executar: maturidadeDaIa,
        descricao: "Última medição de acerto da IA contra as notas aprovadas (estágio, notas inteiras certas, campos que mais erram).", esquema: { type: "object", properties: {} } },
    { nome: "cadastros", grava: false, executar: consultarCadastros,
        descricao: "Consulta cadastros: centros (projetos e centros do Conta Azul, com cartão), categorias, fornecedores, cartoes, veiculos ou pessoas (sem telefone).",
        esquema: { type: "object", properties: { tipo: { type: "string", enum: ["centros", "categorias", "fornecedores", "cartoes", "veiculos", "pessoas"] }, busca: { type: "string" } }, required: ["tipo"] } },
    { nome: "registrar_sugestao", grava: false, executar: registrarSugestao,
        descricao: "Anota uma ideia de melhoria ou um problema relatado na conversa, para o Yan avaliar depois.",
        esquema: { type: "object", properties: { texto: { type: "string" }, tipo: { type: "string", enum: ["melhoria", "problema", "duvida"] } }, required: ["texto"] } },
    { nome: "preparar_lancamento", grava: true, executar: lancarConfirmado, resumir: resumoLancamento,
        descricao: "SÓ quando a pessoa pedir explicitamente para lançar: prepara o lançamento no Conta Azul das despesas APROVADAS indicadas. Não lança: a tela mostra um botão Confirmar e só uma pessoa autorizada executa.",
        esquema: { type: "object", properties: { ids: { type: "array", items: { type: "integer" } } }, required: ["ids"] } },
    { nome: "treinar_ia", grava: true, executar: treinarConfirmado, resumir: () => "Retreinar a IA (catálogo do Conta Azul, treino, medição da maturidade e atualização das notas em revisão)",
        descricao: "SÓ quando a pessoa pedir: retreina a IA com as notas aprovadas e a planilha do Conta Azul, mede a maturidade e refaz as prévias em revisão. Vira um botão Confirmar.",
        esquema: { type: "object", properties: {} } },
];

const porNome = new Map(FERRAMENTAS.map((ferramenta) => [ferramenta.nome, ferramenta]));
function obter(nome) {
    const ferramenta = porNome.get(nome);
    if (!ferramenta) throw new Error(`Ferramenta "${nome}" não existe.`);
    return ferramenta;
}
async function executar(nome, parametros, ctx) { return obter(nome).executar(ctx, parametros || {}); }

module.exports = { FERRAMENTAS, obter, executar, despesasCentral, json };
