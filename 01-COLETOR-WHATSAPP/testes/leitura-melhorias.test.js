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
    revisao.corrigir(db, c, id, [{ campo: "pagamento", valor: "PIX" }], "Yan");
    revisao.aprovar(db, id, "Yan", { naoUsarNoTreino: ["centro_custo", "pagamento", "valor"] });
    const rotulos = JSON.parse(db.prepare("SELECT rotulos FROM exemplos_treino").get().rotulos);
    assert.deepEqual(rotulos._nao_usar_no_treino.sort(), ["centro_custo", "pagamento"], "so centro e pagamento podem ser excluidos");
    const m = revisao.metricas(db);
    assert.equal(m.por_campo.pagamento, undefined);
    assert.equal(m.por_campo.centro_custo, undefined);
    assert.ok(m.por_campo.valor);
});
