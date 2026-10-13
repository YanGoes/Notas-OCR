"use strict";

// =============================================================================
// Mede a versao ATUAL da leitura+regras contra o que uma pessoa APROVOU
// =============================================================================
//
// Uso: node ferramentas/medir-contra-aprovadas.js   (npm run central:medir)
//
// Reprocessa as mesmas fotos (com a resposta do Azure ja guardada, sem custo)
// num banco temporario em memoria e compara cada campo com a versao aprovada
// na Central. Mostra tambem o acerto da previa ORIGINAL (o que a IA tinha
// gerado na epoca), para ver o ganho.
//
// Ficam fora da conta:
//   - campos marcados "nao usar no treino" (ex.: centro e pagamento de notas antigas);
//   - campos corrigidos com o motivo "Nao informado" (a IA nao tinha como saber).
//
// Grava o resultado em dados/aprendizado/medicao-aprovadas.json, que a aba
// Treino usa para mostrar a MATURIDADE da IA (src/central/maturidade.js).
// =============================================================================

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const banco = require("../src/central/banco");
const cadastros = require("../src/central/cadastros");
const { processarFoto, lerDespesa } = require("../src/central/orquestrador");
const { CAMPOS, valorDoCampo } = require("../src/central/revisao");
const { normalizar } = require("../src/central/texto");
const maturidade = require("../src/central/maturidade");
const { habitosDoOperador } = require("../src/central/habitos");

const RAIZ = path.resolve(__dirname, "..");
// Respostas do Azure: as desta instalacao e, se existir, as da pasta antiga.
const PASTAS_BRUTO = [
    path.join(RAIZ, "dados", "ocr-bruto"),
    path.resolve(RAIZ, "..", "..", "PROGRAMA OCR", "01-COLETOR-WHATSAPP", "dados", "ocr-bruto"),
];
const SAIDA = path.join(RAIZ, "dados", "aprendizado", "medicao-aprovadas.json");

const comparavel = (valor) => (valor == null ? null : typeof valor === "string" ? normalizar(valor) : JSON.stringify(valor));

function respostaAzure(arquivo) {
    const base = arquivo.replace(/\.[^.]+$/, "");
    for (const pasta of PASTAS_BRUTO) {
        const caminho = path.join(pasta, `${base}.json`);
        if (fs.existsSync(caminho)) {
            const bruto = JSON.parse(fs.readFileSync(caminho, "utf8"));
            return bruto?.analyzeResult ? bruto : null;
        }
    }
    return null;
}

