const $ = (id) => document.getElementById(id);
let grupos = [];
let assinaturaDocumentos = "";
let carregandoGrupos = false;
let gruposCarregadosAutomaticamente = false;

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
  return valor === null || valor === undefined ? "Não identificado" : Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function rotuloStatus(status) {
  return ({ entrada: "Processando", simulacao: "Simulação aprovada", revisao: "Revisão humana", bloqueados: "Bloqueado", erros: "Erro" })[status] || status;
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
      const sugestao = ia ? `<div class="sugestao-ia"><div><strong>Aprendizado histórico</strong><small>Sugestão auxiliar — não lança nem substitui a validação.</small></div><span>Família: <b>${escapar(ia.familia?.rotulo || "Não identificada")}</b> (${pct(ia.familia)})</span><span>Categoria: <b>${escapar(ia.categoria?.rotulo || "Não identificada")}</b> (${pct(ia.categoria)})</span><span>Centro: <b>${escapar(ia.centro?.rotulo || "Não identificado")}</b> (${pct(ia.centro)})</span></div>` : "";
      const item = doc.ocr?.itens?.[0];
      const local = [doc.ocr?.endereco?.cidade, doc.ocr?.endereco?.estado].filter(Boolean).join("/");
      const detalhes = [
        doc.ocr?.nome_fantasia ? `<span>Nome fantasia: <b>${escapar(doc.ocr.nome_fantasia)}</b></span>` : "",
        local ? `<span>Local: <b>${escapar(local)}</b></span>` : "",
        item?.descricao ? `<span>Produto: <b>${escapar(item.descricao)}</b></span>` : "",
        doc.ocr?.litragem ? `<span>Litragem: <b>${escapar(String(doc.ocr.litragem))} L</b></span>` : item?.quantidade ? `<span>Quantidade: <b>${escapar(String(item.quantidade))} ${escapar(item.unidade || "")}</b></span>` : "",
        item?.valor_unitario ? `<span>Valor unitário: <b>${moeda(item.valor_unitario)}</b></span>` : "",
        doc.ocr?.placa ? `<span>Placa: <b>${escapar(doc.ocr.placa)}</b></span>` : "",
        doc.ocr?.quilometragem ? `<span>Km: <b>${escapar(String(doc.ocr.quilometragem))}</b></span>` : "",
        doc.classificacao?.tipo ? `<span>Tipo reconhecido: <b>${escapar(doc.classificacao.tipo)}</b></span>` : "",
      ].filter(Boolean).join("");
      return `<article class="documento"><div class="documento-imagem">${imagem}</div><div class="documento-conteudo"><div class="documento-topo"><strong>${escapar(doc.arquivo || "Comprovante")}</strong><span class="status-doc status-${escapar(doc.status)}">${escapar(rotuloStatus(doc.status))}</span></div><div class="legenda-doc">${escapar(doc.legenda || "Sem legenda informada")}</div><div class="dados-ocr"><span>Fornecedor: <b>${escapar(doc.ocr?.fornecedor || "Não identificado")}</b></span><span>Valor: <b>${moeda(doc.ocr?.valor)}</b></span><span>Data: <b>${escapar(doc.ocr?.data || "Não identificada")}</b></span><span>Confiança: <b>${confianca}</b></span>${detalhes}</div>${sugestao}${motivos.length ? `<ul class="motivos">${motivos.map((m) => `<li>${escapar(m)}</li>`).join("")}</ul>` : ""}</div></article>`;
    }).join("");
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
  lista.innerHTML = `<div class="search-result-count">${encontrados.length} de ${grupos.length} grupo(s)</div>` + encontrados.map(({ grupo, indice }) =>
    `<label class="group"><input type="checkbox" data-i="${indice}" ${grupo.selecionado ? "checked" : ""}><div><span>${escapar(grupo.nome)}</span><small>${escapar(grupo.id)}</small></div></label>`).join("");
  lista.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => { grupos[Number(checkbox.dataset.i)].selecionado = checkbox.checked; });
  });
}

async function carregarGrupos(mostrarMensagem = true) {
  if (carregandoGrupos) return;
  carregandoGrupos = true;
  try {
    grupos = await api("/api/grupos");
    $("buscarGrupo").value = "";
    $("buscaArea").classList.remove("oculto");
    renderizarGrupos();
    $("salvarGrupos").classList.remove("oculto");
    if (mostrarMensagem) aviso("Lista atualizada. Os grupos anteriormente salvos continuam selecionados.");
  } catch (erro) { gruposCarregadosAutomaticamente = false; if (mostrarMensagem) aviso(erro.message, true); }
  finally { carregandoGrupos = false; }
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
  try { await api("/api/grupos", { method: "PUT", body: JSON.stringify({ grupos: selecionados }) }); aviso(`${selecionados.length} grupo(s) salvo(s).`); atualizar(); } catch (erro) { aviso(erro.message, true); }
};
$("filtroData").addEventListener("change", () => { assinaturaDocumentos = ""; atualizarDocumentos(); });
$("filtrarHoje").onclick = () => {
  const agora = new Date(); const p = (n) => String(n).padStart(2, "0");
  $("filtroData").value = `${agora.getFullYear()}-${p(agora.getMonth() + 1)}-${p(agora.getDate())}`;
  assinaturaDocumentos = ""; atualizarDocumentos();
};
$("mostrarTodos").onclick = () => { $("filtroData").value = ""; assinaturaDocumentos = ""; atualizarDocumentos(); };
atualizar(); atualizarDocumentos();
setInterval(() => { atualizar(); atualizarDocumentos(); }, 2500);
