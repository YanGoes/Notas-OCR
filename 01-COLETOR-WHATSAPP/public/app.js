const $ = (id) => document.getElementById(id);
let grupos = [];
let centrosCusto = [];
let assinaturaDocumentos = "";
let carregandoGrupos = false;
let gruposCarregadosAutomaticamente = false;
let estadoContaAzul = null;
let filaContaAzul = { itens: [], lote_liberado: false, processando: [] };
let carregandoContaAzul = false;
let notaPilotoSelecionada = "";

async function api(url, opts = {}) {
  const resposta = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const dados = await resposta.json();
  if (!resposta.ok) throw new Error(dados.erro || "Falha na operacao");
  return dados;
}

function aviso(mensagem, erro = false) {
  const el = $("aviso"); el.textContent = mensagem; el.classList.remove("oculto");
  el.style.background = erro ? "#f9e4e4" : "#e2f6eb"; el.style.color = erro ? "#8c2d2d" : "#176b49";
  setTimeout(() => el.classList.add("oculto"), 5000);
}

function empresaContaAzulId() { return estadoContaAzul?.empresa?.id || ""; }

function eventoContaAzulId(item) {
  return String(item?.conta_azul?.evento_id || "").trim();
}

function rotuloContaAzul(status) {
  return ({
    NAO_ENVIADO: "Não enviado",
    PREPARACAO_AGENDADA: "Preparação agendada",
    PREPARANDO: "Enviando para a prévia",
    PREVIA_CONFERIDA: "Prévia conferida",
    PREVIA_DIVERGENTE: "Prévia divergente",
    PREPARACAO_INCERTA: "Preparação incerta",
    ERRO_PREPARACAO: "Erro ao preparar",
    CONFIRMANDO: "Criando despesa",
    CONFIRMACAO_AGENDADA: "Criação agendada",
    CONFIRMADO: "Criado no Conta Azul",
    PILOTO_VALIDADO_NO_ERP: "Conferido no Conta Azul",
    CONFIRMACAO_INCERTA: "Confirmação incerta",
    REJEITADO: "Rejeitado no Conta Azul",
    DIRETO_AGENDADO: "Direto assistido agendado",
    DIRETO_ENVIANDO: "Direto assistido em envio",
    DIRETO_AGUARDANDO_CONFIRMACAO: "Direto aguardando validação",
    DIRETO_INCERTO: "Direto com resultado incerto",
    DIRETO_CONFIRMADO_PENDENCIAS: "Direto confirmado; completar no ERP",
  })[status] || status || "Não enviado";
}

function classeContaAzul(status) {
  if (["CONFIRMADO", "PILOTO_VALIDADO_NO_ERP"].includes(status)) return "ca-ok";
  if (["PREVIA_DIVERGENTE", "PREPARACAO_INCERTA", "CONFIRMACAO_INCERTA", "DIRETO_INCERTO", "DIRETO_CONFIRMADO_PENDENCIAS"].includes(status)) return "ca-warning";
  if (["ERRO_PREPARACAO", "REJEITADO"].includes(status)) return "ca-error";
  if (["PREPARACAO_AGENDADA", "PREPARANDO", "CONFIRMACAO_AGENDADA", "CONFIRMANDO", "DIRETO_AGENDADO", "DIRETO_ENVIANDO", "DIRETO_AGUARDANDO_CONFIRMACAO"].includes(status)) return "ca-working";
  return "ca-ready";
}

function estadoTexto(status) {
  return ({ parado: "Parado", conectando: "Conectando...", aguardando_qr: "Aguardando QR Code", conectado: "Conectado", reconectando: "Reconectando...", desconectando: "Desconectando...", desconectado: "Desconectado", erro: "Erro" })[status] || status;
}

async function atualizar() {
  try {
    const dados = await api("/api/status"); const w = dados.whatsapp; const conectado = w.status === "conectado";
    $("statusTopo").textContent = estadoTexto(w.status); $("statusTopo").className = `pill ${conectado ? "ok" : w.status === "erro" ? "erro" : "neutro"}`;
    $("whatsStatus").textContent = estadoTexto(w.status); $("whatsStatus").className = `dot-label ${conectado ? "online" : ""}`;
    $("whatsTexto").textContent = conectado ? "Sessao ativa. As novas fotos dos grupos selecionados serao processadas." : w.erro || "Conecte a conta ou escaneie o QR Code quando solicitado.";
    $("qrArea").classList.toggle("oculto", !w.qr_imagem); if (w.qr_imagem) $("qrImagem").src = w.qr_imagem;
    $("conectar").disabled = ["conectado", "conectando", "aguardando_qr", "reconectando"].includes(w.status); $("desconectar").disabled = !conectado;
    $("azureStatus").textContent = dados.azure.configurado ? "Azure configurado" : "Azure nao configurado"; $("azureStatus").className = `pill ${dados.azure.configurado ? "ok" : "erro"}`;
    $("grupoTotal").textContent = dados.grupos.grupos_permitidos.length;
    for (const [nome, valor] of Object.entries(dados.filas)) $("f" + nome[0].toUpperCase() + nome.slice(1)).textContent = valor;
    if (conectado && !gruposCarregadosAutomaticamente && !carregandoGrupos) {
      gruposCarregadosAutomaticamente = true;
      carregarGrupos(false);
    }
    if (!conectado) gruposCarregadosAutomaticamente = false;
  } catch (erro) { aviso(erro.message, true); }
}

