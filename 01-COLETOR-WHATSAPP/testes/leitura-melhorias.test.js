"use strict";

// Melhorias de leitura e regras pedidas na revisao de 10/10/2026.
// Os textos imitam os padroes das notas reais, com dados ficticios.

const test = require("node:test");
const assert = require("node:assert/strict");

const ocr = require("../src/azure-ocr");
const { dividirDocumentos } = require("../src/central/documentos");
const cadastros = require("../src/central/cadastros");
const regras = require("../src/central/regras-vmac");
const banco = require("../src/central/banco");
const revisao = require("../src/central/revisao");
const orquestrador = require("../src/central/orquestrador");

// --- Placa e hodometro --------------------------------------------------------

test("placa com rotulo lido torto e letra no lugar de numero e corrigida", () => {
    const placa = ocr.placaDetalhada("PLACA: RBTZE25 |KM: 157219 MED:3091,15");
    assert.equal(placa.placa, "RBT-2E25");
    assert.equal(placa.bruta, "RBTZE25");
    assert.equal(placa.corrigida, true);
    assert.equal(ocr.placaDetalhada("Func FULANO\nFLACA ABC1D23").placa, "ABC-1D23");
});

test("placa ilegivel fica como texto bruto, nunca inventada", () => {
    const placa = ocr.placaDetalhada("FLACA JKMOISE\nHM: 154.260.00");
    assert.equal(placa.placa, null);
    assert.equal(placa.bruta, "JKMOISE");
});

test("hodometro com rotulo HM e com centavos impressos", () => {
    assert.equal(ocr.odometroDetalhado("FLACA XYZ\nHM: 154.260.00").valor, 154260);
    assert.equal(ocr.odometroDetalhado("18 odometro : 191 482,00 DE ACORDO").valor, 191482);
    // km da rodovia no endereco continua ignorado
    assert.equal(ocr.odometroDetalhado("ROD BR 385 KM. 521\nKM: 157219").valor, 157219);
});

test("hodometro sem rotulo so vale colado a linha da placa, e marcado", () => {
    const lido = ocr.odometroDetalhado("TRIB APROX\n166759\nJKM0196\nFRENTISTA");
    assert.deepEqual(lido, { valor: 166759, origem: "numero_ao_lado_da_placa" });
    assert.equal(ocr.odometroDetalhado("TOTAL\n166759\nOBRIGADO").valor, null, "numero solto longe da placa nao vira hodometro");
});

test("dois hodometros diferentes no mesmo texto: nao escolhe", () => {
    assert.equal(ocr.odometroDetalhado("odometro: 191482\nKM: 157219").valor, null);
});

test("hodometro 'Km .: 53832' (ponto e dois-pontos juntos, posto Campo Limpo/MT #502/#539) e 'KH' lido no lugar de KM (#504)", () => {
    const campoLimpo = "RODOVIA MT 010 KM 06, SN, SN - CAMPO LIMPO\nPlaca : FHH3G21\nKm .: 53832\nObs .:";
    assert.deepEqual(ocr.odometroDetalhado(campoLimpo), { valor: 53832, origem: "rotulo_hodometro" });
    assert.equal(ocr.odometroDetalhado("OD NPJ: 05.35 KM 06, SN\nKm .: 205086\nKm 10").valor, 205086);
    assert.equal(ocr.odometroDetalhado("PLACA: SFI-4A94\nKH 44907 - MED: 1496.00").valor, 44907);
});

test("km da estrada com letra grudada ('ORODOVIA MG 050 00 KM 3715', #478) nao conta como hodometro", () => {
    const texto = "POSTO FLORESTA\nORODOVIA MG 050 00 KM 3715 POSTO FLORESTA\nPLACA: REP7839 ODOM: 220495";
    assert.deepEqual(ocr.odometroDetalhado(texto), { valor: 220495, origem: "rotulo_hodometro" });
});

test("duas notas na mesma foto, cada uma com o seu km (#498): vale o km da linha da placa da nota", () => {
    const texto = "PLACA: OVN1505 KM: 279299 VENDEDOR: ANDRE\nDIESEL S10 47.451\nLACA: REP7839 KM: 220888 MOTORISTA: ALMIR";
    assert.equal(ocr.odometroDetalhado(texto).valor, null, "sozinho continua sem escolher");
    assert.equal(regras.odometroDaLinhaDaPlaca(texto, "REP7B39"), 220888, "REP7839 lida = REP7B39 (8 no lugar de B)");
    assert.equal(regras.odometroDaLinhaDaPlaca(texto, "OVN1505"), 279299);
    assert.equal(regras.odometroDaLinhaDaPlaca(texto, "ABC1D23"), null);
    // Placa numa linha e km na de baixo.
    assert.equal(regras.odometroDaLinhaDaPlaca("Placa : FHH3G21\nKm .: 53832", "FHH3G21"), 53832);
});

