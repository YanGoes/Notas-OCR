"use strict";

// =============================================================================
// TREINO COM O HISTORICO (fotos antigas do Drive + lancamentos do Conta Azul)
// =============================================================================
//
// Simula o operador mandando a nota no PADRAO combinado, sem mexer no WhatsApp
// (enviar centenas de fotos por um numero automatizado arrisca o bloqueio do
// numero). Cada foto passa pelo MESMO caminho de uma nota real:
//
//   1. foto do Drive (pasta do operador e do dia) -> leitura do Azure (cota!);
//   2. acha o lancamento dessa nota no Conta Azul (mesmo valor, data proxima):
//      e a "resposta certa", lancada por uma pessoa;
//   3. monta o resumo do dia e a legenda no padrao ("Despesas 10/09/2026 /
//      Centro de custo / Cartão" + "Almoço 3") a partir desse lancamento;
//   4. registra na Central como mensagem do grupo "Eu e Eu", em nome do
//      operador (remetente "historico:<operador>");
//   5. compara a previa da IA com o Conta Azul: tudo igual -> aprovada por
//      "Conta Azul (histórico)" e vira exemplo de treino; diferente -> fica
//      em "Para revisar" com o que o Conta Azul lançou, para o Yan decidir.
//
//   node ferramentas/treino-historico.js --operador Almir --max 20            (só lista, sem Azure)
//   node ferramentas/treino-historico.js --operador Almir --max 20 --executar (lê e registra)
//   opcoes: --de 2026-08-01 --ate 2026-10-15 --reservar 80 (paginas do Azure guardadas p/ notas reais)
// =============================================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RAIZ = path.resolve(__dirname, "..");
const { banco, lerJson, agora } = require("../src/central/banco");
const cadastros = require("../src/central/cadastros");
const orquestrador = require("../src/central/orquestrador");
const revisao = require("../src/central/revisao");
const { normalizar } = require("../src/central/texto");

const GRUPO_TREINO = "120363428228243329@g.us"; // "Eu e Eu"
const REGISTRO = path.join(RAIZ, "dados", "aprendizado", "treino-historico.json");
const PASTA_OCR = path.join(RAIZ, "dados", "ocr-bruto");
const PASTA_FOTOS = path.join(RAIZ, "dados", "importados");
const AUTOR = "Conta Azul (histórico)";
const EXTENSOES = /\.(jpe?g|png)$/i;
const CARTAO_DA_CONTA = [[/inter/i, "Inter"], [/banco do brasil/i, "BB - Crédito"], [/c6/i, "C6"]];
const REFEICOES = [[/caf[eé]/i, "Café"], [/almo[cç]o/i, "Almoço"], [/jantar|janta/i, "Janta"], [/lanche/i, "Lanche"]];

function argumentos(lista = process.argv.slice(2)) {
    const opcoes = { max: 20, reservar: 80, executar: false };
    for (let i = 0; i < lista.length; i += 1) {
        const chave = lista[i].replace(/^--/, "");
        if (chave === "executar") opcoes.executar = true;
        else if (chave === "aprovar") opcoes.aprovar = true;
        else if (chave === "recomparar") opcoes.recomparar = true;
        else if (chave === "completas") opcoes.completas = true;
        else opcoes[chave] = lista[++i];
    }
    opcoes.max = Number(opcoes.max) || 20;
    opcoes.reservar = Number(opcoes.reservar) || 0;
    return opcoes;
}

// ---------------------------------------------------------------------------
// Fotos do Drive: <raiz>/<ano>/Despesas de Campo <ano>/<Operador>/<MM.AA>/<DD ou DD.MM>/foto
// ---------------------------------------------------------------------------