function moeda(valor) {
  const numero = Number(valor);
  return !Number.isFinite(numero) || numero <= 0 ? "Não identificado" : numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarCnpj(valor) {
  const digitos = String(valor || "").replace(/\D/g, "");
  return digitos.length === 14 ? digitos.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : String(valor || "");
}

function formatarDataDocumento(valor) {
  const texto = String(valor || "").trim();
  const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return /^\d{2}\/\d{2}\/\d{4}$/.test(texto) ? texto : "Não identificada";
}

function aplicarTema(tema) {
  document.documentElement.dataset.theme = tema;
  localStorage.setItem("vmac-tema", tema);
  const escuro = tema === "dark";
  $("temaTexto").textContent = escuro ? "Modo claro" : "Modo escuro";
  $("temaIcon").textContent = escuro ? "☀" : "◐";
  $("temaToggle").setAttribute("aria-label", escuro ? "Ativar modo claro" : "Ativar modo escuro");
}

function rotuloStatus(status) {
  return ({ entrada: "Processando", simulacao: "Simulação aprovada", revisao: "Revisão humana", bloqueados: "Bloqueado", erros: "Erro", enviados: "Enviado ao Conta Azul" })[status] || status;
}

function blocoContaAzul(doc) {
  const envio = doc.envio_conta_azul;
  if (!envio || doc.status === "entrada") return "";
  const conta = envio.conta_azul || doc.conta_azul || { status: "NAO_ENVIADO" };
  const status = conta.status || "NAO_ENVIADO";
  const previa = conta.previa || {};
  const direto = conta.direto || {};
  const empresaConfirmada = Boolean(estadoContaAzul?.empresa_confirmada);
  const acaoPeloCartaoLiberada = Boolean(filaContaAzul.lote_liberado);
  const resumoPrevia = previa.valor ? `<div class="ca-preview"><span>Prévia Conta Azul</span><b>${moeda(previa.valor)}</b><span>${escapar(formatarDataDocumento(previa.data_competencia))}</span><span>${escapar(previa.fornecedor?.nome || "Fornecedor não vinculado")}</span><span>${escapar(previa.categoria?.nome || "Categoria ausente")}</span><span>${escapar(previa.centro_custo?.nome || "Centro ausente")}</span></div>` : "";
  const divergencias = Array.isArray(conta.divergencias) && conta.divergencias.length
    ? `<ul class="ca-divergencias">${conta.divergencias.map((item) => `<li>${escapar(item)}</li>`).join("")}</ul>` : "";
  const resumoDireto = conta.modo_lancamento === "DIRETO_ASSISTIDO"
    ? `<div class="ca-direct-summary"><strong>Caminho direto assistido</strong><span>Protocolo: ${escapar(direto.protocolo || "não recebido")}</span><span>A imagem continua na Conta AI Captura e não virou anexo deste lançamento.</span>${Array.isArray(direto.pendencias) ? `<ul>${direto.pendencias.map((item) => `<li>${escapar(item)}</li>`).join("")}</ul>` : ""}</div>`
    : "";
  const desabilitado = empresaConfirmada ? "" : "disabled title=\"Confirme primeiro a empresa do Conta Azul\"";
  let acao = "";
  if (acaoPeloCartaoLiberada && ["NAO_ENVIADO", "ERRO_PREPARACAO"].includes(status) && envio.pronto) {
    acao = `<button class="secondary ca-preparar" data-base="${escapar(doc.base)}" ${desabilitado}>Preparar no Conta Azul</button>`;
  } else if (acaoPeloCartaoLiberada && status === "PREVIA_CONFERIDA") {
    acao = `<button class="primary ca-confirmar" data-base="${escapar(doc.base)}" data-token="${escapar(conta.token_confirmacao || "")}" ${desabilitado}>Criar despesa</button>`;
  } else if (acaoPeloCartaoLiberada && ["PREVIA_DIVERGENTE", "PREPARACAO_INCERTA", "CONFIRMACAO_INCERTA"].includes(status)) {
    acao = `<button class="ghost ca-verificar" data-base="${escapar(doc.base)}" ${desabilitado}>Verificar status</button>`;
  }
  const complemento = ["CONFIRMADO", "PILOTO_VALIDADO_NO_ERP"].includes(status)
    ? (String(conta.evento_id || "").trim()
      ? `<span class="ca-evento">Evento: <b>${escapar(conta.evento_id)}</b></span>`
      : '<span class="ca-erro-texto">A criação foi indicada, mas o ID do lançamento ainda não foi localizado. Verifique novamente; o lote permanece bloqueado.</span>')
    : conta.erro ? `<span class="ca-erro-texto">${escapar(conta.erro)}</span>`
      : (!envio.pronto && status === "NAO_ENVIADO" ? `<span class="ca-aguarda">Aguardando aprovação completa para liberar o envio.</span>` : "");
  const orientacaoConfirmacaoIncerta = status === "CONFIRMACAO_INCERTA"
    ? '<span class="ca-aguarda">Se você já salvou a despesa manualmente no Conta Azul, não envie a foto nem crie a despesa outra vez. Use “Verificar status” para localizar o evento existente.</span>'
    : "";
  const orientacaoPiloto = !acaoPeloCartaoLiberada && status !== "PILOTO_VALIDADO_NO_ERP"
    ? '<span class="ca-aguarda">Para o primeiro teste, use somente o quadro guiado acima.</span>' : "";
  return `<div class="ca-documento ${classeContaAzul(status)}"><div class="ca-documento-topo"><div><small>Conta Azul</small><strong>${escapar(rotuloContaAzul(status))}</strong></div>${acao}</div>${resumoPrevia}${divergencias}${resumoDireto}${complemento}${orientacaoConfirmacaoIncerta}${orientacaoPiloto}</div>`;
}

function ativarAcoesContaAzul(lista) {
  lista.querySelectorAll(".ca-preparar").forEach((botao) => { botao.onclick = () => prepararDocumentoContaAzul(botao.dataset.base); });
  lista.querySelectorAll(".ca-confirmar").forEach((botao) => { botao.onclick = () => confirmarDocumentoContaAzul(botao.dataset.base, botao.dataset.token); });
  lista.querySelectorAll(".ca-verificar").forEach((botao) => { botao.onclick = () => verificarDocumentoContaAzul(botao.dataset.base); });
}

async function atualizarDocumentos() {
  try {
    const data = $("filtroData").value;
    const documentos = await api(`/api/documentos${data ? `?data=${encodeURIComponent(data)}` : ""}`);
    const assinatura = JSON.stringify(documentos);
    if (assinatura === assinaturaDocumentos) return;
    assinaturaDocumentos = assinatura;
    const lista = $("documentosLista");
    if (!documentos.length) { lista.innerHTML = '<div class="empty">Aguardando o primeiro comprovante do WhatsApp.</div>'; return; }
    lista.innerHTML = documentos.map((doc) => {
      const motivos = Array.isArray(doc.validacoes?.motivos) ? doc.validacoes.motivos : [];
      const imagem = doc.imagem_url ? `<a href="${doc.imagem_url}" target="_blank" title="Abrir imagem"><img src="${doc.imagem_url}" alt="Comprovante ${escapar(doc.arquivo || "")}"></a>` : '<div class="empty">Imagem indisponível</div>';
      const confianca = Number.isFinite(Number(doc.ocr?.confianca)) ? `${(Number(doc.ocr.confianca) * 100).toFixed(1)}%` : "Aguardando";
      const ia = doc.aprendizado;
      const pct = (item) => item ? `${(Number(item.confianca || 0) * 100).toFixed(1)}%` : "-";
      const familiasPorTipo = { alimentacao: "ALIMENTACAO", combustivel: "COMBUSTIVEL", hospedagem: "HOSPEDAGEM", farmacia: "FARMACIA", manutencao: "OFICINA_MANUTENCAO", material: "MATERIAL_CAMPO" };
      const familiaPrincipal = familiasPorTipo[doc.classificacao?.tipo];
      const conflitoIa = Boolean(ia?.familia?.rotulo && familiaPrincipal && ia.familia.rotulo !== familiaPrincipal);
      let sugestao = "";
      if (ia && conflitoIa) {
        sugestao = `<div class="sugestao-ia conflito"><div><strong>Previsão histórica descartada</strong><small>A classificação principal tem prioridade.</small></div><span>O conteúdo atual indica <b>${escapar(doc.classificacao.tipo)}</b>; a previsão histórica conflitante não será utilizada.</span></div>`;
      } else if (ia?.familia) {
        sugestao = `<div class="sugestao-ia"><div><strong>Aprendizado histórico</strong><small>Apoio para identificar a família da despesa; não substitui as regras fiscais.</small></div><span>Família provável: <b>${escapar(ia.familia.rotulo)}</b> (${pct(ia.familia)})</span><span>Categoria: <b>definida pelas regras e pelo Conta Azul</b></span><span>Centro: <b>definido pelo grupo ou pela legenda</b></span></div>`;
      }
      const item = doc.ocr?.itens?.[0];
      const local = [doc.ocr?.endereco?.cidade, doc.ocr?.endereco?.estado].filter(Boolean).join("/");
      const detalhes = [
        doc.ocr?.nome_fantasia ? `<span>Nome fantasia: <b>${escapar(doc.ocr.nome_fantasia)}</b></span>` : "",
        doc.ocr?.cnpj ? `<span>CNPJ: <b>${escapar(formatarCnpj(doc.ocr.cnpj))}</b></span>` : "",
        local ? `<span>Local: <b>${escapar(local)}</b></span>` : "",
        item?.descricao ? `<span>Produto: <b>${escapar(item.descricao)}</b></span>` : "",
        doc.ocr?.litragem ? `<span>Litragem: <b>${escapar(String(doc.ocr.litragem))} L</b></span>` : item?.quantidade ? `<span>Quantidade: <b>${escapar(String(item.quantidade))} ${escapar(item.unidade || "")}</b></span>` : "",
        item?.valor_unitario ? `<span>Valor unitário: <b>${moeda(item.valor_unitario)}</b></span>` : "",
        doc.ocr?.placa ? `<span>Placa: <b>${escapar(doc.ocr.placa)}</b></span>` : "",
        doc.ocr?.quilometragem ? `<span>Km: <b>${escapar(String(doc.ocr.quilometragem))}</b></span>` : "",
        doc.classificacao?.tipo ? `<span>Tipo reconhecido: <b>${escapar(doc.classificacao.tipo)}</b></span>` : "",
        doc.classificacao?.centro_custo_nome ? `<span>Centro de custo: <b>${escapar(doc.classificacao.centro_custo_nome)}</b>${doc.classificacao.centro_custo_origem === "grupo_whatsapp" ? " (padrao do grupo)" : ""}</span>` : "",
      ].filter(Boolean).join("");
      return `<article class="documento"><div class="documento-imagem">${imagem}</div><div class="documento-conteudo"><div class="documento-topo"><strong>${escapar(doc.arquivo || "Comprovante")}</strong><span class="status-doc status-${escapar(doc.status)}">${escapar(rotuloStatus(doc.status))}</span></div><div class="legenda-doc">${escapar(doc.legenda || "Sem legenda informada")}</div><div class="dados-ocr"><span>Fornecedor: <b>${escapar(doc.ocr?.fornecedor || "Não identificado")}</b></span><span>Valor: <b>${moeda(doc.ocr?.valor)}</b></span><span>Data: <b>${escapar(formatarDataDocumento(doc.ocr?.data))}</b></span><span>Confiança: <b>${confianca}</b></span>${detalhes}</div>${sugestao}${motivos.length ? `<ul class="motivos">${motivos.map((m) => `<li>${escapar(m)}</li>`).join("")}</ul>` : ""}${blocoContaAzul(doc)}</div></article>`;
    }).join("");
    ativarAcoesContaAzul(lista);
  } catch (erro) { console.error(erro); }
}

function escapar(texto) { const div = document.createElement("div"); div.textContent = texto; return div.innerHTML; }

function normalizarBusca(texto) {
  return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function renderizarGrupos() {
  const termo = normalizarBusca($("buscarGrupo").value);
  const encontrados = grupos.map((grupo, indice) => ({ grupo, indice })).filter(({ grupo }) =>
    normalizarBusca(grupo.nome).includes(termo) || normalizarBusca(grupo.id).includes(termo));
  const lista = $("listaGrupos");
  if (!encontrados.length) {
    lista.innerHTML = '<div class="empty">Nenhum grupo corresponde à pesquisa.</div>';
    return;
  }
  const opcoesCentro = (selecionado) => [
    `<option value="">Sem centro padrao</option>`,
    ...centrosCusto.map((centro) => `<option value="${escapar(centro.id)}" ${String(selecionado || "") === String(centro.id) ? "selected" : ""}>${escapar(centro.nome)}</option>`),
  ].join("");
  lista.innerHTML = `<div class="search-result-count">${encontrados.length} de ${grupos.length} grupo(s)</div>` + encontrados.map(({ grupo, indice }) =>
    `<div class="group"><label class="group-main"><input type="checkbox" data-i="${indice}" ${grupo.selecionado ? "checked" : ""}><div><span>${escapar(grupo.nome)}</span><small>${escapar(grupo.id)}</small></div></label><label class="group-center"><span>Centro de custo padrao</span><select data-centro-i="${indice}" ${grupo.selecionado ? "" : "disabled"}>${opcoesCentro(grupo.centro_custo_id)}</select></label></div>`).join("");
  lista.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const indice = Number(checkbox.dataset.i);
      grupos[indice].selecionado = checkbox.checked;
      const seletor = lista.querySelector(`select[data-centro-i="${indice}"]`);
      if (seletor) seletor.disabled = !checkbox.checked;
    });
  });
  lista.querySelectorAll("select[data-centro-i]").forEach((select) => {
    select.addEventListener("change", () => { grupos[Number(select.dataset.centroI)].centro_custo_id = select.value; });
  });
}