test("leitura guardada sem hodometro e relida do texto (Regerar previa acerta notas antigas)", () => {
    assert.deepEqual(regras.odometroDaNota({ odometro: null, texto_bruto: "Placa : FHH3G21\nKm .: 53832" }), { valor: 53832, leitura: "rotulo_hodometro" });
    assert.deepEqual(regras.odometroDaNota({ odometro: 1234, odometro_origem: "rotulo_hodometro", texto_bruto: "Km .: 53832" }), { valor: 1234, leitura: "rotulo_hodometro" });
    assert.deepEqual(regras.odometroDaNota(null), { valor: null, leitura: null });
});

// --- Fornecedor: prestador da NFS-e e nunca a propria VMac --------------------

const NFSE_HOTEL = [
    "NOTA FISCAL DE SERVIÇOS ELETRÔNICA - NFS-e", "PRESTADOR DE SERVIÇOS", "Razão Social", "HOTEL BOA NOITE LTDA",
    "CPF/CNPJ", "11.222.333/0001-81", "TOMADOR DE SERVIÇOS", "Nome/Razão Social", "VMAC. ENGENHARIA DE INFRAESTRUTURAS LTDA",
    "CPF/CNPJ", "33.229.221/0001-95", "SERVIÇO PRESTADO", "0901 - Hospedagem de qualquer natureza em hotéis",
    "DESCRIÇÃO DOS SERVIÇOS", "Diarias", "QTD_HOSPEDE: 2", "Valor Total (R$) 280,00",
].join("\n");

test("NFS-e de hotel: fornecedor e o prestador, nao a VMac (tomador)", () => {
    assert.equal(ocr.prestadorNfse(NFSE_HOTEL), "HOTEL BOA NOITE LTDA");
    assert.equal(ocr.fornecedorDoTexto(NFSE_HOTEL, "VMAC. ENGENHARIA DE INFRAESTRUTURAS LTDA"), "HOTEL BOA NOITE LTDA");
    assert.notEqual(ocr.cnpjDoTexto("EMPRESA: VMAC\nCNPJ 33.229.221/0001-95\nHOTEL\nCNPJ 11.222.333/0001-81"), "33229221000195");
});

test("data lida no futuro e trocada pela outra data da nota", () => {
    // O Azure entregou 2035 no campo estruturado; o texto tem "15/09/25" (2025).
    const lido = ocr.normalizarResultadoAzure({ analyzeResult: { content: "Data: 15/09/25\nAUTORIZACAO 15/09/2035 05:27",
        documents: [{ fields: { TransactionDate: { type: "date", valueDate: "2035-09-15" } } }] } });
    assert.equal(lido.data, "2025-09-15");
    assert.equal(lido.data_lida_descartada, "2035-09-15");
});

// --- Duas notas lado a lado na mesma foto -------------------------------------

function linha(texto, x0, x1, y) { return { content: texto, polygon: [x0, y, x1, y, x1, y + 9, x0, y + 9] }; }

function fotoComDuasNotas() {
    const esquerda = ["AUTO POSTO SOL LTDA", "CNPJ 11.222.333/0001-81", "DOCUMENTO AUXILIAR DA NFC-e", "DIESEL S10", "VALOR A PAGAR R$ 350,43",
        "27/03/2026 05:34", "PLACA: RBT2E25 |KM: 157219", "bico 3 bomba 2", "obrigado", "volte sempre", "via cliente", "consumidor"];
    const direita = ["POSTO LAVOURA LTDA", "CNPJ 44.555.666/0001-71", "DOCUMENTO AUXILIAR DA NFC-e", "GASOLINA C", "VALOR A PAGAR R$ 494,58",
        "27/03/2026 10:58", "Placa : REP7B39 odometro : 191 482,00", "bico 1 bomba 4", "obrigado", "volte sempre", "via cliente", "consumidor"];
    const linhas = [
        ...esquerda.map((texto, i) => linha(texto, 20, 320, 100 + i * 40)),
        ...direita.map((texto, i) => linha(texto, 400, 700, 105 + i * 40)),
    ];
    // O Azure devolve o texto intercalado e UM documento so.
    const conteudo = esquerda.flatMap((texto, i) => [texto, direita[i]]).join("\n");
    return { analyzeResult: { content: conteudo, documents: [{ docType: "receipt.retailMeal", fields: {} }], pages: [{ width: 720, height: 1280, lines: linhas }] } };
}