function fotosDoDrive({ operador, de, ate }) {
    const config = lerJson(fs.readFileSync(path.join(RAIZ, "config.json"), "utf8"), {});
    const drive = config.arquivo_drive || {};
    const fotos = [];
    const pastas = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const ehMes = (nome) => /^\d{2}\.\d{2}$/.test(nome);
    const lerDias = (dirMes, nomeMes, pessoa) => {
        const [mm, aa] = nomeMes.split(".");
        for (const dia of pastas(dirMes)) {
            const dd = (dia.match(/^(\d{1,2})/) || [])[1];
            if (!dd) continue;
            const data = `20${aa}-${mm}-${dd.padStart(2, "0")}`;
            if ((de && data < de) || (ate && data > ate)) continue;
            const dir = path.join(dirMes, dia);
            for (const arquivo of fs.readdirSync(dir).filter((n) => EXTENSOES.test(n))) fotos.push({ operador: pessoa, data_pasta: data, caminho: path.join(dir, arquivo) });
        }
    };
    const querOperador = (nome) => !operador || normalizar(nome) === normalizar(operador);
    for (const ano of ["2026", "2025"]) {
        // O nome da pasta do ano mudou: "Despesas de Campo 2026" / "Despesas Campo 2025".
        const base = [String(drive.modelo_pasta_ano || "Despesas de Campo {ano}"), "Despesas de Campo {ano}", "Despesas Campo {ano}"]
            .map((modelo) => path.join(drive.raiz, ano, modelo.replace("{ano}", ano))).find((p) => fs.existsSync(p));
        if (!base) continue;
        for (const primeiro of pastas(base)) {
            if (ehMes(primeiro)) {
                for (const pessoa of pastas(path.join(base, primeiro)).filter(querOperador)) lerDias(path.join(base, primeiro, pessoa), primeiro, pessoa);
            } else if (querOperador(primeiro)) {
                for (const mes of pastas(path.join(base, primeiro)).filter(ehMes)) lerDias(path.join(base, primeiro, mes), mes, primeiro);
            }
        }
    }
    // Mais recentes primeiro: os nomes de centro e as regras atuais valem mais.
    return fotos.sort((a, b) => b.data_pasta.localeCompare(a.data_pasta) || a.caminho.localeCompare(b.caminho));
}

/**
 * Lancamento "completo" (--completas): tudo o que a mensagem padrao leva esta
 * no Conta Azul: centro, cartao e, conforme o tipo, pessoas ou litros+hodometro+placa.
 */
function lancamentoCompleto(l) {
    if (!l?.centro || !cartaoDaConta(l.conta)) return false;
    const descricao = String(l.descricao || "");
    const legenda = legendaDoLancamento(l);
    if (legenda === "Abastecimento") return /\d+[.,]?\d*\s*l(t|itros)?\b.*\bod\b\s*[\d.]{4,}.*[A-Z]{3}-?\d[A-Z0-9]\d{2}/i.test(descricao);
    if (/^(Café|Almoço|Janta|Lanche|Hospedagem)/.test(legenda)) return /\d/.test(legenda);
    return Boolean(descricao);
}

// ---------------------------------------------------------------------------
// Resposta certa: o lancamento do Conta Azul com o mesmo valor e data proxima
// ---------------------------------------------------------------------------

const diasEntre = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

function acharLancamento(lancamentos, { valor, data, dataPasta, usados }) {
    if (!(Number(valor) > 0)) return null;
    const referencia = data || dataPasta;
    const candidatos = lancamentos.filter((l, indice) => !usados.has(indice) && Math.abs(Math.abs(l.valor) - Number(valor)) < 0.011
        && l.data && diasEntre(l.data, referencia) <= 3).map((l) => ({ l, distancia: diasEntre(l.data, referencia) }));
    if (!candidatos.length) return null;
    candidatos.sort((a, b) => a.distancia - b.distancia);
    // Dois lancamentos iguais na mesma distancia: ambiguo, nao chuta.
    if (candidatos.length > 1 && candidatos[0].distancia === candidatos[1].distancia) return { ambiguo: true };
    return candidatos[0].l;
}