async function carregarGrupos(mostrarMensagem = true) {
  if (carregandoGrupos) return;
  carregandoGrupos = true;
  try {
    [grupos, centrosCusto] = await Promise.all([api("/api/grupos"), api("/api/centros-custo")]);
    $("buscarGrupo").value = "";
    $("buscaArea").classList.remove("oculto");
    renderizarGrupos();
    $("salvarGrupos").classList.remove("oculto");
    if (mostrarMensagem) aviso("Lista atualizada. Os grupos anteriormente salvos continuam selecionados.");
  } catch (erro) { gruposCarregadosAutomaticamente = false; if (mostrarMensagem) aviso(erro.message, true); }
  finally { carregandoGrupos = false; }
}

function renderizarCentrosContaAzul() {
  const lista = $("centrosLista");
  const centros = estadoContaAzul?.centros_custo || [];
  if (!centros.length) { lista.innerHTML = '<span class="muted">Nenhum centro de custo ativo encontrado.</span>'; return; }
  lista.innerHTML = centros.map((centro) => `<span><b>${escapar(centro.nome)}</b>${centro.codigo ? ` <small>${escapar(centro.codigo)}</small>` : ""}</span>`).join("");
}

function renderizarModoOperacao() {
  const empresaOk = Boolean(estadoContaAzul?.empresa_confirmada);
  if (!empresaOk) {
    $("modoTitulo").textContent = "SIMULAÇÃO";
    $("modoDetalhe").textContent = "Nenhum lançamento financeiro";
    $("modoDescricao").textContent = "Conecte o WhatsApp, escolha os grupos e acompanhe cada documento sem lançar despesas durante a simulação.";
    return;
  }
  if (filaContaAzul.lote_liberado) {
    $("modoTitulo").textContent = "ENVIO CONTROLADO";
    $("modoDetalhe").textContent = "Lote liberado após teste conferido";
    $("modoDescricao").textContent = "O envio ao Conta Azul continua manual e exige confirmação antes de preparar e antes de criar despesas.";
    return;
  }
  $("modoTitulo").textContent = "ENVIO MANUAL";
  $("modoDetalhe").textContent = "Primeiro teste exige 3 confirmações";
  $("modoDescricao").textContent = "Escolha uma nota piloto, gere a prévia, crie uma única despesa e confira o resultado no Conta Azul.";
}