test("foto com duas notas lado a lado vira duas despesas, uma por coluna", () => {
    const documentos = dividirDocumentos(fotoComDuasNotas());
    assert.equal(documentos.length, 2);
    const [esq, dir] = documentos.map((d) => d.ocr);
    assert.equal(esq.separada_da_foto.coluna, "esquerda");
    assert.equal(esq.placa, "RBT-2E25");
    assert.equal(esq.odometro, 157219);
    assert.equal(dir.placa, "REP-7B39");
    assert.equal(dir.odometro, 191482);
    assert.ok(documentos.every((d) => d.papel === "PRINCIPAL"));
});

test("foto com UMA nota nao e dividida", () => {
    const umaSo = fotoComDuasNotas();
    umaSo.analyzeResult.pages[0].lines = umaSo.analyzeResult.pages[0].lines.map((l) => ({ ...l, polygon: [20, l.polygon[1], 700, l.polygon[1], 700, l.polygon[5], 20, l.polygon[5]] }));
    assert.equal(dividirDocumentos(umaSo).length, 1);
});

test("nota UNICA fotografada de lado (texto na vertical) nao e cortada em duas", () => {
    // Foto deitada: cada linha do texto e uma faixa vertical estreita; o Azure
    // informa angle ~ -90. Sem girar, as linhas pareciam duas colunas.
    const textos = ["RESTAURANTE BOA MESA LTDA", "CNPJ 11.222.333/0001-81", "DOCUMENTO AUXILIAR DA NOTA FISCAL CONSUMIDOR ELETRONICA",
        "001 SELF SERVICE KG 30,84", "002 COCA COLA 2L 17,90", "QTD total de itens", "Valor total", "165,61",
        "CONSUMIDOR NAO IDENTIFICADO", "Emissao 20/10/2026 12:50:39", "Consulte pela CHAVE DE ACESSO", "EMITIDA EM CONTINGENCIA",
        "Pendente de Autorizacao", "Conta: 350", "Trib aprox R$: 22,51 Fed", "Fonte: IBPT", "Operador: 3", "Obrigado - Volte sempre!",
        "NFC-e numero 17370", "linha 20", "linha 21", "linha 22"];
    // Texto subindo (angle -90): a linha i fica em x = 140 + i*55 e ocupa y de 700 a 100.
    const linhas = textos.map((texto, i) => {
        const x0 = 140 + i * 55, x1 = x0 + 30;
        return { content: texto, polygon: [x0, 700, x0, 100, x1, 100, x1, 700] };
    });
    const bruto = { analyzeResult: { content: textos.join("\n"), documents: [{ docType: "receipt.retailMeal", fields: {} }],
        pages: [{ width: 1600, height: 900, angle: -89.5, lines: linhas }] } };
    const documentos = dividirDocumentos(bruto);
    assert.equal(documentos.length, 1);
    assert.equal(documentos[0].ocr.separada_da_foto, undefined);
    assert.equal(documentos[0].ocr.valor, 165.61);
});

// --- Regras: fornecedor generico, placa parecida, pessoas ---------------------

function cad() {
    return {
        pessoas: [], projetos: [], centros: [], cartoes: [],
        veiculos: [{ nome: "ETIOS - JKM0I96", placa: "JKM0I96", categoria_nome_conta_azul: "ETIOS - JKM0I96" },
            { nome: "SAVEIRO - RBT2E25", placa: "RBT2E25", categoria_nome_conta_azul: "SAVEIRO - RBT2E25" }],
        categorias: [{ nome: "JANTAR", nome_conta_azul: "Refeição - Jantar", id: "x" }, { nome: "HOSPEDAGEM", nome_conta_azul: "HOSPEDAGEM", id: "y" }],
        fornecedores: { genericos_por_tipo: { ABASTECIMENTO: "POSTOS DE COMBUSTÍVEL", JANTAR: "RESTAURANTES", HOSPEDAGEM: "HOTÉIS" }, recorrentes: [] },
    };
}

