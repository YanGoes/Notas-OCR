"use strict";

// Envia despesas aprovadas da Central para o Conta Azul de TESTE.
//   node ferramentas/enviar-teste-conta-azul.js --despesa 182            (so mostra o plano)
//   node ferramentas/enviar-teste-conta-azul.js --despesa 182 --executar (envia e confere)
//   node ferramentas/enviar-teste-conta-azul.js --todas                  (lista o que falta subir)
//   node ferramentas/enviar-teste-conta-azul.js --todas --executar       (sobe todas as aprovadas que faltam)
// So funciona se a empresa conectada for config.central.envio_conta_azul.somente_empresa_id.
// Na conta de teste, fornecedor que nao existe e cadastrado (CNPJ + nome lido, ou o generico aprovado).

const fs = require("fs");
const path = require("path");
const banco = require("../src/central/banco");
const envio = require("../src/central/envio");
const contaAzul = require("../src/conta-azul");

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argumentos() {
    const opcoes = {};
    const lista = process.argv.slice(2);
    for (let i = 0; i < lista.length; i += 1) {
        const chave = lista[i].replace(/^--/, "");
        if (["executar", "todas"].includes(chave)) opcoes[chave] = true;
        else opcoes[chave] = lista[i + 1], i += 1;
    }
    return opcoes;
}

/** Cliente com memoria dos fornecedores criados no lote (a busca da API pode demorar a enxerga-los). */
function apiComMemoria() {
    const criados = [];
    return {
        ...contaAzul,
        criados,
        buscarPessoas: async (filtro) => {
            const local = criados.filter((p) => (filtro.documentos && p.documento === filtro.documentos)
                || (filtro.busca && p.nome.toLowerCase() === String(filtro.busca).toLowerCase()));
            return local.length ? local : contaAzul.buscarPessoas(filtro);
        },
        criarFornecedor: async (dados) => {
            const novo = await contaAzul.criarFornecedor(dados);
            criados.push({ ...novo, documento: String(dados.documento || "").replace(/\D/g, ""), perfis: ["Fornecedor"], ativo: true });
            return novo;
        },
    };
}

async function umaDespesa(db, api, id, executar, autor) {
    if (!executar) {
        const plano = await envio.planejar(db, id, { api });
        console.log(`Empresa conectada: ${plano.empresa.id} (${plano.empresa.nome})`);
        console.log(`Foto: ${plano.foto || "não encontrada"} (não vai para o Conta Azul: a API não aceita anexo)`);
        console.log(`Fornecedor no Conta Azul: ${plano.fornecedor.nome} (achado pelo ${plano.fornecedor.por})`);
        console.log(`Conta financeira: ${plano.conta.nome}`);
        console.log(`Categoria no Conta Azul: ${plano.mapa.categoria?.nome?.trim() || "NÃO ENCONTRADA"}`);
        console.log(`Centro no Conta Azul: ${plano.mapa.centro?.nome || "NÃO ENCONTRADO"}`);
        for (const s of plano.mapa.substituicoes) console.log(`⚠ ${s}`);
        console.log("Será enviado:", JSON.stringify(envio.corpoDoLancamento(plano), null, 2));
        console.log("\nNada foi enviado. Repita com --executar para enviar.");
        return;
    }
    console.log(envio.relatorioEmTexto(await envio.enviar(db, id, { api, autor, criarFornecedor: true })));
}

async function todas(db, api, executar, autor) {
    const empresa = await envio.exigirEmpresaDeTeste(api, JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8")));
    const ids = envio.pendentesDeEnvio(db, empresa.id);
    console.log(`Empresa ${empresa.id} (${empresa.nome}) · ${ids.length} aprovada(s) ainda não enviada(s): ${ids.join(", ") || "-"}`);
    if (!executar) return console.log("\nNada foi enviado. Repita com --executar para enviar todas.");
    const catalogo = await envio.carregarCatalogo(api);
    const resultados = [];
    for (const [n, id] of ids.entries()) {
        let r = null;
        for (let tentativa = 0; tentativa < 2; tentativa += 1) {
            try {
                r = await envio.enviar(db, id, { api, autor, catalogo, empresa, criarFornecedor: true });
            } catch (erro) {
                r = { despesa_id: id, status: "NAO_ENVIADO", erro: erro.message };
            }
            // Limite da API (429): espera e tenta a mesma nota de novo.
            if (/429/.test(r.erro || "") && tentativa === 0) { console.log("  limite da API, aguardando 60 s…"); await esperar(60000); continue; }
            break;
        }
        resultados.push(r);
        const falta = r.faltou?.length ? ` · faltou: ${r.faltou.join(", ")}` : "";
        console.log(`[${n + 1}/${ids.length}] #${id} ${r.status}${falta}${r.erro ? ` · ${r.erro.slice(0, 160)}` : ""}`);
        await esperar(1500);
    }
    const contar = (status) => resultados.filter((r) => r.status === status).length;
    console.log(`\nResumo: ${contar("ENVIADO")} enviadas completas · ${contar("ENVIADO_INCOMPLETO")} incompletas · ` +
        `${contar("INCERTO")} incertas · ${contar("FALHOU") + contar("NAO_ENVIADO")} não enviadas · ${api.criados.length} fornecedor(es) cadastrado(s)`);
    const arquivo = path.join(__dirname, "..", "dados", "logs", `envio-conta-azul-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify({ empresa, resultados, fornecedores_criados: api.criados.map((p) => p.nome) }, null, 2), "utf8");
    console.log(`Relatório completo: ${arquivo}`);
}

(async () => {
    const opcoes = argumentos();
    const db = banco.abrir();
    const api = apiComMemoria();
    const autor = opcoes.autor || "terminal";
    if (opcoes.todas) return todas(db, api, opcoes.executar, autor);
    const id = Number(opcoes.despesa);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Use --despesa <id> ou --todas.");
    return umaDespesa(db, api, id, opcoes.executar, autor);
})().catch((erro) => { console.error(`Erro: ${erro.message}`); process.exitCode = 1; });