function renderizarDetalhesNotaPiloto(item) {
  const area = $("testePilotoDetalhes");
  if (!item) { area.innerHTML = ""; return; }
  const conta = item.conta_azul || {};
  const previa = conta.previa || null;
  const cnpjLocal = formatarCnpj(item.cnpj || "") || "Não identificado";
  const confianca = Number.isFinite(Number(item.confianca)) ? `${(Number(item.confianca) * 100).toFixed(1)}%` : "-";
  const detalhesCombustivel = [item.placa ? `Placa: ${escapar(item.placa)}` : "", Number(item.litragem) > 0 ? `Litros: ${escapar(String(item.litragem).replace(".", ","))}` : ""].filter(Boolean).join(" · ");
  let comparacao = "";
  if (previa) {
    const parcelas = Array.isArray(previa.parcelas) ? previa.parcelas : [];
    const totalParcelas = parcelas.reduce((total, parcela) => total + Number(parcela.valor_bruto || 0), 0);
    const semDivergencia = ["PREVIA_CONFERIDA", "CONFIRMANDO", "CONFIRMADO", "PILOTO_VALIDADO_NO_ERP"].includes(conta.status) && Array.isArray(conta.divergencias) && conta.divergencias.length === 0;
    const listaDivergencias = Array.isArray(conta.divergencias) && conta.divergencias.length
      ? `<ul class="ca-divergencias">${conta.divergencias.map((texto) => `<li>${escapar(texto)}</li>`).join("")}</ul>` : "";
    comparacao = `<div class="pilot-compare"><div><strong>Leitura aprovada pelo programa</strong><span>${escapar(item.fornecedor || "Fornecedor não identificado")} · ${escapar(cnpjLocal)}</span><span>${escapar(moeda(item.valor))} · ${escapar(formatarDataDocumento(item.data))}</span><span>${escapar(item.categoria || "Categoria ausente")} · ${escapar(item.centro_custo || "Centro ausente")}</span></div><div><strong>Prévia devolvida pelo Conta Azul</strong><span>${escapar(previa.fornecedor?.nome || "Fornecedor não vinculado")} · ${escapar(formatarCnpj(previa.fornecedor?.documento || "") || "CNPJ ausente")}</span><span>${escapar(moeda(previa.valor))} · ${escapar(formatarDataDocumento(previa.data_competencia))}</span><span>${escapar(previa.categoria?.nome || "Categoria ausente")} · ${escapar(previa.centro_custo?.nome || "Centro ausente")}</span><span>${parcelas.length} parcela(s) · soma ${escapar(moeda(totalParcelas))}</span>${semDivergencia ? '<span class="pilot-match">✓ Conferência obrigatória aprovada pelo servidor</span>' : ""}${listaDivergencias}</div></div>`;
  }
  area.innerHTML = `<a class="pilot-thumb" href="/api/documentos/${encodeURIComponent(item.base)}/imagem" target="_blank" title="Abrir comprovante"><img src="/api/documentos/${encodeURIComponent(item.base)}/imagem" alt="Comprovante selecionado"></a><div class="pilot-data"><div class="pilot-data-line"><span>Empresa: <b>${escapar(estadoContaAzul?.empresa?.nome_fantasia || estadoContaAzul?.empresa?.razao_social || "-")}</b> (${escapar(empresaContaAzulId())})</span><span>Fornecedor: <b>${escapar(item.fornecedor || "-")}</b></span><span>CNPJ: <b>${escapar(cnpjLocal)}</b></span><span>Valor: <b>${escapar(moeda(item.valor))}</b></span><span>Data: <b>${escapar(formatarDataDocumento(item.data))}</b></span><span>Confiança: <b>${escapar(confianca)}</b></span><span>Categoria: <b>${escapar(item.categoria || "-")}</b></span><span>Centro: <b>${escapar(item.centro_custo || "-")}</b></span>${detalhesCombustivel ? `<span><b>${detalhesCombustivel}</b></span>` : ""}</div>${comparacao}</div>`;
}