/** Legenda no padrao combinado, a partir do que o Conta Azul registrou. */
function legendaDoLancamento(l) {
    const descricao = String(l.descricao || "");
    const fornecedor = normalizar(l.fornecedor || "");
    const pessoas = (descricao.match(/(\d{1,2})\s*pessoas?/i) || [])[1];
    const categoria = normalizar(l.categoria || "");
    if (categoria === "gerador" || /gerador/i.test(descricao)) return "Gerador";
    if (categoria === "agua") return "Água";
    if (/posto|combust/.test(fornecedor) || /\d+[,.]?\d*\s*l(t|itros)?\b.*\bod\b/i.test(descricao)) return "Abastecimento";
    if (/hote|pousada|hosped/.test(fornecedor) || /hosped/i.test(descricao)) return pessoas ? `Hospedagem ${pessoas}` : "Hospedagem";
    if (/pedag/.test(categoria) || /pedag/i.test(descricao)) return "Pedágio";
    if (/estacionamento/.test(categoria)) return "Estacionamento";
    if (/manuten|oficina|auto pecas/.test(fornecedor) || /^manuten/.test(categoria)) {
        const placa = (String(l.categoria || "").replace(/-/g, "").match(/[A-Z]{3}\d[A-Z0-9]\d{2}/) || [])[0];
        return [`Manutenção - ${descricao || "manutenção do veículo"}`, placa].filter(Boolean).join("\n");
    }
    const refeicao = REFEICOES.find(([re]) => re.test(descricao));
    if (refeicao) return pessoas ? `${refeicao[1]} ${pessoas}` : refeicao[1];
    if (/restaurante|padaria|lanchonete/.test(fornecedor)) return pessoas ? `Refeição ${pessoas} pessoas` : "Refeição";
    if (/ferrag|materia/.test(fornecedor)) return `Material - ${descricao || "material de campo"}`;
    return descricao || l.fornecedor || "Despesa";
}

const cartaoDaConta = (conta) => (CARTAO_DA_CONTA.find(([re]) => re.test(String(conta || ""))) || [])[1] || null;

function resumoDoDia(dataNota, l) {
    const [a, m, d] = dataNota.split("-");
    const linhas = [`Despesas ${d}/${m}/${a}`];
    if (l?.centro) linhas.push(`Centro de custo: ${l.centro}`);
    const cartao = cartaoDaConta(l?.conta);
    if (cartao) linhas.push(`Cartão: ${cartao}`);
    return linhas.join("\n");
}

// ---------------------------------------------------------------------------
// Comparacao IA x Conta Azul
// ---------------------------------------------------------------------------

/** Mesma placa nos dois nomes = mesmo veiculo ("Combustivel OVN-1505" = "ETIOS - OVN1505"). */
const placaNoNome = (nome) => (String(nome || "").toUpperCase().replace(/[\s-]/g, "").match(/[A-Z]{3}\d[A-Z0-9]\d{2}/) || [])[0] || null;
const igual = (a, b) => normalizar(String(a ?? "")).replace(/\s+/g, " ") === normalizar(String(b ?? "")).replace(/\s+/g, " ");

function comparar(despesa, l) {
    const c = despesa.campos;
    const diferencas = [];
    const conferir = (campo, ia, certo) => { if (certo != null && certo !== "" && !igual(ia, certo)) diferencas.push({ campo, ia: ia ?? null, conta_azul: certo }); };
    conferir("valor", c.valor?.valor != null ? Number(c.valor.valor).toFixed(2) : null, Math.abs(l.valor).toFixed(2));
    conferir("data_competencia", c.data_competencia?.valor, l.data);
    const mesmaPlaca = placaNoNome(c.categoria?.nome) && placaNoNome(c.categoria?.nome) === placaNoNome(l.categoria) && !/manuten/i.test(`${c.categoria?.nome} ${l.categoria}`);
    if (!mesmaPlaca) conferir("categoria", c.categoria?.nome, l.categoria);
    conferir("centro_custo", c.centro_custo?.nome, l.centro);
    conferir("fornecedor", c.fornecedor?.valor, l.fornecedor);
    return diferencas;
}

// ---------------------------------------------------------------------------

async function lerNota(foto, cota, opcoes) {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(foto.caminho)).digest("hex");
    const nome = `historico_${sha.slice(0, 16)}${path.extname(foto.caminho).toLowerCase()}`;
    const cache = path.join(PASTA_OCR, `${path.parse(nome).name}.json`);
    if (fs.existsSync(cache)) return { sha, nome, bruto: JSON.parse(fs.readFileSync(cache, "utf8")), novo: false };
    const config = lerJson(fs.readFileSync(path.join(RAIZ, "config.json"), "utf8"), {});
    const situacao = cota.situacao({ limite: config.pipeline?.limite_paginas_azure_mes ?? undefined });
    if (situacao.restantes != null && situacao.restantes <= opcoes.reservar) throw new Error(`Cota do Azure reservada para as notas reais (restam ${situacao.restantes}, reserva ${opcoes.reservar}).`);
    const { analisarDocumento } = require("../src/azure-ocr");
    const resultado = await analisarDocumento(foto.caminho);
    cota.registrar(resultado?.resposta_bruta?.analyzeResult?.pages?.length || 1, { limite: config.pipeline?.limite_paginas_azure_mes ?? undefined });
    fs.mkdirSync(PASTA_OCR, { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(resultado.resposta_bruta), "utf8");
    return { sha, nome, bruto: resultado.resposta_bruta, novo: true };
}

