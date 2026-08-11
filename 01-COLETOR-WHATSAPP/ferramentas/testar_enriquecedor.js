"use strict";

// =============================================================================
// FERRAMENTA: Testar Enriquecedor Conta Azul
// =============================================================================
//
// Script CLI para testar o módulo enriquecedor de forma segura.
//
// USO:
//   node ferramentas/testar_enriquecedor.js --valor 48.00 --data 2026-08-10 \
//       --categoria "almoco" --centro "consol mg-050" --pagamento "pix"
//
// FLAGS:
//   --valor       (obrigatório) Valor da despesa em reais
//   --data        (obrigatório) Data de competência (AAAA-MM-DD)
//   --categoria   (obrigatório) Tipo da despesa (texto do operador)
//   --veiculo     (opcional)    Placa ou alias do veículo
//   --centro      (opcional)    Centro de custo (texto do operador)
//   --pagamento   (opcional)    Método de pagamento (pix, dinheiro, credito...)
//   --executar    Se presente, executa o PATCH de verdade. Sem ele, roda dry-run.
//   --tentativas  Número de tentativas na busca (padrão: 5)
//   --intervalo   Intervalo inicial de retry em ms (padrão: 10000)
//
// EXEMPLOS:
//   # Dry-run: mostra o que faria sem alterar nada
//   node ferramentas/testar_enriquecedor.js --valor 48 --data 2026-08-10 --categoria almoco --centro "consol mg-050"
//
//   # Execução real
//   node ferramentas/testar_enriquecedor.js --valor 48 --data 2026-08-10 --categoria almoco --centro "consol mg-050" --executar
//
//   # Combustível com veículo
//   node ferramentas/testar_enriquecedor.js --valor 350 --data 2026-08-10 --categoria combustivel --veiculo sgr4b54 --centro "consol mg-050" --pagamento debito
// =============================================================================

const path = require("path");

// Garantir que variáveis de ambiente estejam carregadas
const RAIZ = path.resolve(__dirname, "..");

const enriquecedor = require(path.join(RAIZ, "src", "enriquecedor-conta-azul"));

// ---------------------------------------------------------------------------
// Parser de argumentos simples (sem dependências externas)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith("--")) {
            const chave = arg.slice(2);
            // Se o próximo argumento não é uma flag, é o valor
            if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
                args[chave] = argv[++i];
            } else {
                // Flag booleana
                args[chave] = true;
            }
        }
    }
    return args;
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

function validarArgumentos(args) {
    const erros = [];

    if (!args.valor) erros.push("--valor é obrigatório (ex: --valor 48.00)");
    if (!args.data) erros.push("--data é obrigatório (ex: --data 2026-08-10)");
    if (!args.categoria) erros.push("--categoria é obrigatório (ex: --categoria almoco)");

    if (args.valor && isNaN(Number(args.valor))) {
        erros.push(`--valor inválido: "${args.valor}" (deve ser número)`);
    }

    if (args.data && !/^\d{4}-\d{2}-\d{2}$/.test(args.data)) {
        erros.push(`--data inválido: "${args.data}" (formato: AAAA-MM-DD)`);
    }

    return erros;
}

// ---------------------------------------------------------------------------
// Exibição de ajuda
// ---------------------------------------------------------------------------