function renderizarTestePiloto() {
  const select = $("notaPiloto");
  const botao = $("acaoNotaPiloto");
  const titulo = $("testePilotoTitulo");
  const estado = $("testePilotoEstado");
  const empresaOk = Boolean(estadoContaAzul?.empresa_confirmada);
  const statusVisiveis = new Set([
    "NAO_ENVIADO", "ERRO_PREPARACAO", "PREPARACAO_AGENDADA", "PREPARANDO", "PREVIA_CONFERIDA", "PREVIA_DIVERGENTE",
    "PREPARACAO_INCERTA", "CONFIRMACAO_AGENDADA", "CONFIRMANDO", "CONFIRMACAO_INCERTA", "CONFIRMADO", "PILOTO_VALIDADO_NO_ERP", "REJEITADO",
  ]);
  const candidatos = (filaContaAzul.itens || []).filter((item) => {
    const status = item.conta_azul?.status || "NAO_ENVIADO";
    if (status === "CONFIRMADO" && item.conta_azul?.validado_no_erp_em && filaContaAzul.lote_liberado) return false;
    return statusVisiveis.has(status) && (item.pronto || status !== "NAO_ENVIADO");
  }).sort((a, b) => String(b.base || "").localeCompare(String(a.base || "")));

  const anterior = notaPilotoSelecionada || select.value;
  select.innerHTML = "";
  if (!candidatos.length) {
    const opcao = document.createElement("option");
    opcao.textContent = "Nenhuma nota aprovada disponível";
    opcao.value = "";
    select.appendChild(opcao);
    select.disabled = true;
    botao.disabled = true;
    botao.textContent = "Aguardando uma nota pronta";
    botao.dataset.action = "";
    titulo.textContent = "Ainda não há nota liberada para o teste";
    estado.textContent = "A nota precisa estar em Simulação aprovada, com valor, data, categoria e centro de custo válidos.";
    renderizarDetalhesNotaPiloto(null);
    return;
  }

  for (const item of candidatos) {
    const opcao = document.createElement("option");
    opcao.value = item.base;
    opcao.textContent = `${item.fornecedor || "Fornecedor não identificado"} — ${moeda(item.valor)} — ${formatarDataDocumento(item.data)} — ref. ${String(item.base || "").slice(0, 19)} — ${rotuloContaAzul(item.conta_azul?.status || "NAO_ENVIADO")}`;
    select.appendChild(opcao);
  }
  const mantido = candidatos.find((item) => item.base === anterior);
  const estadosAtivos = new Set(["PREPARACAO_AGENDADA", "PREPARANDO", "PREPARACAO_INCERTA", "PREVIA_CONFERIDA", "PREVIA_DIVERGENTE", "CONFIRMACAO_AGENDADA", "CONFIRMANDO", "CONFIRMACAO_INCERTA", "CONFIRMADO"]);
  const emAndamento = candidatos.find((item) => estadosAtivos.has(item.conta_azul?.status || "NAO_ENVIADO") && (!item.conta_azul?.empresa_id || String(item.conta_azul.empresa_id) === String(empresaContaAzulId())));
  const escolhido = emAndamento || mantido || candidatos[0];
  select.value = escolhido.base;
  notaPilotoSelecionada = escolhido.base;
  select.disabled = Boolean(emAndamento && !filaContaAzul.lote_liberado);
  renderizarDetalhesNotaPiloto(escolhido);

  const status = escolhido.conta_azul?.status || "NAO_ENVIADO";
  botao.dataset.base = escolhido.base;
  botao.dataset.token = escolhido.conta_azul?.token_confirmacao || "";
  botao.dataset.action = "";
  botao.className = "primary";
  botao.disabled = true;
  titulo.textContent = filaContaAzul.lote_liberado ? "Teste individual concluído; envio em lote liberado" : "Primeiro teste real: três confirmações seguras";

  if (!empresaOk) {
    botao.textContent = "Confirme primeiro a empresa";
    estado.textContent = "Nenhum arquivo será enviado enquanto a empresa conectada não estiver confirmada.";
  } else if (["NAO_ENVIADO", "ERRO_PREPARACAO"].includes(status) && escolhido.pronto) {
    botao.textContent = "1. Preparar prévia (não cria despesa)";
    botao.dataset.action = "preparar";
    botao.disabled = false;
    estado.textContent = "Clique para enviar somente esta imagem à Conta AI Captura. Ainda não será criada uma conta a pagar.";
  } else if (["PREPARACAO_AGENDADA", "PREPARANDO"].includes(status)) {
    botao.textContent = "Aguardando a prévia do Conta Azul...";
    estado.textContent = "O programa está lendo a prévia e comparando valor, data, fornecedor, categoria e centro de custo.";
  } else if (status === "PREVIA_CONFERIDA") {
    botao.textContent = "2. Criar esta despesa real";
    botao.dataset.action = "confirmar";
    botao.disabled = !escolhido.conta_azul?.token_confirmacao;
    estado.textContent = "A prévia coincidiu com os dados validados. Este segundo clique cria o lançamento em Financeiro → Contas a pagar.";
  } else if (["CONFIRMACAO_AGENDADA", "CONFIRMANDO"].includes(status)) {
    botao.textContent = "Criação em andamento — não clique novamente";
    estado.textContent = "A confirmação já foi enviada. Aguarde o painel consultar o resultado para evitar duplicidade.";
  } else if (status === "CONFIRMADO") {
    const eventoId = eventoContaAzulId(escolhido);
    if (!eventoId) {
      botao.textContent = "Verificar novamente no Conta Azul";
      botao.dataset.action = "verificar";
      botao.className = "secondary";
      botao.disabled = false;
      estado.textContent = "A criação foi indicada, mas o programa ainda não localizou o ID do lançamento. Verifique novamente; sem esse ID o lote não pode ser liberado.";
    } else if (escolhido.conta_azul?.validado_no_erp_em) {
      botao.textContent = "Despesa criada e conferida";
      estado.textContent = "Teste finalizado. O lançamento foi criado e você registrou a conferência no ERP.";
    } else {
      botao.textContent = "3. Conferi no Conta Azul — liberar lote";
      botao.dataset.action = "validar-erp";
      botao.disabled = false;
      estado.textContent = "Abra Financeiro → Contas a pagar, confira os dados e o anexo; depois registre a conferência neste botão.";
    }
  } else if (status === "PILOTO_VALIDADO_NO_ERP") {
    if (eventoContaAzulId(escolhido)) {
      botao.textContent = "Despesa criada e conferida";
      estado.textContent = "Teste finalizado e validado no ERP. Os botões de lote estão liberados para esta mesma empresa.";
    } else {
      botao.textContent = "Verificar novamente no Conta Azul";
      botao.dataset.action = "verificar";
      botao.className = "secondary";
      botao.disabled = false;
      estado.textContent = "O teste não pode liberar o lote porque o ID do lançamento não foi localizado. Verifique novamente no Conta Azul.";
    }
  } else if (status === "CONFIRMACAO_INCERTA") {
    botao.textContent = "Verificar novamente no Conta Azul";
    botao.dataset.action = "verificar";
    botao.className = "secondary";
    botao.disabled = false;
    estado.textContent = "Se você já salvou esta despesa manualmente, não clique em Salvar outra vez e não envie outra foto. Clique aqui para o programa procurar o lançamento existente; o lote só será liberado depois que o ID do evento for localizado.";
  } else if (["PREVIA_DIVERGENTE", "PREPARACAO_INCERTA", "REJEITADO"].includes(status)) {
    botao.textContent = "Verificar novamente no Conta Azul";
    botao.dataset.action = "verificar";
    botao.className = "secondary";
    botao.disabled = false;
    estado.textContent = status === "PREVIA_DIVERGENTE"
      ? "Nada foi criado: a prévia divergiu. Veja os detalhes no cartão da nota e revise-a na Conta AI Captura."
      : "O resultado não é seguro para repetir o envio. Verifique o estado já existente antes de qualquer nova tentativa.";
  } else {
    botao.textContent = "Ação indisponível — revise o estado";
    estado.textContent = (escolhido.impedimentos || []).join(" ") || "Atualize a conexão e confira os dados desta nota antes de continuar.";
  }
}

