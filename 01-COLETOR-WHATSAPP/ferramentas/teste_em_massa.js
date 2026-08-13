"use strict";

// =============================================================================
// TESTE EM MASSA — validacao do reconhecimento
// =============================================================================
//
// Roda o pipeline real (Azure OCR + classificacao + validacao) sobre um lote
// grande de comprovantes, variando o tipo de legenda, e gera um relatorio do
// que foi reconhecido.
//
// SEGURANCA: chama o pipeline SEM callback. O pipeline so dispara acao
// financeira quando recebe um callback (ver testes/pipeline.test.js), portanto
// esta ferramenta NUNCA cria despesa no Conta Azul, nem manda nada ao Conta AI.
//
// CUSTO: cada foto e uma chamada paga ao Azure Document Intelligence. Comece
// com poucas (--quantidade 50) antes de rodar centenas.
//
// USO:
//   node ferramentas/teste_em_massa.js --zip "C:\...\FOTOS NOTINHAS.zip" --quantidade 100
//   node ferramentas/teste_em_massa.js --pasta "C:\fotos" --quantidade 50 --intervalo 20
//
// FLAGS:
//   --zip <caminho>        arquivo .zip com as fotos
//   --pasta <caminho>      pasta com as fotos (alternativa ao zip)
//   --quantidade <n>       quantas notas testar (padrao: 50)
//   --intervalo <seg>      pausa entre as notas, simulando envio real (padrao: 0)
//   --relatorio <caminho>  onde gravar o relatorio (padrao: dados/relatorio-teste-massa.json)
// =============================================================================

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RAIZ = path.resolve(__dirname, "..");
const { processar } = require(path.join(RAIZ, "src", "pipeline"));

function args(argv) {
    const saida = {};
    for (let i = 2; i < argv.length; i++) {
        if (!argv[i].startsWith("--")) continue;
        const chave = argv[i].slice(2);
        const valor = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
        saida[chave] = valor;
    }
    return saida;
}

// Variacoes de legenda que refletem como os operadores realmente escrevem.
//
// O tipo da despesa NAO e sorteado de proposito: sortear "Almoco" para um cupom
// de posto medria o acerto do sorteio, nao do programa. As legendas trazem o
// centro de custo e a placa (que o operador de fato sabe) e deixam o tipo para
// o reconhecimento — que e justamente o que queremos avaliar.
const PADROES_LEGENDA = [
    { nome: "centro_e_placa", peso: 3, gerar: (c) => `${c.centro}\nPlaca ${c.placa}` },
    { nome: "centro_estruturado", peso: 2, gerar: (c) => `Centro de custo: ${c.centro}\nConta/cartao: ${c.pagamento}` },
    { nome: "so_centro", peso: 3, gerar: (c) => `${c.centro}` },
    { nome: "sem_legenda", peso: 3, gerar: () => "" },
    { nome: "com_ruido", peso: 2, gerar: (c) => `${c.centro} obrigado!! chegou agora` },
    { nome: "projeto_inexistente", peso: 1, gerar: () => "obra que nao existe no cadastro" },
];

const TIPOS = ["Abastecimento", "Almoco", "Janta", "Cafe", "Hospedagem", "Farmacia", "Manutencao"];
const PLACAS = ["JKM0I96", "RLQ4C16", "ABC1234", "OMU7H82"];

function sortear(lista) { return lista[Math.floor(Math.random() * lista.length)]; }

function sortearPadrao() {
    const expandido = PADROES_LEGENDA.flatMap((p) => Array(p.peso).fill(p));
    return sortear(expandido);
}