const previa = (ocrLido, legenda = {}) => regras.montarPrevia({ ocr: { confianca: 0.99, data: "2026-09-30", valor: 100, ...ocrLido }, legenda, identificacao: {}, cad: cad(), hoje: new Date("2026-10-02T12:00:00Z"), modelo: null });

test("posto, restaurante e hotel usam o fornecedor generico; o nome lido fica guardado", () => {
    const posto = previa({ fornecedor: "AUTO POSTO CANGUSSU LTDA", itens: [{ descricao: "GASOLINA C", quantidade: 30.5 }], litragem: 30.5 });
    assert.equal(posto.campos.fornecedor.valor, "POSTOS DE COMBUSTÍVEL");
    assert.equal(posto.campos.fornecedor.nome_lido, "AUTO POSTO CANGUSSU LTDA");
    const hotel = previa({ fornecedor: "HOTEL BOA NOITE LTDA", texto_bruto: NFSE_HOTEL });
    assert.equal(hotel.campos.tipo.valor, "HOSPEDAGEM");
    assert.equal(hotel.campos.fornecedor.valor, "HOTÉIS");
});

test("NFS-e com 'Diarias' e hospedagem mesmo que o Azure diga refeicao; hospedes viram estimativa", () => {
    const p = previa({ fornecedor: "HOTEIS E TURISMO LTDA", texto_bruto: NFSE_HOTEL, tipo_despesa_sugerido: "alimentacao", hora: "05:33:45" });
    assert.equal(p.campos.tipo.valor, "HOSPEDAGEM");
    assert.equal(p.campos.pessoas.valor, 2);
    assert.equal(p.campos.pessoas.confirmado, false);
    assert.equal(p.campos.descricao.valor, "HOSPEDAGEM - 2 PESSOAS");
    assert.ok(p.pendencias.some((x) => x.includes("hóspede")));
});

test("pessoas pela maior quantidade de um item (4 coxinhas + 4 cafes = 4), sempre a confirmar", () => {
    const p = previa({ fornecedor: "PADARIA", tipo_despesa_sugerido: "alimentacao", hora: "19:30:00",
        itens: [{ descricao: "Coxinha", quantidade: 4 }, { descricao: "Café", quantidade: 4 }, { descricao: "Pão", quantidade: 2 }, { descricao: "Taxa de serviço", quantidade: 10 }] });
    assert.equal(p.campos.pessoas.valor, 4);
    assert.equal(p.campos.pessoas.origem, "itens_da_nota");
    assert.ok(p.pendencias.some((x) => x.includes("estimadas pelos itens")));
});

test("pessoas informadas na mensagem valem mais que a estimativa da nota", () => {
    const p = previa({ fornecedor: "PIZZARIA", tipo_despesa_sugerido: "alimentacao", hora: "21:00:00", itens: [{ descricao: "Pizza", quantidade: 1 }] },
        { pessoas: { quantidade: 3 } });
    assert.equal(p.campos.pessoas.valor, 3);
    assert.equal(p.campos.pessoas.confirmado, true);
});

test("placa ilegivel parecida com um unico veiculo da frota vira sugestao, nao decisao", () => {
    const p = previa({ fornecedor: "POSTO", itens: [{ descricao: "GASOLINA" }], litragem: 30, odometro: 154260, placa: null, placa_bruta: "JKMOISE" });
    assert.equal(p.campos.abastecimento.placa.valor, null);
    assert.equal(p.campos.abastecimento.placa.sugestao.valor, "JKM0I96");
    assert.equal(p.campos.categoria.nome, null);
    assert.equal(p.campos.categoria.sugestao.nome, "ETIOS - JKM0I96");
    assert.equal(p.estado, "AGUARDANDO_REVISAO");
    assert.equal(cadastros.veiculoAproximado(cad(), "XYZ1234"), null);
});

test("hodometro sem rotulo vira pendencia para confirmar", () => {
    const p = previa({ fornecedor: "POSTO", itens: [{ descricao: "GASOLINA" }], litragem: 16.4, placa: "JKM-0I96", odometro: 166759, odometro_origem: "numero_ao_lado_da_placa" });
    assert.equal(p.campos.abastecimento.odometro.valor, 166759);
    assert.ok(p.pendencias.some((x) => x.includes("sem rótulo")));
});

// --- Treino: campos que nao valem ---------------------------------------------