function renderizarFilaContaAzul() {
  const itens = filaContaAzul.itens || [];
  const statusPreparaveis = new Set(["NAO_ENVIADO", "ERRO_PREPARACAO"]);
  const prontos = itens.filter((item) => item.pronto && statusPreparaveis.has(item.conta_azul?.status || "NAO_ENVIADO"));
  const conferidos = itens.filter((item) => item.conta_azul?.status === "PREVIA_CONFERIDA");
  const divergentes = itens.filter((item) => item.conta_azul?.status === "PREVIA_DIVERGENTE");
  const confirmados = itens.filter((item) => ["CONFIRMADO", "PILOTO_VALIDADO_NO_ERP"].includes(item.conta_azul?.status));
  const soma = prontos.reduce((total, item) => total + Number(item.valor || 0), 0);
  $("contaFilaResumo").innerHTML = `<span><b>${prontos.length}</b> pronto(s) · ${moeda(soma)}</span><span><b>${conferidos.length}</b> prévia(s) conferida(s)</span><span><b>${divergentes.length}</b> divergente(s)</span><span><b>${confirmados.length}</b> enviado(s)</span>`;
  const empresaOk = Boolean(estadoContaAzul?.empresa_confirmada);
  $("prepararTodos").disabled = !(empresaOk && filaContaAzul.lote_liberado && prontos.length);
  $("confirmarTodos").disabled = !(empresaOk && filaContaAzul.lote_liberado && conferidos.length);
  $("loteAjuda").textContent = filaContaAzul.lote_liberado
    ? "Lote liberado. Ainda existem duas confirmações: enviar as imagens para prévia e criar somente as prévias sem divergência."
    : "O lote só aparece depois que a primeira despesa for criada, conferida no ERP e registrada no botão “Conferi no Conta Azul”.";
  $("painelLote").classList.toggle("oculto", !filaContaAzul.lote_liberado);
  renderizarTestePiloto();
  renderizarModoOperacao();
}

function renderizarContaAzul() {
  const conectado = Boolean(estadoContaAzul?.conectada);
  const confirmado = Boolean(estadoContaAzul?.empresa_confirmada);
  $("contaEmpresaNome").textContent = conectado ? (estadoContaAzul.empresa.nome_fantasia || estadoContaAzul.empresa.razao_social || "Sem nome") : "Conta não conectada";
  $("contaEmpresaId").textContent = conectado ? `ID da empresa: ${estadoContaAzul.empresa.id}` : "Execute CONECTAR_CONTA_AZUL.bat";
  $("contaAzulStatus").textContent = confirmado ? "Empresa confirmada" : conectado ? "Confirmação necessária" : "Não conectado";
  $("contaAzulStatus").className = `pill ${confirmado ? "ok" : "erro"}`;
  $("confirmarEmpresa").disabled = !conectado || confirmado;
  $("confirmarEmpresa").textContent = confirmado ? "Empresa confirmada" : "Confirmar empresa correta";
  $("contaEmpresaAviso").classList.toggle("oculto", confirmado);
  $("criarCentro").disabled = !confirmado;
  $("sincronizarCentros").disabled = !confirmado;
  renderizarCentrosContaAzul();
  renderizarFilaContaAzul();
}

async function atualizarFilaContaAzul() {
  try { filaContaAzul = await api("/api/conta-azul/fila"); renderizarFilaContaAzul(); }
  catch (erro) { console.error(erro); }
}

async function carregarContaAzul(mostrarMensagem = false) {
  if (carregandoContaAzul) return;
  carregandoContaAzul = true;
  try {
    [estadoContaAzul, filaContaAzul] = await Promise.all([api("/api/conta-azul/status"), api("/api/conta-azul/fila")]);
    renderizarContaAzul();
    assinaturaDocumentos = "";
    await atualizarDocumentos();
    if (mostrarMensagem) aviso("Conexão e cadastros do Conta Azul atualizados.");
  } catch (erro) {
    estadoContaAzul = { conectada: false, empresa_confirmada: false, centros_custo: [] };
    renderizarContaAzul();
    if (mostrarMensagem) aviso(erro.message, true);
  } finally { carregandoContaAzul = false; }
}

