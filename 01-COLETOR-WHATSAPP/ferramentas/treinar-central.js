"use strict";

// =============================================================================
// Treino e medicao da CATEGORIA a partir da planilha "visao_contas_a_pagar"
// =============================================================================
//
// Uso:
//   node ferramentas/treinar-central.js [planilha.xlsx] [--meses-teste 3] [--meses-pratica 4]
//
// Como mede (sem se enganar):
//   - so lancamentos ja ocorridos (datas futuras sao parcelas recorrentes);
//   - so despesas do tipo que chega por foto no WhatsApp (refeicao,
//     hospedagem, combustivel, pedagio, manutencao, material de campo...);
//   - TESTE = os ultimos N meses; TREINO = tudo antes. Nada do teste e usado
//     para treinar — e assim que o modelo vai ser usado: prever o mes que vem.
//
// Compara quatro jeitos de decidir a categoria:
//   A) modelo antigo  — texto (Naive Bayes) com todas as linhas da planilha;
//   B) regras         — tipo da despesa -> categoria do cadastro; placa -> veiculo;
//   C) regras + pratica atual — categoria que a VMac usa HOJE para cada tipo,
//      aprendida dos ultimos meses do treino;
//   D) hibrido        — C e, quando nenhuma regra decide, texto treinado so com
//      o periodo recente e so com despesas de campo.
//
// Grava configuracao/modelo-central.json (fora do Git) e o relatorio em
// dados/aprendizado/relatorio-central.json. Nao lanca nada em lugar nenhum.
// =============================================================================

const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");
const { criarModelo, prever } = require("../src/aprendizado");
const cadastros = require("../src/central/cadastros");
const { tipoDoTexto } = require("../src/central/interpretador");
const { normalizar } = require("../src/central/texto");

const RAIZ = path.resolve(__dirname, "..");
const PLANILHA_PADRAO = "C:\\Users\\vmac_\\Desktop\\APRENDIZADO DE IA - DESPESAS\\visao_contas_a_pagar (1).xls";
const MODELO_PATH = path.join(RAIZ, "configuracao", "modelo-central.json");
const RELATORIO_PATH = path.join(RAIZ, "dados", "aprendizado", "relatorio-central.json");