test("centro de custo e pagamento marcados 'nao usar' saem das metricas e do exemplo", () => {
    const db = banco.abrir(":memory:");
    const c = { ...cad(), pessoas: [{ id: "almir", nome: "Almir", telefone: "5511900000001", pasta_drive: "Almir" }],
        projetos: [{ nome_oficial: "TESTE CC", ativo: true, id_conta_azul: "cc" }] };
    const { despesas: [id] } = orquestrador.processarFoto(db, c, {
        arquivo: "a.jpg", sha256: "h", hoje: new Date("2026-10-02T12:00:00Z"),
        brutoAzure: { analyzeResult: { content: "PIZZARIA\nTOTAL 90,00", documents: [{ docType: "receipt.retailMeal", fields: {
            MerchantName: { valueString: "PIZZARIA" }, Total: { type: "currency", valueCurrency: { amount: 90 } }, TransactionDate: { type: "date", valueDate: "2026-09-30" },
            TransactionTime: { type: "time", valueTime: "21:00:00" } } }] } },
        meta: { id_mensagem: "m", id_grupo: "g", remetente: "5511900000001@s.whatsapp.net", legenda: "Jantar 2 pessoas\nTESTE CC", recebido_em_ms: Date.parse("2026-10-01T08:00:00Z") },
    });
    // (Dinheiro: PIX agora pede a "Conta do PIX" para aprovar — ver central-revisao.test.js.)
    revisao.corrigir(db, c, id, [{ campo: "pagamento", valor: "DINHEIRO" }], "Yan");
    revisao.aprovar(db, id, "Yan", { naoUsarNoTreino: ["centro_custo", "pagamento", "valor"] });
    const rotulos = JSON.parse(db.prepare("SELECT rotulos FROM exemplos_treino").get().rotulos);
    assert.deepEqual(rotulos._nao_usar_no_treino.sort(), ["centro_custo", "pagamento"], "so centro e pagamento podem ser excluidos");
    const m = revisao.metricas(db);
    assert.equal(m.por_campo.pagamento, undefined);
    assert.equal(m.por_campo.centro_custo, undefined);
    assert.ok(m.por_campo.valor);
});

// --- Cota do Azure (plano gratuito) -------------------------------------------

test("cota mensal do Azure: conta paginas, bloqueia no limite e zera no mes seguinte", () => {
    const os = require("os");
    const path = require("path");
    const fs = require("fs");
    const cota = require("../src/cota-azure");
    const arquivo = path.join(os.tmpdir(), `azure-uso-${process.pid}-${Date.now()}.json`);
    try {
        const outubro = new Date("2026-10-10T12:00:00Z");
        assert.equal(cota.situacao({ limite: 3, arquivo, agora: outubro }).disponivel, true);
        cota.registrar(1, { arquivo, agora: outubro, limite: 3 });
        cota.registrar(2, { arquivo, agora: outubro, limite: 3 });
        const cheia = cota.situacao({ limite: 3, arquivo, agora: outubro });
        assert.equal(cheia.paginas, 3);
        assert.equal(cheia.disponivel, false);
        assert.equal(cota.situacao({ limite: 0, arquivo, agora: outubro }).disponivel, true, "limite 0 = sem limite (plano pago)");
        const novembro = cota.situacao({ limite: 3, arquivo, agora: new Date("2026-11-01T08:00:00Z") });
        assert.equal(novembro.paginas, 0);
        assert.equal(novembro.disponivel, true);
    } finally { fs.rmSync(arquivo, { force: true }); }
});

test("mensagem do operador no formato com rotulo: 'Pessoas: 4', 'Projeto:', 'Cartão:'", () => {
    const { interpretar } = require("../src/central/interpretador");
    const c = { pessoas: [], projetos: [{ nome_oficial: "ROTA DO PEQUI", ativo: true, apelidos: ["Rota do Pequi"] }], centros: [], veiculos: [],
        cartoes: [{ codigo: "C6", rotulo: "CRÉDITO C6", forma_pagamento: "CARTAO_CREDITO", apelidos: ["c6"] }], categorias: [], fornecedores: { recorrentes: [] } };
    const r = interpretar(c, { texto: "Almoço\nPessoas: 4\nProjeto: Rota do Pequi\nCartão: C6", temMidia: true });
    assert.equal(r.dados.pessoas.quantidade, 4);
    assert.equal(r.dados.projeto_texto, "Rota do Pequi");
    assert.equal(r.dados.pagamento.cartao, "C6");
    assert.deepEqual(r.dados.linhas_nao_entendidas, []);
    assert.equal(interpretar(c, { texto: "Qtd de pessoas: 3", temMidia: true }).dados.pessoas.quantidade, 3);
});