async function confirmarEmpresaContaAzul() {
  const empresa = estadoContaAzul?.empresa;
  if (!empresa) return;
  const texto = `Confirme com atenção:\n\nEmpresa: ${empresa.nome_fantasia || empresa.razao_social}\nID: ${empresa.id}\n\nTodos os centros e lançamentos serão criados nesta empresa. É a conta correta?`;
  if (!confirm(texto)) return;
  try {
    await api("/api/conta-azul/empresa/confirmar", { method: "POST", body: JSON.stringify({ id_empresa: empresa.id, confirmacao: true }) });
    aviso("Empresa do Conta Azul confirmada neste computador.");
    await carregarContaAzul(false);
  } catch (erro) { aviso(erro.message, true); }
}

async function sincronizarCentrosContaAzul() {
  if (!confirm("Sincronizar os centros de custo ativos da empresa confirmada com o programa?")) return;
  try {
    const resposta = await api("/api/centros-custo/sincronizar", { method: "POST", body: JSON.stringify({ id_empresa: empresaContaAzulId(), confirmacao: true }) });
    centrosCusto = resposta.centros;
    renderizarGrupos();
    await carregarContaAzul(false);
    aviso(`${resposta.centros.length} centro(s) de custo sincronizado(s).`);
  } catch (erro) { aviso(erro.message, true); }
}

async function criarCentroContaAzul() {
  const nome = $("novoCentroNome").value.trim();
  const codigo = $("novoCentroCodigo").value.trim();
  if (!nome) { aviso("Informe o nome do novo projeto.", true); return; }
  const empresa = estadoContaAzul?.empresa;
  if (!confirm(`Criar o centro de custo “${nome}”${codigo ? ` (${codigo})` : ""} em ${empresa?.nome_fantasia || empresa?.razao_social}?\n\nA API não permite excluí-lo depois.`)) return;
  try {
    const resposta = await api("/api/centros-custo", { method: "POST", body: JSON.stringify({ nome, codigo, id_empresa: empresaContaAzulId(), confirmacao: true }) });
    $("novoCentroNome").value = ""; $("novoCentroCodigo").value = "";
    centrosCusto = resposta.centros;
    renderizarGrupos();
    await carregarContaAzul(false);
    aviso(`Centro de custo “${resposta.criado.nome}” criado e disponível nos grupos.`);
  } catch (erro) { aviso(erro.message, true); }
}

async function prepararDocumentoContaAzul(base) {
  const item = filaContaAzul.itens.find((atual) => atual.base === base);
  if (!item) { aviso("Documento não encontrado na fila.", true); return; }
  if (!confirm(`Enviar esta imagem para a Conta AI Captura?\n\n${item.fornecedor || "Fornecedor não identificado"}\n${moeda(item.valor)} · ${formatarDataDocumento(item.data)}\n${item.centro_custo || "Centro não definido"}\n\nEsta etapa ainda NÃO cria a despesa.`)) return;
  try {
    await api(`/api/conta-azul/despesas/${encodeURIComponent(base)}/preparar`, { method: "POST", body: JSON.stringify({ id_empresa: empresaContaAzulId(), confirmacao: "ENVIAR_PREVIA" }) });
    aviso("Preparação agendada. Aguarde a prévia aparecer; não clique novamente.");
    assinaturaDocumentos = ""; await atualizarFilaContaAzul(); await atualizarDocumentos();
  } catch (erro) { aviso(erro.message, true); }
}

async function confirmarDocumentoContaAzul(base, token) {
  const item = filaContaAzul.itens.find((atual) => atual.base === base);
  if (!item) { aviso("Documento não encontrado na fila.", true); return; }
  if (!confirm(`CRIAR UMA DESPESA REAL NO CONTA AZUL?\n\n${item.fornecedor || "Fornecedor não identificado"}\n${moeda(item.valor)} · ${formatarDataDocumento(item.data)}\nCategoria: ${item.categoria || "-"}\nCentro: ${item.centro_custo || "-"}\nEmpresa: ${estadoContaAzul?.empresa?.nome_fantasia || "-"}\n\nDepois da confirmação, o lançamento aparecerá em Financeiro → Contas a pagar.`)) return;
  try {
    await api(`/api/conta-azul/despesas/${encodeURIComponent(base)}/confirmar`, { method: "POST", body: JSON.stringify({ id_empresa: empresaContaAzulId(), token, confirmacao: "CRIAR_DESPESA" }) });
    aviso("Criação agendada. Não clique novamente; o painel atualizará o status.");
    assinaturaDocumentos = ""; await atualizarFilaContaAzul(); await atualizarDocumentos();
  } catch (erro) { aviso(erro.message, true); }
}

async function verificarDocumentoContaAzul(base) {
  try {
    await api(`/api/conta-azul/despesas/${encodeURIComponent(base)}/verificar`, { method: "POST", body: JSON.stringify({ id_empresa: empresaContaAzulId() }) });
    aviso("Status consultado diretamente no Conta Azul.");
    assinaturaDocumentos = ""; await atualizarFilaContaAzul(); await atualizarDocumentos();
  } catch (erro) { aviso(erro.message, true); }
}

async function validarPilotoNoErp(base) {
  const item = filaContaAzul.itens.find((atual) => atual.base === base);
  if (!item || item.conta_azul?.status !== "CONFIRMADO") { aviso("A despesa ainda não foi confirmada pelo Conta Azul.", true); return; }
  const eventoId = eventoContaAzulId(item);
  if (!eventoId) { aviso("O ID do lançamento ainda não foi localizado. Clique em Verificar novamente no Conta Azul; o lote continua bloqueado.", true); return; }
  const pergunta = `CONFIRMAÇÃO FINAL DO TESTE\n\nVocê abriu o Conta Azul e conferiu este lançamento em Financeiro → Contas a pagar?\n\nFornecedor: ${item.fornecedor || "-"}\nCNPJ: ${formatarCnpj(item.cnpj || "") || "-"}\nValor: ${moeda(item.valor)}\nData: ${formatarDataDocumento(item.data)}\nCategoria: ${item.categoria || "-"}\nCentro: ${item.centro_custo || "-"}\nEvento: ${eventoId}\nEmpresa: ${estadoContaAzul?.empresa?.nome_fantasia || "-"} (${empresaContaAzulId()})\n\nConfirme somente se os dados e a imagem anexada estiverem corretos. Esta ação libera os botões de lote.`;
  if (!confirm(pergunta)) return;
  if (prompt("Para registrar a conferência, digite exatamente CONFERIDO:", "") !== "CONFERIDO") { aviso("Conferência cancelada; o lote continua bloqueado.", true); return; }
  try {
    await api(`/api/conta-azul/despesas/${encodeURIComponent(base)}/validar-no-erp`, { method: "POST", body: JSON.stringify({ id_empresa: empresaContaAzulId(), evento_id: eventoId, confirmado_por: "Operador local", confirmacao: "CONFIRMEI_NO_ERP" }) });
    aviso("Teste real conferido. O envio em lote foi liberado para esta empresa.");
    assinaturaDocumentos = ""; await carregarContaAzul(false);
  } catch (erro) { aviso(erro.message, true); }
}

