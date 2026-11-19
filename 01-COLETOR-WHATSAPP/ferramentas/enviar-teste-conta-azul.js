"use strict";

// Envia despesas aprovadas da Central para o Conta Azul (conta de teste por padrao).
//   node ferramentas/enviar-teste-conta-azul.js --despesa 182            (so mostra o plano)
//   node ferramentas/enviar-teste-conta-azul.js --despesa 182 --executar (envia e confere)
//   node ferramentas/enviar-teste-conta-azul.js --todas                  (lista o que falta subir)
//   node ferramentas/enviar-teste-conta-azul.js --todas --executar       (sobe todas as aprovadas que faltam)
//   node ferramentas/enviar-teste-conta-azul.js --anexar-pendentes       (tenta de novo o anexo dos que subiram sem ele)
//   node ferramentas/enviar-teste-conta-azul.js --anexar-pendentes --antigos (inclui os enviados antes de o robo existir)
// Em qualquer um: --conta oficial envia para a conta oficial (so depois de liberada em
// config.central.envio_conta_azul.oficial). Sem --conta, e a de teste. A conta escolhida aqui nao muda a
// conta que o programa aberto esta usando.
// A foto da nota vai como IMAGEM na aba Anexo do lancamento, pelo robo de tela
// (config.central.envio_conta_azul.anexo_da_foto = "arquivo"). O robo precisa da janela dele logada na mesma
// empresa: ferramentas/abrir-navegador-conta-azul.js [oficial] ou o atalho 18.
// Vai o que esta na Central (fornecedor aprovado, categoria, centro, conta do cartao), pelo nome exato.
// Na conta de teste, o cadastro que ainda nao existe e criado com o mesmo nome; na oficial, a nota nao sobe.

const fs = require("fs");
const path = require("path");
const banco = require("../src/central/banco");
const envio = require("../src/central/envio");
const contaAzul = require("../src/conta-azul");
const drive = require("../src/central/arquivo-drive");
const cadastros = require("../src/central/cadastros");

// Tempo que o envio espera o Google Drive terminar de subir uma foto recem-copiada (so quando vai o link).
const ESPERA_LINK_MS = 60000;

const lerConfig = () => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));