function exibirAjuda() {
    console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║              TESTADOR DO ENRIQUECEDOR CONTA AZUL                   ║
╚══════════════════════════════════════════════════════════════════════╝

USO:
  node ferramentas/testar_enriquecedor.js [opções]

OBRIGATÓRIOS:
  --valor <número>       Valor da despesa (ex: 48.00)
  --data <AAAA-MM-DD>    Data de competência (ex: 2026-08-10)
  --categoria <texto>    Tipo da despesa (ex: almoco, combustivel, pedagio)

OPCIONAIS:
  --veiculo <texto>      Placa ou alias (ex: sgr4b54, scudo, gol)
  --centro <texto>       Centro de custo (ex: "consol mg-050")
  --pagamento <texto>    Método de pagamento (pix, dinheiro, credito, debito)
  --executar             Executa o PATCH de verdade (sem isso = dry-run)
  --tentativas <número>  Tentativas na busca (padrão: 5)
  --intervalo <número>   Intervalo inicial de retry em ms (padrão: 10000)
  --ajuda                Exibe esta mensagem

EXEMPLOS:
  # Dry-run (seguro, só mostra o que faria)
  node ferramentas/testar_enriquecedor.js --valor 48 --data 2026-08-10 --categoria almoco --centro "consol mg-050"

  # Combustível + veículo + pagamento
  node ferramentas/testar_enriquecedor.js --valor 350 --data 2026-08-10 --categoria combustivel --veiculo sgr4b54 --centro "consol mg-050" --pagamento debito --executar
`);
}

// ---------------------------------------------------------------------------
// Testar resolução local (sem chamar API)
// ---------------------------------------------------------------------------

function testarResolucaoLocal(args) {
    console.log("\n--- Teste de resolução local (sem API) ---\n");

    // Categoria
    const cat = enriquecedor.resolverCategoria(args.categoria, args.veiculo || null);
    if (cat) {
        console.log(`✓ Categoria: "${args.categoria}" → "${cat.nome}" (${cat.id})`);
    } else {
        console.log(`✗ Categoria: "${args.categoria}" → NÃO ENCONTRADA`);
    }

    // Centro de custo
    if (args.centro) {
        const cc = enriquecedor.resolverCentroCusto(args.centro);
        if (cc) {
            console.log(`✓ Centro de Custo: "${args.centro}" → "${cc.nome}" (${cc.id})`);
        } else {
            console.log(`✗ Centro de Custo: "${args.centro}" → NÃO ENCONTRADO`);
        }
    }

    // Método de pagamento
    if (args.pagamento) {
        const mp = enriquecedor.resolverMetodoPagamento(args.pagamento);
        if (mp) {
            console.log(`✓ Pagamento: "${args.pagamento}" → ${mp}`);
        } else {
            console.log(`✗ Pagamento: "${args.pagamento}" → NÃO RECONHECIDO`);
        }
    }

    console.log("");
}

// ---------------------------------------------------------------------------
// Execução principal
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv);

    // Ajuda
    if (args.ajuda || args.help) {
        exibirAjuda();
        process.exit(0);
    }

    // Validação
    const erros = validarArgumentos(args);
    if (erros.length > 0) {
        console.error("\n✗ Argumentos inválidos:");
        for (const erro of erros) console.error(`  - ${erro}`);
        console.error("\nUse --ajuda para ver as opções disponíveis.\n");
        process.exit(1);
    }

    const dryRun = !args.executar;
    const valor = Number(args.valor);
    const data = args.data;
    const contexto = {
        categoria: args.categoria,
        veiculo: args.veiculo || null,
        centroCusto: args.centro || null,
        metodoPagamento: args.pagamento || null,
    };

    console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
    console.log(`║  Modo: ${dryRun ? "DRY-RUN (seguro, nenhuma alteração)" : "⚠  EXECUÇÃO REAL — o PATCH será enviado!"}`.padEnd(71) + "║");
    console.log("╚══════════════════════════════════════════════════════════════════════╝");

    // Primeiro, testar a resolução local
    testarResolucaoLocal(args);

    // Executar o enriquecimento
    console.log("--- Executando enriquecimento via API ---\n");

    const opcoes = {
        dryRun,
        log: console.log,
    };
    if (args.tentativas) opcoes.tentativas = Number(args.tentativas);
    if (args.intervalo) opcoes.intervaloInicialMs = Number(args.intervalo);

    const resultado = await enriquecedor.enriquecer(valor, data, contexto, opcoes);

    // Exibir resultado final
    console.log("\n--- RESULTADO FINAL ---");
    console.log(JSON.stringify(resultado, null, 2));

    process.exit(resultado.sucesso ? 0 : 1);
}

main().catch((erro) => {
    console.error(`\n✗ Erro fatal: ${erro.message}`);
    process.exit(1);
});