/**
 * Compara a previa da IA com o lancamento do Conta Azul. Foto com duas notas:
 * so a despesa com o mesmo valor do lancamento e comparada.
 */
function avaliar(db, despesas, l, opcoes, placar) {
    if (!l) return {};
    const lidas = (despesas || []).map((id) => orquestrador.lerDespesa(db, id)).filter(Boolean);
    const daNota = lidas.length > 1 ? lidas.filter((d) => Math.abs(Number(d.campos.valor?.valor) - Math.abs(l.valor)) < 0.011) : lidas;
    let diferencasFinais = null;
    for (const despesa of daNota) {
        if (!["AGUARDANDO_REVISAO", "CLASSIFICADO"].includes(despesa.estado)) continue;
        const diferencas = comparar(despesa, l);
        diferencasFinais = diferencas;
        const avisosBase = (despesa.avisos || []).filter((a) => !a.startsWith("Treino com histórico"));
        const pendenciasBase = (despesa.pendencias || []).filter((p) => !p.startsWith("Treino com histórico"));
        if (!diferencas.length && !opcoes.aprovar) {
            // Sem --aprovar: so marca; quem aprova e o Yan na Central.
            db.prepare("UPDATE despesas SET avisos = ?, pendencias = ? WHERE id = ?").run(JSON.stringify([...avisosBase,
                "Treino com histórico: igual ao que o Conta Azul lançou (valor, data, categoria, centro e fornecedor)."]), JSON.stringify(pendenciasBase), despesa.id);
            placar.iguais_ao_conta_azul = (placar.iguais_ao_conta_azul || 0) + 1;
            continue;
        }
        if (!diferencas.length) {
            try {
                // Campos que o Conta Azul nao confirma ficam fora do treino.
                revisao.aprovar(db, despesa.id, AUTOR, { naoUsarNoTreino: cartaoDaConta(l.conta) ? [] : ["pagamento"] });
                placar.aprovadas += 1;
                continue;
            } catch (_) { /* faltou campo obrigatorio: vai para revisao */ }
        }
        // Diferente do Conta Azul: fica para o Yan, com o que o Conta Azul lancou.
        const texto = `Treino com histórico — o Conta Azul lançou: ${diferencas.map((d) => `${d.campo} "${d.conta_azul}" (IA: "${d.ia ?? "vazio"}")`).join("; ") || "veja os campos obrigatórios"}. Descrição no Conta Azul: "${l.descricao || "-"}".`;
        db.prepare("UPDATE despesas SET pendencias = ?, avisos = ?, estado = 'AGUARDANDO_REVISAO' WHERE id = ?").run(JSON.stringify([...pendenciasBase, texto]), JSON.stringify(avisosBase), despesa.id);
        placar.para_revisar += 1;
    }
    return { diferencas: diferencasFinais };
}

/** Refaz as previas ja lidas (sem Azure) com as regras atuais e compara de novo. */
function recomparar(opcoes) {
    const registro = lerJson(fs.existsSync(REGISTRO) ? fs.readFileSync(REGISTRO, "utf8") : null, { fotos: {} });
    const lancamentos = lerJson(fs.readFileSync(path.join(RAIZ, "dados", "aprendizado", "lancamentos-conta-azul.json"), "utf8"), {}).lancamentos || [];
    const db = banco();
    const cad = cadastros.carregar();
    const regras = lerJson(fs.readFileSync(path.join(RAIZ, "configuracao", "regras.json"), "utf8"), {});
    const placar = { recomparadas: 0, aprovadas: 0, para_revisar: 0, ja_revisadas: 0 };
    for (const resultado of Object.values(registro.fotos)) {
        if (resultado.lancamento_indice == null || !resultado.despesas?.length) continue;
        let revisada = false;
        for (const id of resultado.despesas) {
            try { orquestrador.regenerarPrevia(db, cad, id, { regras }); } catch (_) { revisada = true; }
        }
        if (revisada) { placar.ja_revisadas += 1; continue; }
        Object.assign(resultado, avaliar(db, resultado.despesas, lancamentos[resultado.lancamento_indice], opcoes, placar));
        placar.recomparadas += 1;
    }
    fs.writeFileSync(REGISTRO, JSON.stringify(registro, null, 2), "utf8");
    console.log("Recomparação:", JSON.stringify(placar));
}