function argumento(nome, padrao) {
    const i = process.argv.indexOf(nome);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

function texto(valor) {
    if (valor === null || valor === undefined) return "";
    if (valor instanceof Date) return valor.toISOString().slice(0, 10);
    if (typeof valor === "object") return String(valor.text || valor.result || valor.richText?.map((x) => x.text).join("") || "");
    return String(valor);
}

function dataIso(valor) {
    const m = String(valor).match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return /^\d{4}-\d{2}-\d{2}/.test(valor) ? valor.slice(0, 10) : null;
}

const somarMeses = (iso, meses) => {
    const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + meses);
    return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Universo: despesas que chegam por foto no WhatsApp
// ---------------------------------------------------------------------------

function ehDespesaDeCampo(categoria, cad) {
    const n = normalizar(categoria);
    if (/refeic|lanche|almoco|jantar|cafe da manha|alimentacao|hospedagem|pedagio|combustivel|estacionamento|material de campo|manutencao|farmacia|lavagem|transporte urbano|veiculo alugado/.test(n)) return true;
    return cad.veiculos.some((v) => [v.categoria_nome_conta_azul, v.manutencao_categoria_nome].some((nome) => nome && normalizar(nome) === n));
}

// ---------------------------------------------------------------------------
// Tipo da despesa e placa, pelo que o operador escreveu (nunca pela categoria)
// ---------------------------------------------------------------------------

// "35,43L od 145.225 - JKN2876" (2025) e "GASOLINA - 44.68 LT OD 301.092" (desde 04/2026).
const RE_ABASTECIMENTO = /\d+(?:[.,]\d+)?\s*(?:l|lt|lts|litros?)\b|^\s*(?:gasolina|diesel|etanol|alcool)\b/i;
const RE_PLACA = /\b([A-Z]{3})[\s-]?(\d[A-Z0-9]\d{2})\b/i;

function tipoDaLinha(linha) {
    if (RE_ABASTECIMENTO.test(linha.descricao)) return "ABASTECIMENTO";
    const daDescricao = tipoDoTexto(linha.descricao);
    if (daDescricao) return daDescricao;
    const doFornecedor = tipoDoTexto(linha.fornecedor);
    if (doFornecedor) return doFornecedor;
    if (/posto|combustive/i.test(normalizar(linha.fornecedor))) return "ABASTECIMENTO";
    return null;
}

function placaDaLinha(linha) {
    const m = linha.descricao.toUpperCase().match(RE_PLACA);
    return m ? `${m[1]}${m[2]}` : null;
}

/** Regra do cadastro atual (o que a Central faz hoje). */
function categoriaPelaRegra(linha, tipo, cad) {
    if (tipo === "ABASTECIMENTO") {
        const placa = placaDaLinha(linha);
        const veiculo = placa ? cadastros.resolverVeiculo(cad, placa) : null;
        return veiculo?.categoria_nome_conta_azul || null;
    }
    const interno = { CAFE_DA_MANHA: "CAFE DA MANHA", ALMOCO: "ALMOCO", JANTAR: "JANTAR", LANCHE: "ALIMENTACAO EM CAMPO",
        HOSPEDAGEM: "HOSPEDAGEM", PEDAGIO: "PEDAGIO", ESTACIONAMENTO: "ESTACIONAMENTO" }[tipo];
    if (!interno) return null;
    const categoria = cadastros.categoriaPorNome(cad, interno);
    return categoria?.nome || null;
}

const iguais = (a, b) => Boolean(a) && Boolean(b) && normalizar(a) === normalizar(b);

// ---------------------------------------------------------------------------
// Medicao
// ---------------------------------------------------------------------------

function medir(nome, teste, prevedor) {
    let previstos = 0; let acertos = 0;
    const porTipo = {};
    const erros = {};
    for (const linha of teste) {
        const previsto = prevedor(linha);
        const tipo = linha.tipo || "SEM_TIPO";
        const t = porTipo[tipo] ||= { total: 0, previstos: 0, acertos: 0 };
        t.total += 1;
        if (!previsto) continue;
        previstos += 1; t.previstos += 1;
        if (iguais(previsto, linha.categoria)) { acertos += 1; t.acertos += 1; }
        else { const chave = `${previsto} -> deveria ser ${linha.categoria}`; erros[chave] = (erros[chave] || 0) + 1; }
    }
    return {
        abordagem: nome, total: teste.length, previstos, acertos,
        cobertura: previstos / teste.length, precisao: previstos ? acertos / previstos : 0, acerto_geral: acertos / teste.length,
        por_tipo: porTipo,
        principais_erros: Object.entries(erros).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([erro, vezes]) => ({ erro, vezes })),
    };
}

/** Categoria mais usada para cada tipo num periodo (a "pratica atual"). */
function praticaPorTipo(linhas, minimo = 5) {
    const contagem = {};
    for (const linha of linhas) {
        if (!linha.tipo || linha.tipo === "ABASTECIMENTO") continue; // combustivel depende da placa
        const porCategoria = contagem[linha.tipo] ||= {};
        porCategoria[linha.categoria] = (porCategoria[linha.categoria] || 0) + 1;
    }
    const pratica = {};
    for (const [tipo, porCategoria] of Object.entries(contagem)) {
        const total = Object.values(porCategoria).reduce((a, b) => a + b, 0);
        const [categoria, vezes] = Object.entries(porCategoria).sort((a, b) => b[1] - a[1])[0];
        if (total >= minimo) pratica[tipo] = { categoria, participacao: vezes / total, amostras: total, distribuicao: porCategoria };
    }
    return pratica;
}

const textoDoModelo = (linha) => `${linha.fornecedor} ${linha.descricao}`;