/** Quando o que vai e o LINK do Drive: copia as fotos aprovadas que faltam, para o link existir. */
function arquivarFotos(db) {
    const modo = envio.modoDaFoto(lerConfig());
    if (!modo.link && !modo.observacao) return;
    const r = drive.arquivarPendentes(db, cadastros.carregar());
    if (r.desligado) return;
    if (r.erro) return console.log(`⚠ Arquivo no Drive: ${r.erro}`);
    if (r.copiadas.length || r.movidas.length || r.erros.length) {
        console.log(`Arquivo no Drive: ${r.copiadas.length} copiada(s), ${r.movidas.length} movida(s), ${r.erros.length} erro(s).`);
    }
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argumentos() {
    const opcoes = {};
    const lista = process.argv.slice(2);
    for (let i = 0; i < lista.length; i += 1) {
        const chave = lista[i].replace(/^--/, "");
        if (["executar", "todas", "anexar-pendentes", "antigos", "reenviar"].includes(chave)) opcoes[chave] = true;
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

async function umaDespesa(db, api, id, { executar, autor, conta }) {
    if (!executar) {
        const plano = await envio.planejar(db, id, { api, conta });
        console.log(`Conta: ${conta.toUpperCase()} · empresa conectada: ${plano.empresa.id} (${plano.empresa.nome})`);
        const anexo = { arquivo: `a imagem "${plano.foto_nome}" vai para a aba Anexo, pelo robô de tela`, link: `o link ${plano.foto_drive?.link} vai para a aba Anexo, pelo robô de tela` }[plano.anexar];
        console.log(`Foto: ${plano.foto || "não encontrada"}`);
        console.log(`Anexo: ${anexo || "não vai (desligado no config ou nota sem foto)"}${plano.link_na_observacao ? " · link do Drive na observação" : ""}`);
        // Vai exatamente o que esta na Central; "a cadastrar" = ainda nao existe na conta de teste e sera criado no envio.
        const situacao = (tipo, existe) => (existe ? "" : plano.faltam.some((f) => f.tipo === tipo) ? "  (a cadastrar na conta de teste)" : "");
        console.log(`Fornecedor: ${plano.fornecedor?.nome || plano.dados.fornecedor}${plano.fornecedor ? ` (${plano.fornecedor.por})` : situacao("fornecedor", false)}`);
        console.log(`Conta financeira: ${plano.conta?.nome || plano.conta_nome}${situacao("conta financeira", plano.conta)}`);
        console.log(`Categoria: ${plano.mapa.categoria?.nome?.trim() || plano.dados.categoria}${situacao("categoria", plano.mapa.categoria)}`);
        console.log(`Centro de custo: ${plano.mapa.centro?.nome || plano.dados.centro || "(nota sem centro)"}${situacao("centro de custo", plano.mapa.centro)}`);
        if (!plano.faltam.length) console.log("Será enviado:", JSON.stringify(envio.corpoDoLancamento(plano), null, 2));
        console.log("\nNada foi enviado. Repita com --executar para enviar.");
        return;
    }
    arquivarFotos(db);
    console.log(envio.relatorioEmTexto(await envio.enviar(db, id, { api, autor, conta, esperaLinkMs: ESPERA_LINK_MS })));
}

async function todas(db, api, { executar, autor, conta }) {
    const empresa = await envio.exigirEmpresa(api, lerConfig(), conta);
    const ids = envio.pendentesDeEnvio(db, empresa.id);
    console.log(`Conta ${conta.toUpperCase()} · empresa ${empresa.id} (${empresa.nome}) · ${ids.length} aprovada(s) ainda não enviada(s): ${ids.join(", ") || "-"}`);
    if (!executar) return console.log("\nNada foi enviado. Repita com --executar para enviar todas.");
    arquivarFotos(db);
    const catalogo = await envio.carregarCatalogo(api);
    const resultados = [];
    for (const [n, id] of ids.entries()) {
        let r = null;
        for (let tentativa = 0; tentativa < 2; tentativa += 1) {
            try {
                r = await envio.enviar(db, id, { api, autor, conta, catalogo, empresa, esperaLinkMs: ESPERA_LINK_MS });
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
    fs.writeFileSync(arquivo, JSON.stringify({ conta, empresa, resultados, fornecedores_criados: api.criados.map((p) => p.nome) }, null, 2), "utf8");
    console.log(`Relatório completo: ${arquivo}`);
}

/** Tenta de novo o anexo (robo de tela) dos lancamentos que subiram sem ele. */
async function anexarPendentes(db, { antigos, conta }) {
    const resultados = await envio.anexarPendentes(db, { antigos, conta });
    for (const r of resultados) console.log(`#${r.despesa_id} ${r.ok ? (r.ja_tinha ? "já tinha o anexo" : "anexo gravado") : `NÃO anexado · ${r.erro}`}`);
    console.log(`\nResumo (conta ${conta}): ${resultados.filter((r) => r.ok).length} com anexo · ${resultados.filter((r) => !r.ok).length} sem anexo · ${resultados.length} tentativa(s)`);
}

(async () => {
    const opcoes = argumentos();
    const conta = opcoes.conta === "oficial" ? "oficial" : "teste";
    if (opcoes.conta && !["teste", "oficial"].includes(opcoes.conta)) throw new Error("Use --conta teste ou --conta oficial.");
    const db = banco.abrir();
    const api = apiComMemoria();
    const dados = { executar: Boolean(opcoes.executar), autor: opcoes.autor || "terminal", conta, antigos: Boolean(opcoes.antigos) };
    // Tudo roda na conta escolhida, sem mexer no perfil gravado que o programa aberto usa.
    return contaAzul.comPerfil(conta, () => {
        if (opcoes["anexar-pendentes"]) return anexarPendentes(db, dados);
        if (opcoes.todas) return todas(db, api, dados);
        const id = Number(opcoes.despesa);
        if (!Number.isInteger(id) || id <= 0) throw new Error("Use --despesa <id>, --todas ou --anexar-pendentes.");
        // --reenviar (so conta de teste): a nota ja enviada pode subir de novo; o lancamento antigo fica la para apagar pela tela.
        if (opcoes.reenviar) {
            const { liberados } = envio.liberarReenvio(db, id, { conta });
            console.log(liberados ? `Reenvio liberado: ${liberados} envio(s) anterior(es) marcado(s) como SUBSTITUIDO. O lançamento antigo continua na conta de teste; apague pela tela de lá.` : "Não havia envio anterior desta nota para a conta de teste.");
        }
        return umaDespesa(db, api, id, dados);
    });
})().catch((erro) => { console.error(`Erro: ${erro.message}`); process.exitCode = 1; })
    // Solta a ligacao com a janela do robo (ela continua aberta), senao o processo nao termina.
    .finally(() => envio.fecharRobo());