async function principal() {
    const opcoes = argumentos();
    if (opcoes.recomparar) { recomparar(opcoes); return; }
    const registro = lerJson(fs.existsSync(REGISTRO) ? fs.readFileSync(REGISTRO, "utf8") : null, { fotos: {} });
    let fotos = fotosDoDrive(opcoes).filter((f) => !registro.fotos[f.caminho]);
    if (opcoes.categoria) {
        const alvo = new Set(String(opcoes.categoria).split(",").map((c) => normalizar(c)));
        const todos = lerJson(fs.readFileSync(path.join(RAIZ, "dados", "aprendizado", "lancamentos-conta-azul.json"), "utf8"), {}).lancamentos || [];
        const dias = new Set(todos.filter((l) => alvo.has(normalizar(l.categoria || ""))).map((l) => l.data));
        fotos = fotos.filter((f) => dias.has(f.data_pasta));
        console.log(`${dias.size} dia(s) com lançamento de ${opcoes.categoria} no Conta Azul.`);
    }
    if (opcoes.sortear) {
        // Amostra variada (operadores, meses, tipos); semente fixa = mesmo sorteio se repetir.
        let semente = Number(opcoes.sortear) || 42;
        const aleatorio = () => ((semente = (semente * 16807) % 2147483647) / 2147483647);
        for (let i = fotos.length - 1; i > 0; i -= 1) { const j = Math.floor(aleatorio() * (i + 1)); [fotos[i], fotos[j]] = [fotos[j], fotos[i]]; }
    }
    const lote = fotos.slice(0, opcoes.max);
    console.log(`${fotos.length} foto(s) ainda não usadas no treino${opcoes.operador ? ` de ${opcoes.operador}` : ""}. Lote: ${lote.length}.`);
    if (!opcoes.executar) {
        for (const f of lote) console.log(`  ${f.data_pasta}  ${f.operador}  ${path.basename(f.caminho)}`);
        console.log("Nada foi lido nem registrado. Rode de novo com --executar.");
        return;
    }
    const lancamentos = lerJson(fs.readFileSync(path.join(RAIZ, "dados", "aprendizado", "lancamentos-conta-azul.json"), "utf8"), {}).lancamentos || [];
    if (!lancamentos.length) throw new Error("Importe a planilha do Conta Azul antes (atalho 14).");
    const usados = new Set(Object.values(registro.fotos).map((r) => r.lancamento_indice).filter((i) => i != null));
    const cota = require("../src/cota-azure");
    const { normalizarResultadoAzure } = require("../src/azure-ocr");
    const db = banco();
    const cad = cadastros.carregar();
    const regras = lerJson(fs.readFileSync(path.join(RAIZ, "configuracao", "regras.json"), "utf8"), {});
    const placar = { lidas: 0, azure: 0, sem_lancamento: 0, aprovadas: 0, para_revisar: 0, erros: 0 };
    fs.mkdirSync(PASTA_FOTOS, { recursive: true });
    const resumosFeitos = new Set();
    let segundo = 0;

    for (const foto of lote) {
        try {
            const { sha, nome, bruto, novo } = await lerNota(foto, cota, opcoes);
            placar.lidas += 1;
            if (novo) placar.azure += 1;
            const ocr = normalizarResultadoAzure(bruto);
            const achado = acharLancamento(lancamentos, { valor: ocr.valor, data: ocr.data, dataPasta: foto.data_pasta, usados });
            const l = achado && !achado.ambiguo ? achado : null;
            const indice = l ? lancamentos.indexOf(l) : null;
            if (l && opcoes.completas && !lancamentoCompleto(l)) {
                placar.incompletas = (placar.incompletas || 0) + 1;
                registro.fotos[foto.caminho] = { data_pasta: foto.data_pasta, operador: foto.operador, ignorada: "lançamento sem todas as informações (modo completas)", lancamento_visto: indice, em: agora() };
                fs.writeFileSync(REGISTRO, JSON.stringify(registro, null, 2), "utf8");
                console.log(`${foto.data_pasta} ${foto.operador} · lançamento incompleto no Conta Azul: não entrou`);
                continue;
            }
            if (l) usados.add(indice);
            else {
                // Sem o lancamento nao ha como montar a mensagem no padrao (tipo,
                // pessoas, centro, cartao): a foto nao entra no grupo de treino.
                placar.sem_lancamento += 1;
                registro.fotos[foto.caminho] = { data_pasta: foto.data_pasta, operador: foto.operador, ignorada: "sem lançamento no Conta Azul", em: agora() };
                fs.writeFileSync(REGISTRO, JSON.stringify(registro, null, 2), "utf8");
                console.log(`${foto.data_pasta} ${foto.operador} · sem lançamento no Conta Azul: não entrou no treino`);
                continue;
            }

            const pessoa = cad.pessoas.find((p) => normalizar(p.nome) === normalizar(foto.operador)) || null;
            const remetente = `historico:${normalizar(foto.operador).replace(/\s+/g, "_")}`;
            if (pessoa) db.prepare(`INSERT OR IGNORE INTO remetentes_vinculados (whatsapp_id, pessoa_id, origem, vinculado_em) VALUES (?, ?, 'treino_historico', ?)`).run(remetente, pessoa.id, agora());
            const dataNota = l?.data || ocr.data || foto.data_pasta;
            const quando = (offset) => new Date(Date.parse(`${dataNota}T20:00:00-03:00`) + (segundo += 1) * 1000 + offset).toISOString();

            // Resumo do dia (uma vez por operador, dia, centro e cartao), antes da foto.
            const chaveResumo = [remetente, dataNota, l?.centro, cartaoDaConta(l?.conta)].join("|");
            if (l && !resumosFeitos.has(chaveResumo)) {
                resumosFeitos.add(chaveResumo);
                orquestrador.processarMensagemTexto(db, cad, { grupoId: GRUPO_TREINO, mensagemId: `historico-resumo-${crypto.createHash("md5").update(chaveResumo).digest("hex").slice(0, 16)}`,
                    remetenteId: remetente, remetenteNome: foto.operador, enviadaEm: quando(0), texto: resumoDoDia(dataNota, l) }, { regras });
            }
            const legenda = l ? legendaDoLancamento(l) : "";
            fs.copyFileSync(foto.caminho, path.join(PASTA_FOTOS, nome));
            const { despesas } = orquestrador.processarFoto(db, cad, {
                arquivo: nome, sha256: sha, brutoAzure: bruto, regras,
                meta: { id_mensagem: `historico-${sha.slice(0, 20)}`, id_grupo: GRUPO_TREINO, remetente, remetente_nome: foto.operador, legenda,
                    recebido_em_ms: Date.parse(quando(0)) },
            });
            const resultado = { data_pasta: foto.data_pasta, operador: foto.operador, legenda, despesas, lancamento_indice: indice, em: agora() };
            Object.assign(resultado, avaliar(db, despesas, l, opcoes, placar));
            registro.fotos[foto.caminho] = resultado;
            placar.registradas = (placar.registradas || 0) + 1;
            fs.mkdirSync(path.dirname(REGISTRO), { recursive: true });
            fs.writeFileSync(REGISTRO, JSON.stringify(registro, null, 2), "utf8");
            console.log(`${foto.data_pasta} ${foto.operador} · "${legenda || "sem lançamento no Conta Azul"}" · despesas ${despesas.join(",") || "-"}`);
            if (opcoes.registrar && placar.registradas >= Number(opcoes.registrar)) break;
        } catch (erro) {
            placar.erros += 1;
            console.error(`Falhou ${path.basename(foto.caminho)}: ${erro.message}`);
            if (/Cota do Azure/.test(erro.message)) break;
        }
    }
    console.log("\nResultado:", JSON.stringify(placar));
}

if (require.main === module) principal().catch((erro) => { console.error("Falha:", erro.message); process.exitCode = 1; });

module.exports = { lancamentoCompleto, acharLancamento, legendaDoLancamento, resumoDoDia, cartaoDaConta, comparar, fotosDoDrive };