function extrairDoZip(zip, destino, quantidade) {
    fs.mkdirSync(destino, { recursive: true });
    const script = `
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead('${zip.replace(/'/g, "''")}')
        $fotos = $zip.Entries | Where-Object { $_.Length -gt 30000 -and $_.FullName -match '\\.(jpg|jpeg|png)$' }
        $total = [Math]::Min(${quantidade}, $fotos.Count)
        $passo = [Math]::Max(1, [Math]::Floor($fotos.Count / $total))
        for ($i = 0; $i -lt $total; $i++) {
            $e = $fotos[$i * $passo]
            if (-not $e) { break }
            $saida = Join-Path '${destino.replace(/'/g, "''")}' ("massa_{0:D4}.jpg" -f $i)
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $saida, $true)
        }
        $zip.Dispose()
        Write-Output "extraidas"
    `;
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "pipe" });
    return fs.readdirSync(destino).filter((n) => /\.(jpe?g|png)$/i.test(n)).map((n) => path.join(destino, n));
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const opcoes = args(process.argv);
    const quantidade = Number(opcoes.quantidade || 50);
    const intervalo = Number(opcoes.intervalo || 0);
    const relatorioPath = String(opcoes.relatorio || path.join(RAIZ, "dados", "relatorio-teste-massa.json"));

    const centros = JSON.parse(fs.readFileSync(path.join(RAIZ, "configuracao", "centros_custo.json"), "utf8"))
        .map((c) => c.nome);
    if (!centros.length) throw new Error("Nenhum centro de custo configurado.");

    let fotos = [];
    const temporario = path.join(RAIZ, "dados", "_massa_origem");
    if (opcoes.zip) {
        console.log(`Extraindo ate ${quantidade} fotos de ${opcoes.zip}...`);
        fotos = extrairDoZip(String(opcoes.zip), temporario, quantidade);
    } else if (opcoes.pasta) {
        fotos = fs.readdirSync(String(opcoes.pasta))
            .filter((n) => /\.(jpe?g|png)$/i.test(n))
            .slice(0, quantidade)
            .map((n) => path.join(String(opcoes.pasta), n));
    } else {
        throw new Error("Informe --zip ou --pasta.");
    }

    console.log(`\n${fotos.length} comprovantes para testar.`);
    console.log("Nenhuma despesa sera criada no Conta Azul e nada sera enviado ao Conta AI.\n");

    const entrada = path.join(RAIZ, "dados", "entrada");
    fs.mkdirSync(entrada, { recursive: true });

    // O indice de duplicidade e do uso real. Testar as mesmas fotos marcaria
    // tudo como repetido e sujaria o historico — entao guarda e devolve no fim.
    const indicePath = path.join(RAIZ, "dados", "auditoria", "indice-duplicidade.json");
    const indiceBackup = fs.existsSync(indicePath) ? fs.readFileSync(indicePath, "utf8") : null;
    const restaurarIndice = () => {
        if (indiceBackup === null) fs.rmSync(indicePath, { force: true });
        else fs.writeFileSync(indicePath, indiceBackup, "utf8");
    };
    fs.rmSync(indicePath, { force: true });
    process.on("exit", restaurarIndice);

    const resultados = [];
    for (const [indice, foto] of fotos.entries()) {
        const contexto = {
            tipo: sortear(TIPOS),
            centro: sortear(centros),
            placa: sortear(PLACAS),
            pagamento: sortear(["credito", "debito", "pix", "dinheiro"]),
        };
        const padrao = sortearPadrao();
        const legenda = padrao.gerar(contexto);
        const base = `massa_${String(indice).padStart(4, "0")}_${Date.now()}`;
        const destino = path.join(entrada, `${base}.jpg`);

        fs.copyFileSync(foto, destino);
        fs.writeFileSync(path.join(entrada, `${base}.json`), JSON.stringify({
            id_mensagem: `massa-${base}`, remetente: "teste-massa", legenda,
            recebido_em_ms: Date.now(),
            centro_custo_padrao: { nome: centros[0] },
        }, null, 2), "utf8");

        try {
            // Sem callback: o pipeline nao dispara nada financeiro.
            const final = await processar(destino, { modo: "simulacao" });
            const destinoFila = final.validacoes.bloqueado ? "bloqueados"
                : final.validacoes.revisao_necessaria ? "revisao" : "aprovada";
            resultados.push({
                base, padrao_legenda: padrao.nome, legenda,
                fila: destinoFila,
                fornecedor: final.ocr.fornecedor, valor: final.ocr.valor, data: final.ocr.data,
                confianca: final.ocr.confianca,
                tipo: final.classificacao.tipo, tipo_origem: final.classificacao.tipo_origem,
                categoria: final.classificacao.categoria_nome,
                categoria_id: final.classificacao.categoria_id,
                centro: final.classificacao.centro_custo_nome,
                centro_origem: final.classificacao.centro_custo_origem,
                placa: final.dados_abastecimento?.placa || final.classificacao.placa || null,
                pagamento: final.forma_pagamento?.codigo || null,
                pronta_para_lancar: Boolean(!final.validacoes.bloqueado && !final.validacoes.revisao_necessaria
                    && final.classificacao.categoria_id && final.classificacao.centro_custo_id),
                motivos: final.validacoes.motivos,
            });
            const marca = destinoFila === "aprovada" ? "OK    " : destinoFila === "revisao" ? "REVISAO" : "BLOQ. ";
            console.log(`[${indice + 1}/${fotos.length}] ${marca} ${padrao.nome.padEnd(22)} ${String(final.ocr.fornecedor || "?").slice(0, 28).padEnd(28)} R$ ${String(final.ocr.valor || "?").padEnd(8)} ${final.classificacao.tipo || "-"}`);
        } catch (erro) {
            resultados.push({ base, padrao_legenda: padrao.nome, legenda, fila: "erro", erro: erro.message });
            console.log(`[${indice + 1}/${fotos.length}] ERRO   ${erro.message.slice(0, 70)}`);
        }

        if (intervalo) await esperar(intervalo * 1000);
    }

    // ---------------------------------------------------------------------
    // Relatorio
    // ---------------------------------------------------------------------
    const total = resultados.length;
    const conta = (fn) => resultados.filter(fn).length;
    const pct = (n) => `${((n / Math.max(total, 1)) * 100).toFixed(1)}%`;

    const motivos = {};
    for (const r of resultados) for (const m of r.motivos || []) {
        const chave = m.split(";")[0].slice(0, 70);
        motivos[chave] = (motivos[chave] || 0) + 1;
    }

    const porPadrao = {};
    for (const r of resultados) {
        porPadrao[r.padrao_legenda] = porPadrao[r.padrao_legenda] || { total: 0, prontas: 0 };
        porPadrao[r.padrao_legenda].total += 1;
        if (r.pronta_para_lancar) porPadrao[r.padrao_legenda].prontas += 1;
    }

    const resumo = {
        gerado_em: new Date().toISOString(),
        total,
        prontas_para_lancar: conta((r) => r.pronta_para_lancar),
        em_revisao: conta((r) => r.fila === "revisao"),
        bloqueadas: conta((r) => r.fila === "bloqueados"),
        erros: conta((r) => r.fila === "erro"),
        leitura: {
            com_fornecedor: conta((r) => r.fornecedor),
            com_valor: conta((r) => Number(r.valor) > 0),
            com_data: conta((r) => r.data),
            com_categoria: conta((r) => r.categoria_id),
            com_centro: conta((r) => r.centro),
            com_pagamento: conta((r) => r.pagamento),
            com_placa: conta((r) => r.placa),
        },
        origem_do_tipo: resultados.reduce((acc, r) => {
            const chave = r.tipo_origem || "nao_reconhecido";
            acc[chave] = (acc[chave] || 0) + 1;
            return acc;
        }, {}),
        por_padrao_de_legenda: porPadrao,
        motivos_de_revisao: Object.fromEntries(Object.entries(motivos).sort((a, b) => b[1] - a[1])),
    };

    fs.writeFileSync(relatorioPath, JSON.stringify({ resumo, resultados }, null, 2), "utf8");

    console.log("\n" + "=".repeat(70));
    console.log("RESUMO");
    console.log("=".repeat(70));
    console.log(`Total testado          : ${total}`);
    console.log(`Prontas para lancar    : ${resumo.prontas_para_lancar} (${pct(resumo.prontas_para_lancar)})`);
    console.log(`Em revisao humana      : ${resumo.em_revisao} (${pct(resumo.em_revisao)})`);
    console.log(`Bloqueadas (duplicada) : ${resumo.bloqueadas}`);
    console.log(`Erros de leitura       : ${resumo.erros}`);
    console.log("\nLEITURA AUTOMATICA:");
    for (const [campo, qtd] of Object.entries(resumo.leitura)) {
        console.log(`  ${campo.replace("com_", "").padEnd(12)}: ${String(qtd).padStart(4)} (${pct(qtd)})`);
    }
    console.log("\nAPROVEITAMENTO POR TIPO DE LEGENDA:");
    for (const [padrao, dados] of Object.entries(porPadrao)) {
        console.log(`  ${padrao.padEnd(22)}: ${dados.prontas}/${dados.total} prontas`);
    }
    console.log("\nPRINCIPAIS MOTIVOS DE REVISAO:");
    for (const [motivo, qtd] of Object.entries(resumo.motivos_de_revisao).slice(0, 8)) {
        console.log(`  ${String(qtd).padStart(4)}x  ${motivo}`);
    }
    console.log(`\nRelatorio completo: ${relatorioPath}`);

    // Limpa os artefatos do teste para nao poluir as filas do uso real.
    for (const pasta of ["entrada", "simulacao", "revisao", "bloqueados", "erros", "auditoria", "ocr-bruto"]) {
        const dir = path.join(RAIZ, "dados", pasta);
        if (!fs.existsSync(dir)) continue;
        for (const arquivo of fs.readdirSync(dir)) {
            if (arquivo.startsWith("massa_")) fs.rmSync(path.join(dir, arquivo), { force: true });
        }
    }
    restaurarIndice();
    if (opcoes.zip && fs.existsSync(temporario)) fs.rmSync(temporario, { recursive: true, force: true });
}

main().catch((erro) => { console.error("\nFalhou:", erro.message); process.exit(1); });