async function executar() {
    const planilha = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : PLANILHA_PADRAO;
    const mesesTeste = Number(argumento("--meses-teste", 3));
    const mesesPratica = Number(argumento("--meses-pratica", 2));
    const hoje = new Date().toISOString().slice(0, 10);
    const cad = cadastros.carregar();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(planilha);
    const folha = workbook.worksheets[0];
    const coluna = {};
    folha.getRow(1).eachCell((celula, i) => { coluna[texto(celula.value).trim()] = i; });
    for (const obrigatoria of ["Nome do fornecedor", "Descrição", "Categoria 1", "Centro de Custo 1", "Data de competência"]) {
        if (!coluna[obrigatoria]) throw new Error(`Coluna ausente na planilha: ${obrigatoria}`);
    }
    const todas = [];
    folha.eachRow((linha, numero) => {
        if (numero === 1) return;
        const celula = (nome) => texto(linha.getCell(coluna[nome]).value).trim();
        const registro = {
            data: dataIso(celula("Data de competência")), fornecedor: celula("Nome do fornecedor"), descricao: celula("Descrição"),
            categoria: celula("Categoria 1"), centro: celula("Centro de Custo 1"),
        };
        if (registro.data && registro.categoria && (registro.fornecedor || registro.descricao)) todas.push(registro);
    });

    // A exportacao para em algum dia do mes: meses seguintes so tem lancamentos
    // agendados. Vale ate o ultimo mes com volume normal de despesas de campo.
    const ateHoje = todas.filter((linha) => linha.data <= hoje);
    const porMes = {};
    for (const linha of ateHoje) if (ehDespesaDeCampo(linha.categoria, cad)) porMes[linha.data.slice(0, 7)] = (porMes[linha.data.slice(0, 7)] || 0) + 1;
    const volumes = Object.values(porMes).sort((a, b) => a - b);
    const mediana = volumes[Math.floor(volumes.length / 2)] || 0;
    const ultimoMes = Object.keys(porMes).sort().filter((mes) => porMes[mes] >= mediana * 0.5).at(-1);
    const ultimaData = `${ultimoMes}-31`;
    const passadas = ateHoje.filter((linha) => linha.data <= ultimaData);
    const corteTeste = somarMeses(ultimaData, -(mesesTeste - 1)); // inicio do 1o mes de teste
    const inicioPratica = somarMeses(corteTeste, -mesesPratica);
    for (const linha of passadas) linha.tipo = tipoDaLinha(linha);

    const treinoTudo = passadas.filter((linha) => linha.data < corteTeste);
    const campo = (linhas) => linhas.filter((linha) => ehDespesaDeCampo(linha.categoria, cad));
    // Abastecimento sem placa na descricao: o veiculo (e a categoria) vem da placa
    // lida na NOTA, que a planilha nao tem. Fica fora da medicao de categoria.
    const testeCompleto = campo(passadas.filter((linha) => linha.data >= corteTeste));
    const dependeDaNota = (linha) => linha.tipo === "ABASTECIMENTO" && !placaDaLinha(linha);
    const teste = testeCompleto.filter((linha) => !dependeDaNota(linha));
    const foraPorPlaca = testeCompleto.length - teste.length;
    const recente = campo(treinoTudo.filter((linha) => linha.data >= somarMeses(corteTeste, -12)));

    // A) modelo antigo: texto com TODAS as linhas do treino (como o treinador anterior).
    const modeloAntigo = criarModelo(treinoTudo.map((l) => ({ ...l, texto: textoDoModelo(l) })), "categoria", "texto", 5);
    // D) texto so com despesas de campo dos ultimos 12 meses do treino.
    const modeloRecente = criarModelo(recente.map((l) => ({ ...l, texto: textoDoModelo(l) })), "categoria", "texto", 3);
    const pratica = praticaPorTipo(campo(treinoTudo.filter((linha) => linha.data >= inicioPratica)));

    const pelaPratica = (linha) => {
        if (linha.tipo === "ABASTECIMENTO") return categoriaPelaRegra(linha, linha.tipo, cad);
        return pratica[linha.tipo]?.categoria || null;
    };
    const resultados = [
        medir("A) modelo antigo (texto, todas as linhas)", teste, (l) => prever(modeloAntigo, textoDoModelo(l))?.rotulo || null),
        medir("B) regras do cadastro atual", teste, (l) => categoriaPelaRegra(l, l.tipo, cad)),
        medir("C) regras + prática atual da VMac", teste, pelaPratica),
        medir("D) híbrido (C + texto recente quando nenhuma regra decide)", teste, (l) => pelaPratica(l) || prever(modeloRecente, textoDoModelo(l))?.rotulo || null),
    ];

    // Diferencas entre o cadastro (categorias.json) e a pratica atual.
    const recomendacoes = Object.entries(pratica).map(([tipo, info]) => {
        const atual = categoriaPelaRegra({ descricao: "", fornecedor: "" }, tipo, cad);
        return { tipo, cadastro_atual: atual, pratica_atual: info.categoria, participacao: Number(info.participacao.toFixed(3)), amostras: info.amostras, divergente: !iguais(atual, info.categoria) };
    });

    // Treino final (para usar a partir de agora): tudo, inclusive o periodo de teste.
    const finalPratica = praticaPorTipo(campo(passadas.filter((linha) => linha.data >= somarMeses(ultimaData, -(mesesPratica - 1)))));
    const finalTexto = criarModelo(campo(passadas.filter((linha) => linha.data >= somarMeses(ultimaData, -12)))
        .map((l) => ({ ...l, texto: textoDoModelo(l) })), "categoria", "texto", 3);
    const modelo = {
        versao: 1, treinado_em: new Date().toISOString(), origem: path.basename(planilha),
        periodo: { primeira_data: passadas.map((l) => l.data).sort()[0], ultima_data: ultimaData },
        pratica_por_tipo: finalPratica, texto_categoria: finalTexto,
    };
    fs.writeFileSync(MODELO_PATH, JSON.stringify(modelo), "utf8");

    const relatorio = {
        gerado_em: modelo.treinado_em, planilha: path.basename(planilha),
        linhas: { total: todas.length, futuras_ignoradas: todas.length - passadas.length, usadas: passadas.length, por_mes_despesas_de_campo: porMes },
        divisao: { treino_ate: corteTeste, teste_de: corteTeste, teste_ate: ultimaData, despesas_de_campo_no_teste: teste.length,
            abastecimentos_sem_placa_na_descricao: foraPorPlaca, pratica_aprendida_de: inicioPratica },
        resultados, recomendacoes,
    };
    fs.mkdirSync(path.dirname(RELATORIO_PATH), { recursive: true });
    fs.writeFileSync(RELATORIO_PATH, JSON.stringify(relatorio, null, 2), "utf8");

    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    console.log(`Planilha: ${relatorio.linhas.usadas} lançamentos usados (${relatorio.linhas.futuras_ignoradas} parcelas futuras ignoradas).`);
    console.log(`Teste: ${teste.length} despesas de campo de ${corteTeste} a ${ultimaData} (nunca vistas no treino).`);
    console.log(`Fora da medição: ${foraPorPlaca} abastecimentos sem placa na descrição (na Central a placa vem da nota).\n`);
    for (const r of resultados) {
        console.log(`${r.abordagem}\n   acerto geral ${pct(r.acerto_geral)} | quando decide, acerta ${pct(r.precisao)} | decide em ${pct(r.cobertura)} dos casos`);
    }
    console.log("\nCadastro x prática atual:");
    for (const r of recomendacoes) console.log(`   ${r.divergente ? "≠" : "="} ${r.tipo}: cadastro "${r.cadastro_atual}" | prática "${r.pratica_atual}" (${pct(r.participacao)} de ${r.amostras})`);
    console.log(`\nModelo: ${MODELO_PATH}\nRelatório: ${RELATORIO_PATH}`);
}

executar().catch((erro) => { console.error(`Falha: ${erro.message}`); process.exit(1); });