// --- Licoes das notas do Lorran (revisao de 12/10/2026) -----------------------

test("valor da mensagem impresso na nota vence o subtotal lido pelo Azure", () => {
    const p = previa({ fornecedor: "SHAWARMA", tipo_despesa_sugerido: "alimentacao", hora: "20:00:00", valor: 75,
        texto_bruto: "Shawarma 68,00\nCoca 7,00\nSUBTOTAL 75,00\nTAXA 6,88\nTOTAL 81,88" }, { valor_declarado: 81.88 });
    assert.equal(p.campos.valor.valor, 81.88);
    assert.equal(p.campos.valor.origem, "nota_confirmada_pela_mensagem");
});

test("valor lido sem a virgula (5800) e corrigido pelo valor da mensagem (58)", () => {
    const p = previa({ fornecedor: "RESTAURANTE", tipo_despesa_sugerido: "alimentacao", hora: "12:30:00", valor: 5800, texto_bruto: "TOTAL\n5800" },
        { valor_declarado: 58 });
    assert.equal(p.campos.valor.valor, 58);
});

test("valor da mensagem que nao aparece na nota nao vence: fica o da nota, com pendencia", () => {
    const p = previa({ fornecedor: "RESTAURANTE", tipo_despesa_sugerido: "alimentacao", hora: "12:30:00", valor: 90, texto_bruto: "TOTAL 90,00" },
        { valor_declarado: 120 });
    assert.equal(p.campos.valor.valor, 90);
    assert.ok(p.pendencias.some((x) => x.includes("difere do valor da mensagem")));
});

test("litros com o separador perdido (61618) viram 61,618 quando o preco por litro confere", () => {
    const p = previa({ fornecedor: "POSTO", itens: [{ descricao: "DIESEL S10" }], litragem: 61618, valor: 449.81, placa: "JKM-0I96", odometro: 181954 });
    assert.equal(p.campos.abastecimento.litros.valor, 61.618);
    assert.match(p.campos.descricao.valor, /^61,618L od 181\.954 - /);
});

test("placa com 8 no lugar de B e reconhecida pela frota (SGR4854 = SGR4B54)", () => {
    const c = cad();
    c.veiculos.push({ nome: "FIAT SCUDO - SGR4B54", placa: "SGR4B54", categoria_nome_conta_azul: "FIAT SCUDO - SGR4B54" });
    const p = regras.montarPrevia({ ocr: { confianca: 0.99, data: "2026-10-12", valor: 283.28, fornecedor: "POSTO", itens: [{ descricao: "DIESEL" }],
        litragem: 38, odometro: 182100, placa: "SGR-4854" }, legenda: {}, identificacao: {}, cad: c, hoje: new Date("2026-10-13T12:00:00Z"), modelo: null });
    assert.equal(p.campos.abastecimento.placa.valor, "SGR4B54");
    assert.equal(p.campos.categoria.nome, "FIAT SCUDO - SGR4B54");
    assert.equal(cadastros.veiculoPorSosia(c, "XYZ4854"), null, "sem veiculo parecido na frota, nao inventa");
});

// Caso real #479 (13/11/2026): Azure leu "OVH-1505"; na frota e OVN1505 (Etios).
const abastecimentoComPlaca = (c, placa) => regras.montarPrevia({ ocr: { confianca: 0.99, data: "2026-11-11", valor: 200, fornecedor: "POSTO", itens: [{ descricao: "GASOLINA" }],
    litragem: 34.651, odometro: 120000, placa }, legenda: {}, identificacao: {}, cad: c, hoje: new Date("2026-11-13T12:00:00Z"), modelo: null });

test("placa lida com UM caractere errado (OVH1505) vira a da frota (OVN1505), com aviso", () => {
    const c = cad();
    c.veiculos.push({ nome: "ETIOS - OVN1505", placa: "OVN1505", categoria_nome_conta_azul: "ETIOS - OVN1505" },
        { nome: "HILUX - OVN5J98", placa: "OVN5J98", categoria_nome_conta_azul: "HILUX - OVN5J98" });
    const p = abastecimentoComPlaca(c, "OVH-1505");
    assert.equal(p.campos.abastecimento.placa.valor, "OVN1505");
    assert.equal(p.campos.categoria.nome, "ETIOS - OVN1505");
    assert.ok(p.avisos.some((a) => /OVH1505.*corrigida para OVN1505/.test(a)), p.avisos.join(" | "));
    assert.ok(!p.pendencias.some((x) => /não está na frota/.test(x)), p.pendencias.join(" | "));
});

