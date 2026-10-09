"use strict";

// =============================================================================
// Importa notas ja lidas para a Central de revisao (sem chamar o Azure de novo)
// =============================================================================
//
// Uso:
//   node ferramentas/importar-para-central.js [--origem <pasta dados>] [--db <arquivo .db>]
//
// Le a resposta bruta do Azure (dados/ocr-bruto), a foto e o .json da mensagem
// de uma pasta "dados" (por padrao, a do projeto original ao lado desta copia)
// e gera as previas na Central, na ordem em que as fotos chegaram.
//
// A pasta de origem e SOMENTE LIDA. As fotos sao copiadas para dados/importados
// desta copia (fora do Git). Nada e lancado no Conta Azul nem enviado ao Drive.
// =============================================================================

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const banco = require("../src/central/banco");
const cadastros = require("../src/central/cadastros");
const { processarFoto } = require("../src/central/orquestrador");

const RAIZ = path.resolve(__dirname, "..");
const PASTAS_FOTO = ["simulacao", "revisao", "bloqueados", "enviados", "erros", "entrada"];

function argumento(nome, padrao) {
    const indice = process.argv.indexOf(nome);
    return indice > 0 && process.argv[indice + 1] ? process.argv[indice + 1] : padrao;
}

function lerJson(arquivo) {
    try { return JSON.parse(fs.readFileSync(arquivo, "utf8")); } catch (_) { return null; }
}

function localizarFoto(origem, base) {
    for (const pasta of PASTAS_FOTO) {
        const diretorio = path.join(origem, pasta);
        if (!fs.existsSync(diretorio)) continue;
        const nome = fs.readdirSync(diretorio).find((arquivo) => path.parse(arquivo).name === base && /\.(jpe?g|png|bmp|pdf)$/i.test(arquivo));
        if (nome) return { caminho: path.join(diretorio, nome), nome, meta: lerJson(path.join(diretorio, `${base}.json`)) };
    }
    return null;
}

function executar() {
    const origem = path.resolve(argumento("--origem", path.resolve(RAIZ, "..", "..", "PROGRAMA OCR", "01-COLETOR-WHATSAPP", "dados")));
    const caminhoDb = path.resolve(argumento("--db", banco.CAMINHO_PADRAO));
    if (path.resolve(origem) === path.resolve(RAIZ, "dados")) throw new Error("A origem nao pode ser a propria pasta dados desta copia.");
    const pastaBruto = path.join(origem, "ocr-bruto");
    if (!fs.existsSync(pastaBruto)) throw new Error(`Nao encontrei ${pastaBruto}`);

    const destinoFotos = path.join(RAIZ, "dados", "importados");
    fs.mkdirSync(destinoFotos, { recursive: true });
    const db = banco.abrir(caminhoDb);
    const cad = cadastros.carregar();
    const regras = lerJson(path.join(RAIZ, "configuracao", "regras.json")) || {};

    const itens = [];
    const ignorados = [];
    for (const nome of fs.readdirSync(pastaBruto).filter((arquivo) => arquivo.endsWith(".json"))) {
        const base = path.parse(nome).name;
        const foto = localizarFoto(origem, base);
        if (!foto) { ignorados.push(`${base}: foto nao encontrada`); continue; }
        const bruto = lerJson(path.join(pastaBruto, nome));
        if (!bruto?.analyzeResult) { ignorados.push(`${base}: resposta do Azure invalida`); continue; }
        const auditoria = lerJson(path.join(origem, "auditoria", `${base}.json`));
        itens.push({ base, foto, bruto, modelo: auditoria?.ocr?.modelo || "prebuilt-receipt", momento: Number(foto.meta?.timestamp || 0) });
    }
    itens.sort((a, b) => a.momento - b.momento || a.base.localeCompare(b.base));

    let novas = 0;
    let jaExistiam = 0;
    for (const item of itens) {
        const destino = path.join(destinoFotos, item.foto.nome);
        if (!fs.existsSync(destino)) fs.copyFileSync(item.foto.caminho, destino);
        const sha256 = crypto.createHash("sha256").update(fs.readFileSync(destino)).digest("hex");
        const resultado = processarFoto(db, cad, {
            arquivo: item.foto.nome, sha256, meta: item.foto.meta || {}, brutoAzure: item.bruto, modelId: item.modelo, regras,
        });
        if (resultado.ja_processada) jaExistiam += 1; else novas += 1;
    }

    const estados = db.prepare("SELECT estado, COUNT(*) AS total FROM despesas GROUP BY estado").all();
    console.log(JSON.stringify({ origem, banco: caminhoDb, fotos_encontradas: itens.length, importadas_agora: novas, ja_existiam: jaExistiam, ignorados, despesas_por_estado: estados }, null, 2));
    db.close();
}

try { executar(); } catch (erro) { console.error(`Falha: ${erro.message}`); process.exit(1); }