function executar() {
    const real = banco.abrir();
    const cad = cadastros.carregar();
    const regras = JSON.parse(fs.readFileSync(path.join(RAIZ, "configuracao", "regras.json"), "utf8"));
    const aprovadas = real.prepare(`
        SELECT d.id, d.campos, d.campos_originais, m.arquivo, e.rotulos
        FROM despesas d JOIN midias m ON m.id = d.midia_id LEFT JOIN exemplos_treino e ON e.despesa_id = d.id
        WHERE d.estado = 'APROVADO' ORDER BY m.recebida_em`).all();
    // Ultimo motivo de correcao de cada campo, por despesa.
    const motivos = new Map();
    for (const linha of real.prepare("SELECT despesa_id, campo, tipo_erro FROM correcoes ORDER BY id").all()) {
        if (!motivos.has(linha.despesa_id)) motivos.set(linha.despesa_id, new Map());
        motivos.get(linha.despesa_id).set(linha.campo, linha.tipo_erro);
    }

    // Reprocessa as fotos com a versao atual, em memoria (as mensagens de
    // contexto vem na ordem em que chegaram).
    const temporario = banco.abrir(":memory:");
    // Quem e quem (codigo do WhatsApp -> pessoa), igual ao banco real.
    const copiarVinculo = temporario.prepare("INSERT INTO remetentes_vinculados (whatsapp_id, pessoa_id, origem, vinculado_em) VALUES (?, ?, ?, ?)");
    for (const v of real.prepare("SELECT * FROM remetentes_vinculados").all()) copiarVinculo.run(v.whatsapp_id, v.pessoa_id, v.origem, v.vinculado_em);
    const novasPorArquivo = new Map();
    let semLeitura = 0;
    for (const linha of real.prepare("SELECT * FROM midias ORDER BY recebida_em, id").all()) {
        const bruto = respostaAzure(linha.arquivo);
        if (!bruto) { semLeitura += 1; continue; }
        // Habitos do operador vem do banco REAL, sem as despesas desta foto
        // (senao a nota "cola" a propria resposta e a maturidade sai inflada).
        const daFoto = real.prepare("SELECT id FROM despesas WHERE midia_id = ?").all(linha.id).map((d) => d.id);
        const resultado = processarFoto(temporario, cad, {
            arquivo: linha.arquivo, sha256: linha.sha256 || crypto.randomUUID(), regras, hoje: new Date(), brutoAzure: bruto,
            obterHabitos: (pessoaId) => habitosDoOperador(real, pessoaId, { excluirDespesas: daFoto }),
            meta: { id_mensagem: linha.mensagem_id, id_grupo: linha.grupo_id, remetente: linha.remetente_id, legenda: linha.legenda || "", recebido_em_ms: Date.parse(linha.recebida_em) },
        });
        novasPorArquivo.set(linha.arquivo, resultado.despesas.map((id) => lerDespesa(temporario, id)));
    }

    const placar = {};
    const detalhes = [];
    let comparadas = 0; let perfeitas = 0; let perfeitasAntes = 0;
    for (const aprovada of aprovadas) {
        const candidatas = novasPorArquivo.get(aprovada.arquivo) || [];
        if (!candidatas.length) continue;
        const final = JSON.parse(aprovada.campos);
        const original = JSON.parse(aprovada.campos_originais || aprovada.campos);
        const ignorar = new Set(JSON.parse(aprovada.rotulos || "{}")._nao_usar_no_treino || []);
        const motivosDaDespesa = motivos.get(aprovada.id) || new Map();
        // Foto com mais de uma despesa nova: compara com a que mais se parece com a aprovada.
        const nova = candidatas.map((despesa) => ({
            despesa, iguais: Object.keys(CAMPOS).filter((chave) => comparavel(valorDoCampo(despesa.campos, chave)) === comparavel(valorDoCampo(final, chave))).length,
        })).sort((a, b) => b.iguais - a.iguais)[0].despesa;
        comparadas += 1;
        let todosCertos = true; let todosCertosAntes = true;
        for (const chave of Object.keys(CAMPOS)) {
            if (ignorar.has(chave) || motivosDaDespesa.get(chave) === "NAO_INFORMADO") continue;
            const certo = valorDoCampo(final, chave);
            if (certo == null) continue;
            const p = placar[chave] ||= { rotulo: CAMPOS[chave].rotulo, total: 0, antes: 0, depois: 0 };
            p.total += 1;
            const antes = comparavel(valorDoCampo(original, chave)) === comparavel(certo);
            const depois = comparavel(valorDoCampo(nova.campos, chave)) === comparavel(certo);
            if (antes) p.antes += 1; else todosCertosAntes = false;
            if (depois) p.depois += 1;
            else {
                todosCertos = false;
                detalhes.push(`#${aprovada.id} ${chave}: aprovado ${JSON.stringify(certo)} | agora ${JSON.stringify(valorDoCampo(nova.campos, chave))}`);
            }
        }
        if (todosCertos) perfeitas += 1;
        if (todosCertosAntes) perfeitasAntes += 1;
    }

    const resultado = {
        gerado_em: new Date().toISOString(), aprovadas: aprovadas.length, comparadas, fotos_sem_leitura_guardada: semLeitura,
        notas_inteiras_certas: { atual: perfeitas, antes: perfeitasAntes, de: comparadas },
        por_campo: Object.fromEntries(Object.entries(placar).map(([chave, p]) => [chave, { rotulo: p.rotulo, total: p.total, acertos: p.depois, acertos_antes: p.antes }])),
        diferencas: detalhes,
    };
    resultado.maturidade = maturidade.avaliar(resultado);
    fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
    fs.writeFileSync(SAIDA, JSON.stringify(resultado, null, 2), "utf8");

    console.log(`Aprovadas: ${aprovadas.length} | comparadas com a versao atual: ${comparadas} | notas inteiras certas: ${perfeitas} de ${comparadas} (antes: ${perfeitasAntes}).\n`);
    console.log("Campo              | antes | agora | de");
    let somaAntes = 0; let somaDepois = 0; let somaTotal = 0;
    for (const p of Object.values(placar)) {
        somaAntes += p.antes; somaDepois += p.depois; somaTotal += p.total;
        console.log(`${p.rotulo.padEnd(18)} | ${String(p.antes).padStart(5)} | ${String(p.depois).padStart(5)} | ${p.total}`);
    }
    if (somaTotal) console.log(`${"TOTAL".padEnd(18)} | ${String(somaAntes).padStart(5)} | ${String(somaDepois).padStart(5)} | ${somaTotal}  (${Math.round(somaAntes / somaTotal * 100)}% -> ${Math.round(somaDepois / somaTotal * 100)}%)`);
    console.log(`\n${maturidade.texto(resultado.maturidade)}`);
    console.log(`\nAinda diferente do aprovado:\n${detalhes.join("\n") || "(nada)"}`);
    console.log(`\nResultado gravado em ${SAIDA}`);
}

executar();