test("placa no formato antigo casa com a mesma placa Mercosul da frota (OVN1505 = OVN1F05)", () => {
    const c = cad();
    c.veiculos.push({ nome: "ETIOS - OVN1F05", placa: "OVN1F05", categoria_nome_conta_azul: "ETIOS - OVN1F05" });
    assert.equal(cadastros.veiculoPorUmCaractere(c, "OVN1505")?.veiculo.placa, "OVN1F05");
    assert.equal(cadastros.veiculoPorUmCaractere(c, "OVN1505")?.diferencas, 0);
});

test("placa a 1 caractere de DUAS placas da frota: nao chuta, pede para escolher", () => {
    const c = cad();
    c.veiculos.push({ nome: "CARRO A", placa: "ABC1234", categoria_nome_conta_azul: "CARRO A" },
        { nome: "CARRO B", placa: "ABC1235", categoria_nome_conta_azul: "CARRO B" });
    assert.equal(cadastros.veiculoPorUmCaractere(c, "ABC1239"), null);
    const p = abastecimentoComPlaca(c, "ABC1239");
    assert.notEqual(p.campos.abastecimento.placa.valor, "ABC1234");
    assert.notEqual(p.campos.abastecimento.placa.valor, "ABC1235");
    assert.ok(p.pendencias.some((x) => /ABC1234 e ABC1235/.test(x)), p.pendencias.join(" | "));
});

test("placa 'JKN0696' do cupom (M lido como N + 6 no lugar do I) vira a JKM0I96 da frota (#500, 16/11/2026)", () => {
    const c = cad(); // a frota de teste ja tem a JKM0I96
    assert.equal(cadastros.veiculoPorUmCaractere(c, "JKN0696")?.veiculo.placa, "JKM0I96");
    const p = abastecimentoComPlaca(c, "JKN-0696");
    assert.equal(p.campos.abastecimento.placa.valor, "JKM0I96");
    assert.equal(p.campos.categoria.nome, "ETIOS - JKM0I96");
    assert.ok(!p.pendencias.some((x) => /não está na frota/.test(x)), p.pendencias.join(" | "));
});

test("placa da nota fora da frota e placa da frota escrita na mensagem: vale a da mensagem", () => {
    const c = cad(); // a frota de teste ja tem a JKM0I96
    const p = regras.montarPrevia({ ocr: { confianca: 0.99, data: "2026-11-11", valor: 200, fornecedor: "POSTO", itens: [{ descricao: "GASOLINA" }],
        litragem: 34.651, odometro: 120000, placa: "XYZ-9W88" }, legenda: { placa: "JKM0I96" }, identificacao: {}, cad: c, hoje: new Date("2026-11-13T12:00:00Z"), modelo: null });
    assert.equal(p.campos.abastecimento.placa.valor, "JKM0I96");
    assert.ok(p.avisos.some((a) => /XYZ9W88.*não está na frota.*JKM0I96.*mensagem/.test(a)), p.avisos.join(" | "));
    // Placa da nota que ESTA na frota continua valendo, mesmo com outra na mensagem.
    c.veiculos.push({ nome: "ETIOS - OVN1505", placa: "OVN1505", categoria_nome_conta_azul: "ETIOS - OVN1505" });
    const q = regras.montarPrevia({ ocr: { confianca: 0.99, data: "2026-11-11", valor: 200, fornecedor: "POSTO", itens: [{ descricao: "GASOLINA" }],
        litragem: 34.651, odometro: 120000, placa: "OVN-1505" }, legenda: { placa: "JKM0I96" }, identificacao: {}, cad: c, hoje: new Date("2026-11-13T12:00:00Z"), modelo: null });
    assert.equal(q.campos.abastecimento.placa.valor, "OVN1505");
});

test("placa com 2+ caracteres diferentes de tudo na frota continua 'fora da frota' (nao inventa)", () => {
    const c = cad();
    c.veiculos.push({ nome: "ETIOS - OVN1505", placa: "OVN1505", categoria_nome_conta_azul: "ETIOS - OVN1505" });
    assert.equal(cadastros.veiculoPorUmCaractere(c, "OXH1585"), null);
    assert.equal(abastecimentoComPlaca(c, "OXH-1585").campos.abastecimento.placa.valor, "OXH1585");
});

