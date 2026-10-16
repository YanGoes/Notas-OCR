"use strict";

// =============================================================================
// CATALOGO DO CONTA AZUL A PARTIR DA PLANILHA "visao_contas_a_pagar"
// =============================================================================
//
// Le a exportacao em Excel (Contas a pagar -> Exportar) e grava em
// configuracao/catalogo_conta_azul.json TODOS os centros de custo, categorias
// e fornecedores que aparecem nela, com quantas vezes foram usados e a data
// do ultimo uso. O programa passa a conhecer esses nomes (exatos, como no
// Conta Azul); os IDs continuam vindo da API (atalho 05).
//
//   node ferramentas/importar-catalogo-conta-azul.js "<planilha.xlsx>"
// =============================================================================

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const RAIZ = path.resolve(__dirname, "..");
const DESTINO = path.join(RAIZ, "configuracao", "catalogo_conta_azul.json");

function dataIso(valor) {
    if (valor instanceof Date) return valor.toISOString().slice(0, 10);
    const achado = String(valor || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return achado ? `${achado[3]}-${achado[2]}-${achado[1]}` : null;
}

async function lerCatalogo(planilha, { hoje = new Date() } = {}) {
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.readFile(planilha);
    const folha = livro.worksheets[0];
    const cabecalho = folha.getRow(1).values.map((valor) => String(valor || "").trim());
    const coluna = (nome) => {
        const indice = cabecalho.indexOf(nome);
        if (indice < 0) throw new Error(`Coluna "${nome}" não encontrada. Exporte a visão "Contas a pagar" em Excel.`);
        return indice;
    };
    const colunas = { data: coluna("Data de competência"), fornecedor: coluna("Nome do fornecedor"), categoria: coluna("Categoria 1"), centro: coluna("Centro de Custo 1") };
    const opcional = (nome) => cabecalho.indexOf(nome);
    const extras = { valor: opcional("Valor na Categoria 1"), valorParcela: opcional("Valor original da parcela (R$)"), descricao: opcional("Descrição"),
        referencia: opcional("Código de referência"), situacao: opcional("Situação"), forma: opcional("Forma de pagamento"), conta: opcional("Conta bancária") };
    const lancamentos = [];
    const paraNumero = (valor) => {
        if (typeof valor === "number") return valor;
        const texto = String(valor ?? "").replace(/[^\d,.-]/g, "");
        return texto ? Number(texto.replace(/\./g, "").replace(",", ".")) || 0 : 0;
    };
    const celula = (linha, indice) => (indice > 0 ? linha.getCell(indice).value : null);
    const limite = hoje.toISOString().slice(0, 10);
    const mapas = { centros: new Map(), categorias: new Map(), fornecedores: new Map() };
    let linhas = 0;
    const somar = (mapa, valor, data) => {
        const nome = String(valor ?? "").replace(/\s+/g, " ").trim();
        if (!nome) return;
        const item = mapa.get(nome) || { nome, usos: 0, ultimo_uso: null };
        item.usos += 1;
        // Parcelas futuras (financiamentos, recorrencias) nao contam como "ultimo uso".
        if (data && data <= limite && (!item.ultimo_uso || data > item.ultimo_uso)) item.ultimo_uso = data;
        mapa.set(nome, item);
    };
    folha.eachRow((linha, numero) => {
        if (numero === 1) return;
        linhas += 1;
        const data = dataIso(linha.getCell(colunas.data).value);
        somar(mapas.fornecedores, linha.getCell(colunas.fornecedor).value, data);
        somar(mapas.categorias, linha.getCell(colunas.categoria).value, data);
        somar(mapas.centros, linha.getCell(colunas.centro).value, data);
        // Linha enxuta para os relatorios do assistente (meses antes da Central).
        const texto = (v) => String(v ?? "").replace(/\s+/g, " ").trim() || null;
        lancamentos.push({
            data, valor: paraNumero(celula(linha, extras.valor)) || paraNumero(celula(linha, extras.valorParcela)),
            fornecedor: texto(linha.getCell(colunas.fornecedor).value), categoria: texto(linha.getCell(colunas.categoria).value),
            centro: texto(linha.getCell(colunas.centro).value), descricao: texto(celula(linha, extras.descricao)),
            referencia: texto(celula(linha, extras.referencia)), situacao: texto(celula(linha, extras.situacao)), forma: texto(celula(linha, extras.forma)), conta: texto(celula(linha, extras.conta)),
        });
    });
    const ordenar = (mapa) => [...mapa.values()].sort((a, b) => b.usos - a.usos || a.nome.localeCompare(b.nome, "pt-BR"));
    return {
        _leia_me: "Gerado por ferramentas/importar-catalogo-conta-azul.js a partir da exportação do Conta Azul. Não edite à mão: exporte de novo e rode a ferramenta.",
        gerado_em: new Date().toISOString(), fonte: path.basename(planilha), lancamentos: linhas,
        centros: ordenar(mapas.centros), categorias: ordenar(mapas.categorias), fornecedores: ordenar(mapas.fornecedores),
        // Fora do JSON do catalogo (vai para dados/, fora do Git): ver principal().
        _lancamentos: lancamentos,
    };
}

const DESTINO_LANCAMENTOS = path.join(RAIZ, "dados", "aprendizado", "lancamentos-conta-azul.json");

async function principal() {
    const planilha = process.argv[2];
    if (!planilha || !fs.existsSync(planilha)) throw new Error("Informe o caminho da planilha .xlsx exportada do Conta Azul.");
    const { _lancamentos: lancamentos, ...catalogo } = await lerCatalogo(planilha);
    fs.writeFileSync(DESTINO, JSON.stringify(catalogo, null, 2) + "\n", "utf8");
    // Valores e descricoes ficam em dados/ (fora do Git): sao dados financeiros.
    fs.mkdirSync(path.dirname(DESTINO_LANCAMENTOS), { recursive: true });
    fs.writeFileSync(DESTINO_LANCAMENTOS, JSON.stringify({ gerado_em: catalogo.gerado_em, fonte: catalogo.fonte, lancamentos }), "utf8");
    console.log(`${catalogo.lancamentos} lançamentos lidos.`);
    console.log(`Centros de custo: ${catalogo.centros.length} · Categorias: ${catalogo.categorias.length} · Fornecedores: ${catalogo.fornecedores.length}`);
    console.log(`Gravado em ${DESTINO}`);
}

if (require.main === module) principal().catch((erro) => { console.error("Falha:", erro.message); process.exitCode = 1; });

module.exports = { lerCatalogo, dataIso };