async function executarAcaoNotaPiloto() {
  const botao = $("acaoNotaPiloto");
  const base = botao.dataset.base;
  if (!base || botao.disabled) return;
  if (botao.dataset.action === "preparar") return prepararDocumentoContaAzul(base);
  if (botao.dataset.action === "confirmar") return confirmarDocumentoContaAzul(base, botao.dataset.token);
  if (botao.dataset.action === "verificar") return verificarDocumentoContaAzul(base);
  if (botao.dataset.action === "validar-erp") return validarPilotoNoErp(base);
}

async function prepararTodosContaAzul() {
  const bases = filaContaAzul.itens.filter((item) => item.pronto && ["NAO_ENVIADO", "ERRO_PREPARACAO"].includes(item.conta_azul?.status || "NAO_ENVIADO")).map((item) => item.base);
  const valor = filaContaAzul.itens.filter((item) => bases.includes(item.base)).reduce((total, item) => total + Number(item.valor || 0), 0);
  if (!bases.length || !confirm(`Enviar ${bases.length} imagem(ns), totalizando ${moeda(valor)}, para gerar prévias no Conta Azul?\n\nNenhuma despesa será criada nesta primeira etapa.`)) return;
  try {
    await api("/api/conta-azul/despesas/preparar-lote", { method: "POST", body: JSON.stringify({ bases, id_empresa: empresaContaAzulId(), confirmacao: "ENVIAR_PREVIAS" }) });
    aviso(`${bases.length} documento(s) agendado(s) para preparação sequencial.`);
  } catch (erro) { aviso(erro.message, true); }
}

async function confirmarTodosContaAzul() {
  const itens = filaContaAzul.itens.filter((item) => item.conta_azul?.status === "PREVIA_CONFERIDA");
  const bases = itens.map((item) => item.base);
  const valor = itens.reduce((total, item) => total + Number(item.valor || 0), 0);
  if (!bases.length || !confirm(`ATENÇÃO: criar ${bases.length} DESPESA(S) REAIS, totalizando ${moeda(valor)}, em ${estadoContaAzul?.empresa?.nome_fantasia || "Conta Azul"}?\n\nSomente prévias sem divergência serão incluídas.`)) return;
  try {
    await api("/api/conta-azul/despesas/confirmar-lote", { method: "POST", body: JSON.stringify({ bases, id_empresa: empresaContaAzulId(), confirmacao: "CRIAR_DESPESAS" }) });
    aviso(`${bases.length} despesa(s) agendada(s) para criação sequencial. Não repita o clique.`);
  } catch (erro) { aviso(erro.message, true); }
}

$("conectar").onclick = async () => { try { await api("/api/whatsapp/conectar", { method: "POST" }); aviso("Conexao iniciada."); } catch (erro) { aviso(erro.message, true); } atualizar(); };
$("desconectar").onclick = async () => {
  if (!confirm("Sair do WhatsApp neste computador? Um novo QR Code sera necessario.")) return;
  try { await api("/api/whatsapp/desconectar", { method: "POST" }); grupos = []; $("buscaArea").classList.add("oculto"); $("listaGrupos").innerHTML = '<div class="empty">WhatsApp desconectado.</div>'; aviso("Sessao removida deste computador."); } catch (erro) { aviso(erro.message, true); } atualizar();
};
$("carregarGrupos").onclick = () => carregarGrupos(true);
$("buscarGrupo").addEventListener("input", renderizarGrupos);
$("limparBusca").onclick = () => { $("buscarGrupo").value = ""; renderizarGrupos(); $("buscarGrupo").focus(); };
$("salvarGrupos").onclick = async () => {
  const selecionados = grupos.filter((grupo) => grupo.selecionado);
  try { await api("/api/grupos", { method: "PUT", body: JSON.stringify({ grupos: selecionados }) }); aviso(`${selecionados.length} grupo(s) salvo(s). As notas existentes serão recalculadas.`); atualizar(); } catch (erro) { aviso(erro.message, true); }
};
$("atualizarContaAzul").onclick = () => carregarContaAzul(true);
$("confirmarEmpresa").onclick = confirmarEmpresaContaAzul;
$("sincronizarCentros").onclick = sincronizarCentrosContaAzul;
$("criarCentro").onclick = criarCentroContaAzul;
$("prepararTodos").onclick = prepararTodosContaAzul;
$("confirmarTodos").onclick = confirmarTodosContaAzul;
$("notaPiloto").addEventListener("change", () => { notaPilotoSelecionada = $("notaPiloto").value; renderizarTestePiloto(); });
$("acaoNotaPiloto").onclick = executarAcaoNotaPiloto;
$("filtroData").addEventListener("change", () => { assinaturaDocumentos = ""; atualizarDocumentos(); });
$("filtrarHoje").onclick = () => {
  const agora = new Date(); const p = (n) => String(n).padStart(2, "0");
  $("filtroData").value = `${agora.getFullYear()}-${p(agora.getMonth() + 1)}-${p(agora.getDate())}`;
  assinaturaDocumentos = ""; atualizarDocumentos();
};
$("mostrarTodos").onclick = () => { $("filtroData").value = ""; assinaturaDocumentos = ""; atualizarDocumentos(); };
$("temaToggle").onclick = () => aplicarTema(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
aplicarTema(document.documentElement.dataset.theme || "light");
atualizar(); atualizarDocumentos(); carregarContaAzul(false);
setInterval(() => { atualizar(); atualizarFilaContaAzul(); atualizarDocumentos(); }, 2500);