test("habito do operador: pessoas estimadas pelo costume vencem a contagem de itens; cartao vira sugestao", () => {
    const habitos = { pessoas: { refeicao: { valor: 1, amostras: 6 } }, cartao: { codigo: "INTER", amostras: 9 } };
    const c = { ...cad(), cartoes: [{ codigo: "INTER", rotulo: "CRÉDITO INTER", forma_pagamento: "CARTAO_CREDITO" }] };
    const p = regras.montarPrevia({ ocr: { confianca: 0.99, data: "2026-10-10", valor: 81.88, fornecedor: "SHAWARMA", tipo_despesa_sugerido: "alimentacao",
        hora: "20:00:00", itens: [{ descricao: "Shawarma mist", quantidade: 2 }, { descricao: "Coca-Cola", quantidade: 1 }] },
    legenda: { tipos: ["JANTAR"] }, identificacao: { pessoa: { id: "lorran", nome: "Lorran", pasta_drive: "Lorran" } }, cad: c,
    hoje: new Date("2026-10-13T12:00:00Z"), modelo: null, habitos });
    assert.equal(p.campos.pessoas.valor, 1);
    assert.equal(p.campos.pessoas.origem, "habito_do_operador");
    assert.equal(p.campos.descricao.valor, "JANTAR - 1 PESSOA");
    assert.equal(p.campos.pagamento.cartao, null, "o costume nao decide o cartao");
    assert.equal(p.campos.pagamento.sugestao.codigo, "INTER");
    assert.equal(p.estado, "AGUARDANDO_REVISAO");
});

test("habitos so contam com 5+ notas aprovadas e 80%+ iguais", () => {
    const { habitosDoOperador } = require("../src/central/habitos");
    const db = banco.abrir(":memory:");
    const inserir = (pessoas, cartao) => {
        const msg = db.prepare("INSERT INTO mensagens (grupo_id, mensagem_id, remetente_id, pessoa_id, enviada_em, registrada_em) VALUES ('g', ?, 'r', 'lorran', 'x', 'x')")
            .run(`m${Math.random()}`).lastInsertRowid;
        db.prepare("INSERT INTO despesas (mensagem_ref, estado, campos, pendencias, avisos, criado_em, atualizado_em) VALUES (?, 'APROVADO', ?, '[]', '[]', 'x', 'x')")
            .run(msg, JSON.stringify({ tipo: { valor: "JANTAR" }, pessoas: { valor: pessoas }, pagamento: { cartao } }));
    };
    for (let i = 0; i < 4; i += 1) inserir(1, "INTER");
    assert.equal(habitosDoOperador(db, "lorran").pessoas.refeicao, null, "4 notas ainda nao e habito");
    inserir(1, "INTER");
    assert.equal(habitosDoOperador(db, "lorran").pessoas.refeicao.valor, 1);
    assert.equal(habitosDoOperador(db, "lorran").cartao.codigo, "INTER");
    inserir(3, "C6"); inserir(2, "C6");
    assert.equal(habitosDoOperador(db, "lorran").pessoas.refeicao, null, "5 de 7 (71%) nao e habito firme");
});

test("assinatura do operador na mensagem nao vira linha nao entendida", () => {
    const { interpretar } = require("../src/central/interpretador");
    const r = interpretar(cad(), { texto: "Janta\nLorran\nValor R$ 81,88", temMidia: true, pessoa: { id: "lorran", nome: "Lorran" } });
    assert.deepEqual(r.dados.linhas_nao_entendidas, []);
    assert.equal(r.dados.valor_declarado, 81.88);
});

test("hospedagem sem pessoas informadas: diaria de ate R$ 350 estima 1 pessoa (a confirmar)", () => {
    const p = previa({ fornecedor: "HOTEL BOA NOITE", valor: 230, texto_bruto: "HOTEL BOA NOITE\nDIARIA 230,00" }, { tipos: ["HOSPEDAGEM"] });
    assert.equal(p.campos.pessoas.valor, 1);
    assert.equal(p.campos.pessoas.origem, "valor_da_diaria");
    assert.equal(p.campos.descricao.valor, "HOSPEDAGEM - 1 PESSOA");
    const cara = previa({ fornecedor: "HOTEL BOA NOITE", valor: 900, texto_bruto: "HOTEL BOA NOITE\nDIARIAS 900,00" }, { tipos: ["HOSPEDAGEM"] });
    assert.equal(cara.campos.pessoas.valor, null, "diaria alta nao vira 1 pessoa");
});
