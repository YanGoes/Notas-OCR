"use strict";

const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");
const { criarModelo, prever, hashGrupo, MODELO_PATH } = require("../src/aprendizado");

const arquivo = process.argv[2] || "C:\\Users\\vmac_\\Desktop\\APRENDIZADO DE IA - DESPESAS\\visao_contas_a_pagar (1).xls";
const RAIZ = path.resolve(__dirname, "..");

function familiaDe(categoria, fornecedor, descricao) {
    const texto = `${categoria} ${fornecedor} ${descricao}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (/refeicao|lanche|alimentacao|cafe da manha|restaurante|padaria|supermercado/.test(texto)) return "ALIMENTACAO";
    if (/hospedagem|hoteis|hotel|pousada|diaria/.test(texto)) return "HOSPEDAGEM";
    if (/farmacia|drogaria|medicamento|remedio/.test(texto)) return "FARMACIA";
    if (/oficina|auto pecas|manutencao/.test(texto)) return "OFICINA_MANUTENCAO";
    if (/posto de combustivel|postos de combustivel|combustivel|gasolina|etanol|diesel/.test(texto)) return "COMBUSTIVEL";
    if (/material de campo|ferragen|\bepi\b|ferramenta/.test(texto)) return "MATERIAL_CAMPO";
    return "FORA_DO_FOCO";
}

function textoCelula(valor) {
    if (valor === null || valor === undefined) return "";
    if (typeof valor === "object") return String(valor.text || valor.result || valor.richText?.map((x) => x.text).join("") || valor);
    return String(valor);
}

function avaliar(modelo, exemplos, rotulo, texto) {
    let total = 0; let acertos = 0; let altaTotal = 0; let altaAcertos = 0;
    const porClasse = {};
    for (const exemplo of exemplos) {
        if (!modelo.classes[exemplo[rotulo]]) continue;
        const resultado = prever(modelo, exemplo[texto]);
        if (!resultado) continue;
        total += 1; const acertou = resultado.rotulo === exemplo[rotulo]; if (acertou) acertos += 1;
        const classe = porClasse[exemplo[rotulo]] ||= { total: 0, acertos: 0 }; classe.total += 1; if (acertou) classe.acertos += 1;
        if (resultado.confianca >= 0.98 && resultado.margem >= 4) { altaTotal += 1; if (acertou) altaAcertos += 1; }
    }
    return { total_teste: total, acuracia: total ? acertos / total : 0, previsoes_alta_confianca: altaTotal, precisao_alta_confianca: altaTotal ? altaAcertos / altaTotal : 0, cobertura_alta_confianca: total ? altaTotal / total : 0, por_classe: porClasse };
}

async function executar() {
    if (!fs.existsSync(arquivo)) throw new Error(`Planilha nao encontrada: ${arquivo}`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(arquivo);
    const sheet = workbook.worksheets[0];
    const cabecalhos = {};
    sheet.getRow(1).eachCell((cell, coluna) => { cabecalhos[textoCelula(cell.value).trim()] = coluna; });
    const col = (nome) => cabecalhos[nome];
    const obrigatorias = ["Nome do fornecedor", "Descrição", "Categoria 1", "Centro de Custo 1"];
    for (const nome of obrigatorias) if (!col(nome)) throw new Error(`Coluna ausente: ${nome}`);
    const exemplos = [];
    sheet.eachRow((row, numero) => {
        if (numero === 1) return;
        const fornecedor = textoCelula(row.getCell(col("Nome do fornecedor")).value);
        const descricao = textoCelula(row.getCell(col("Descrição")).value);
        const observacoes = col("Observações") ? textoCelula(row.getCell(col("Observações")).value) : "";
        const forma = col("Forma de pagamento") ? textoCelula(row.getCell(col("Forma de pagamento")).value) : "";
        const conta = col("Conta bancária") ? textoCelula(row.getCell(col("Conta bancária")).value) : "";
        const categoria = textoCelula(row.getCell(col("Categoria 1")).value).trim();
        const centro = textoCelula(row.getCell(col("Centro de Custo 1")).value).trim();
        if (!categoria || !centro || (!fornecedor && !descricao)) return;
        const texto_categoria = [fornecedor, descricao, observacoes, forma, conta].join(" ");
        const texto_centro = `${texto_categoria} categoria ${categoria}`;
        exemplos.push({ categoria, centro, familia: familiaDe(categoria, fornecedor, descricao), texto_categoria, texto_centro, grupo: `${fornecedor}|${descricao}` });
    });
    const treino = exemplos.filter((x) => hashGrupo(x.grupo) % 5 !== 0);
    const teste = exemplos.filter((x) => hashGrupo(x.grupo) % 5 === 0);
    const categoria = criarModelo(treino, "categoria", "texto_categoria", 5);
    const centro = criarModelo(treino, "centro", "texto_centro", 5);
    const familia = criarModelo(treino, "familia", "texto_categoria", 5);
    const metricas = { familia: avaliar(familia, teste, "familia", "texto_categoria"), categoria: avaliar(categoria, teste, "categoria", "texto_categoria"), centro: avaliar(centro, teste, "centro", "texto_centro") };
    const modelo = { versao: 2, treinado_em: new Date().toISOString(), origem: path.basename(arquivo), exemplos_total: exemplos.length, exemplos_treino: treino.length, exemplos_teste: teste.length, metricas, familia, categoria, centro };
    fs.writeFileSync(MODELO_PATH, JSON.stringify(modelo), "utf8");
    const relatorioPath = path.join(RAIZ, "dados", "aprendizado", "relatorio-treinamento.json");
    fs.mkdirSync(path.dirname(relatorioPath), { recursive: true });
    fs.writeFileSync(relatorioPath, JSON.stringify({ ...modelo, familia: { documentos: familia.documentos, classes: Object.keys(familia.classes).length }, categoria: { documentos: categoria.documentos, classes: Object.keys(categoria.classes).length }, centro: { documentos: centro.documentos, classes: Object.keys(centro.classes).length } }, null, 2), "utf8");
    console.log(JSON.stringify({ modelo: MODELO_PATH, relatorio: relatorioPath, exemplos: exemplos.length, treino: treino.length, teste: teste.length, classes_familia: Object.keys(familia.classes).length, classes_categoria: Object.keys(categoria.classes).length, classes_centro: Object.keys(centro.classes).length, metricas }, null, 2));
}

executar().catch((erro) => { console.error(erro.stack || erro); process.exitCode = 1; });
