"use strict";

// =============================================================================
// Mede a versao ATUAL da leitura+regras contra o que uma pessoa APROVOU
// =============================================================================
//
// Uso: node ferramentas/medir-contra-aprovadas.js
//
// Reprocessa as mesmas fotos (com a resposta do Azure ja guardada, sem custo)
// num banco temporario em memoria e compara cada campo com a versao aprovada
// na Central. Mostra tambem o acerto da previa ORIGINAL (o que a IA tinha
// gerado antes das correcoes), para ver o ganho.
//
// Campos que a pessoa marcou como "nao valem para treino" (ex.: centro de
// custo e pagamento de notas antigas) ficam fora da conta.
// =============================================================================

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const banco = require("../src/central/banco");
const cadastros = require("../src/central/cadastros");
const { processarFoto, lerDespesa } = require("../src/central/orquestrador");
const { CAMPOS, valorDoCampo } = require("../src/central/revisao");
const { normalizar } = require("../src/central/texto");

const RAIZ = path.resolve(__dirname, "..");
const ORIGEM_BRUTO = path.resolve(RAIZ, "..", "..", "PROGRAMA OCR", "01-COLETOR-WHATSAPP", "dados", "ocr-bruto");

const comparavel = (valor) => (valor == null ? null : typeof valor === "string" ? normalizar(valor) : JSON.stringify(valor));

function executar() {
    const real = banco.abrir();
    const cad = cadastros.carregar();
    const regras = JSON.parse(fs.readFileSync(path.join(RAIZ, "configuracao", "regras.json"), "utf8"));
    const aprovadas = real.prepare(`
        SELECT d.id, d.campos, d.campos_originais, d.documento_id, m.arquivo, m.recebida_em, m.grupo_id, m.remetente_id, m.mensagem_id, m.legenda,
               e.rotulos
        FROM despesas d JOIN midias m ON m.id = d.midia_id LEFT JOIN exemplos_treino e ON e.despesa_id = d.id
        WHERE d.estado = 'APROVADO' ORDER BY m.recebida_em`).all();

    const temporario = banco.abrir(":memory:");
    const novasPorArquivo = new Map();
    for (const linha of real.prepare("SELECT * FROM midias ORDER BY recebida_em, id").all()) {
        const base = linha.arquivo.replace(/\.[^.]+$/, "");
        const arquivoBruto = path.join(ORIGEM_BRUTO, `${base}.json`);
        if (!fs.existsSync(arquivoBruto)) continue;
        const resultado = processarFoto(temporario, cad, {
            arquivo: linha.arquivo, sha256: linha.sha256 || crypto.randomUUID(), regras, hoje: new Date(),
            brutoAzure: JSON.parse(fs.readFileSync(arquivoBruto, "utf8")),
            meta: { id_mensagem: linha.mensagem_id, id_grupo: linha.grupo_id, remetente: linha.remetente_id, legenda: linha.legenda || "", recebido_em_ms: Date.parse(linha.recebida_em) },
        });
        novasPorArquivo.set(linha.arquivo, resultado.despesas.map((id) => lerDespesa(temporario, id)));
    }

    const placar = {};
    const detalhes = [];
    for (const aprovada of aprovadas) {
        const final = JSON.parse(aprovada.campos);
        const original = JSON.parse(aprovada.campos_originais || aprovada.campos);
        const ignorar = new Set(JSON.parse(aprovada.rotulos || "{}")._nao_usar_no_treino || []);
        const candidatas = novasPorArquivo.get(aprovada.arquivo) || [];
        // Foto com mais de uma despesa nova: compara com a que mais se parece com a aprovada.
        const nova = candidatas.map((despesa) => ({
            despesa, iguais: Object.keys(CAMPOS).filter((chave) => comparavel(valorDoCampo(despesa.campos, chave)) === comparavel(valorDoCampo(final, chave))).length,
        })).sort((a, b) => b.iguais - a.iguais)[0]?.despesa;
        for (const chave of Object.keys(CAMPOS)) {
            if (ignorar.has(chave)) continue;
            const certo = valorDoCampo(final, chave);
            if (certo == null) continue;
            const p = placar[chave] ||= { rotulo: CAMPOS[chave].rotulo, total: 0, antes: 0, depois: 0 };
            p.total += 1;
            const antes = comparavel(valorDoCampo(original, chave)) === comparavel(certo);
            const depois = nova ? comparavel(valorDoCampo(nova.campos, chave)) === comparavel(certo) : false;
            if (antes) p.antes += 1;
            if (depois) p.depois += 1;
            if (!depois) detalhes.push(`#${aprovada.id} ${chave}: aprovado ${JSON.stringify(certo)} | agora ${JSON.stringify(nova ? valorDoCampo(nova.campos, chave) : null)}`);
        }
    }
    const fotosDivididas = [...novasPorArquivo.values()].filter((lista) => lista.length > 1).length;
    console.log(`Aprovadas comparadas: ${aprovadas.length}. Fotos que agora viram mais de uma despesa: ${fotosDivididas}.\n`);
    console.log("Campo              | antes | agora | de");
    let somaAntes = 0; let somaDepois = 0; let somaTotal = 0;
    for (const p of Object.values(placar)) {
        somaAntes += p.antes; somaDepois += p.depois; somaTotal += p.total;
        console.log(`${p.rotulo.padEnd(18)} | ${String(p.antes).padStart(5)} | ${String(p.depois).padStart(5)} | ${p.total}`);
    }
    console.log(`${"TOTAL".padEnd(18)} | ${String(somaAntes).padStart(5)} | ${String(somaDepois).padStart(5)} | ${somaTotal}  (${Math.round(somaAntes / somaTotal * 100)}% -> ${Math.round(somaDepois / somaTotal * 100)}%)`);
    console.log("\nAinda diferente do aprovado:\n" + detalhes.join("\n"));
}

executar();
