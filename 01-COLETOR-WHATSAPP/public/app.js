const $ = (id) => document.getElementById(id);
let grupos = [];
let contatos = [];
let centrosCusto = [];
let carregandoGrupos = false;
let gruposCarregadosAutomaticamente = false;
let estadoContaAzul = null;
let carregandoContaAzul = false;
let assinaturaNotificacoes = "";

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
    $("grupoTotal").textContent = dados.grupos.grupos_permitidos.length + (dados.grupos.contatos_permitidos || []).length;
    for (const [nome, valor] of Object.entries(dados.filas)) $("f" + nome[0].toUpperCase() + nome.slice(1)).textContent = valor;
    if (conectado && !gruposCarregadosAutomaticamente && !carregandoGrupos) {
      gruposCarregadosAutomaticamente = true;
      carregarGrupos(false);
    }
    if (!conectado) gruposCarregadosAutomaticamente = false;
  } catch (erro) { aviso(erro.message, true); }
}

function aplicarTema(tema) {
  document.documentElement.dataset.theme = tema;
  localStorage.setItem("vmac-tema", tema);
  const escuro = tema === "dark";
  $("temaTexto").textContent = escuro ? "Modo claro" : "Modo escuro";
  $("temaIcon").textContent = escuro ? "☀" : "◐";
  $("temaToggle").setAttribute("aria-label", escuro ? "Ativar modo claro" : "Ativar modo escuro");
}

function escapar(texto) { const div = document.createElement("div"); div.textContent = texto; return div.innerHTML; }

function normalizarBusca(texto) {
  return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function renderizarGrupos() {
  const termo = normalizarBusca($("buscarGrupo").value);
  const encontrados = grupos.map((grupo, indice) => ({ grupo, indice })).filter(({ grupo }) =>
    normalizarBusca(grupo.nome).includes(termo) || normalizarBusca(grupo.id).includes(termo));
  // Contatos (conversa no privado) na mesma lista, depois dos grupos.
  const contatosAchados = contatos.map((pessoa, indice) => ({ pessoa, indice })).filter(({ pessoa }) =>
    normalizarBusca(pessoa.nome).includes(termo) || String(pessoa.telefone_final || "").includes(termo));
  const lista = $("listaGrupos");
  if (!encontrados.length && !contatosAchados.length) {
    lista.innerHTML = '<div class="empty">Nenhum grupo ou contato corresponde à pesquisa.</div>';
    return;
  }
  const opcoesCentro = (selecionado) => [
    `<option value="">Sem centro padrao</option>`,
    ...centrosCusto.map((centro) => `<option value="${escapar(centro.id)}" ${String(selecionado || "") === String(centro.id) ? "selected" : ""}>${escapar(centro.nome)}</option>`),
  ].join("");
  const semGrupos = grupos.length ? "" : '<div class="empty">Conecte o WhatsApp e clique em "Atualizar lista" para ver os grupos.</div>';
  lista.innerHTML = `<div class="search-result-count">${encontrados.length} grupo(s) · ${contatosAchados.length} contato(s)</div>` + semGrupos + encontrados.map(({ grupo, indice }) =>
    `<div class="group"><label class="group-main"><input type="checkbox" data-i="${indice}" ${grupo.selecionado ? "checked" : ""}><div><span>${escapar(grupo.nome)}</span><small>Grupo · ${escapar(grupo.id)}</small></div></label><label class="group-center"><span>Centro de custo padrao</span><select data-centro-i="${indice}" ${grupo.selecionado ? "" : "disabled"}>${opcoesCentro(grupo.centro_custo_id)}</select></label></div>`).join("")
    + contatosAchados.map(({ pessoa, indice }) =>
    `<div class="group"><label class="group-main"><input type="checkbox" data-contato="${indice}" ${pessoa.permitido ? "checked" : ""} ${pessoa.telefone_final ? "" : "disabled"}><div><span>${escapar(pessoa.nome)}</span><small>Contato (privado) · ${pessoa.telefone_final ? `telefone final …${escapar(pessoa.telefone_final)}` : "sem telefone no cadastro"}${pessoa.papel ? ` · ${escapar(pessoa.papel)}` : ""}</small></div></label>${pessoa.permitido ? `<button type="button" class="secondary" data-historico="${escapar(pessoa.id)}" title="Pede ao celular as mensagens anteriores desta conversa">Buscar mensagens anteriores</button>` : ""}</div>`).join("");
  lista.querySelectorAll("button[data-historico]").forEach((botao) => {
    botao.addEventListener("click", async () => {
      try { const resposta = await api(`/api/contatos/${encodeURIComponent(botao.dataset.historico)}/historico`, { method: "POST" }); aviso(resposta.mensagem); } catch (erro) { aviso(erro.message, true); }
    });
  });
  lista.querySelectorAll("input[data-contato]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => { contatos[Number(checkbox.dataset.contato)].permitido = checkbox.checked; });
  });
  lista.querySelectorAll("input[data-i]").forEach((checkbox) => {
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

async function carregarContatos() {
  try {
    contatos = await api("/api/contatos");
    $("buscaArea").classList.remove("oculto");
    $("salvarGrupos").classList.remove("oculto");
    renderizarGrupos();
  } catch (erro) { aviso(erro.message, true); }
}

$("cadastrarPessoa").onclick = async () => {
  try {
    const resposta = await api("/api/contatos/pessoa", { method: "POST", body: JSON.stringify({ nome: $("novaPessoaNome").value, telefone: $("novaPessoaTelefone").value }) });
    $("novaPessoaNome").value = ""; $("novaPessoaTelefone").value = "";
    contatos = resposta.contatos; renderizarGrupos();
    aviso(`${resposta.pessoa.nome} cadastrado(a) e marcado(a) na lista (conversa no privado).`);
  } catch (erro) { aviso(erro.message, true); }
};
carregarContatos();

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
  $("modoTitulo").textContent = "ENVIO PELA CENTRAL";
  $("modoDetalhe").textContent = "Lançamento só depois da revisão";
  $("modoDescricao").textContent = "As fotos dos grupos marcados caem na Central de revisão; de lá, as notas aprovadas vão para o Conta Azul.";
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
  renderizarModoOperacao();
}

async function carregarContaAzul(mostrarMensagem = false) {
  if (carregandoContaAzul) return;
  carregandoContaAzul = true;
  try {
    estadoContaAzul = await api("/api/conta-azul/status");
    renderizarContaAzul();
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

function iconeNivel(nivel) {
  if (nivel === "sucesso") return "✅";
  if (nivel === "erro") return "❌";
  return "⚠️";
}

async function atualizarNotificacoes() {
  try {
    const dados = await api("/api/notificacoes");
    const itens = Array.isArray(dados.itens) ? dados.itens : [];
    const assinatura = JSON.stringify(itens.map((item) => [item.id, item.lida]));
    if (assinatura === assinaturaNotificacoes) return;
    assinaturaNotificacoes = assinatura;

    const card = $("cardNotificacoes");
    const lista = $("notificacoesLista");
    const contador = $("notificacoesContador");
    if (!card || !lista) return;

    if (!itens.length) { card.classList.add("oculto"); return; }
    card.classList.remove("oculto");
    if (contador) contador.textContent = String(dados.nao_lidas || 0);

    lista.innerHTML = itens.slice(0, 20).map((item) => {
      const quando = new Date(item.criada_em).toLocaleString("pt-BR");
      const pendencias = (item.pendencias || []).length
        ? `<ul class="notificacao-pendencias">${item.pendencias.map((p) => `<li>${escapar(p)}</li>`).join("")}</ul>`
        : "";
      return `<article class="notificacao nivel-${escapar(item.nivel || "atencao")} ${item.lida ? "lida" : ""}">
        <div class="notificacao-topo">
          <strong>${iconeNivel(item.nivel)} ${escapar(item.titulo)}</strong>
          <span class="notificacao-data">${escapar(quando)}</span>
        </div>
        <pre class="notificacao-texto">${escapar(item.texto)}</pre>
        ${pendencias}
      </article>`;
    }).join("");
  } catch (erro) { console.error(erro); }
}

async function marcarNotificacoesLidas() {
  try {
    await api("/api/notificacoes/lidas", { method: "POST", body: JSON.stringify({}) });
    assinaturaNotificacoes = "";
    atualizarNotificacoes();
  } catch (erro) { aviso(erro.message, true); }
}

$("conectar").onclick = async () => { try { await api("/api/whatsapp/conectar", { method: "POST" }); aviso("Conexao iniciada."); } catch (erro) { aviso(erro.message, true); } atualizar(); };
$("desconectar").onclick = async () => {
  if (!confirm("Sair do WhatsApp neste computador? Um novo QR Code sera necessario.")) return;
  try { await api("/api/whatsapp/desconectar", { method: "POST" }); grupos = []; $("buscaArea").classList.add("oculto"); $("listaGrupos").innerHTML = '<div class="empty">WhatsApp desconectado.</div>'; aviso("Sessao removida deste computador."); } catch (erro) { aviso(erro.message, true); } atualizar();
};
if ($("conectarCodigo")) $("conectarCodigo").onclick = async () => {
  const numero = ($("numeroPareamento").value || "").replace(/\D/g, "");
  if (numero.length < 12 || numero.length > 13) {
    return aviso("Informe o número com DDI e DDD, só números. Exemplo: 5531999998888.", true);
  }
  const botao = $("conectarCodigo");
  botao.disabled = true;
  try {
    aviso("Gerando código de pareamento...");
    const res = await api("/api/whatsapp/codigo", { method: "POST", body: JSON.stringify({ numero }) });
    const area = $("codigoPareamento");
    area.classList.remove("oculto");
    area.innerHTML = `<strong>${escapar(res.codigo)}</strong><span>No celular: <b>WhatsApp → Aparelhos conectados → Conectar aparelho → Conectar com número de telefone</b> e digite este código. Ele vale por poucos minutos.</span>`;
    aviso("Código gerado. Digite no celular agora.");
  } catch (erro) { aviso(erro.message, true); }
  finally { botao.disabled = false; }
};
$("carregarGrupos").onclick = () => carregarGrupos(true);
$("buscarGrupo").addEventListener("input", renderizarGrupos);
$("limparBusca").onclick = () => { $("buscarGrupo").value = ""; renderizarGrupos(); $("buscarGrupo").focus(); };
$("salvarGrupos").onclick = async () => {
  const selecionados = grupos.filter((grupo) => grupo.selecionado);
  const pessoas = contatos.filter((pessoa) => pessoa.permitido).map((pessoa) => pessoa.id);
  try {
    // Sem a lista de grupos carregada (WhatsApp desconectado), salva so os contatos.
    if (grupos.length) await api("/api/grupos", { method: "PUT", body: JSON.stringify({ grupos: selecionados }) });
    contatos = (await api("/api/contatos", { method: "PUT", body: JSON.stringify({ ids: pessoas }) })).contatos;
    aviso(`${grupos.length ? `${selecionados.length} grupo(s) e ` : ""}${pessoas.length} contato(s) salvo(s).`);
    renderizarGrupos(); atualizar();
  } catch (erro) { aviso(erro.message, true); }
};
async function carregarPerfil() {
  try {
    const s = await api("/api/conta-azul/perfil");
    const of = s.perfil === "oficial";
    $("perfilNome").textContent = of ? "CONTA OFICIAL DA VMAC" : "Conta de teste";
    $("perfilDetalhe").textContent = (of ? s.oficial : s.teste).conectada ? "Autorizada neste computador." : "Ainda não autorizada: rode o atalho 04_CONECTAR_CONTA_AZUL.";
    $("perfilNome").style.color = of ? "var(--danger)" : "";
    $("perfilTeste").disabled = !of;
    $("perfilOficial").disabled = of || !s.oficial.credenciais;
    $("perfilOficial").title = s.oficial.credenciais ? "" : "Preencha as chaves OFICIAL no .env";
    let faixa = document.getElementById("faixaOficial");
    if (of && !faixa) {
      faixa = document.createElement("div"); faixa.id = "faixaOficial";
      faixa.style.cssText = "position:sticky;top:0;z-index:50;background:#b3261e;color:#fff;text-align:center;padding:6px;font-weight:700";
      faixa.textContent = "CONTA OFICIAL ATIVA — o envio de lançamentos continua travado até você liberar";
      document.body.prepend(faixa);
    } else if (!of && faixa) faixa.remove();
  } catch (erro) { aviso(erro.message, true); }
}
async function trocarPerfil(perfil) {
  let confirmacao;
  if (perfil === "oficial") {
    confirmacao = prompt("Você vai usar a conta OFICIAL da VMac.\nNada é lançado por esta troca, mas as consultas passam a ser na empresa real.\n\nDigite OFICIAL para confirmar:");
    if (confirmacao === null) return;
  }
  try {
    await api("/api/conta-azul/perfil", { method: "POST", body: JSON.stringify({ perfil, confirmacao }) });
    aviso(perfil === "oficial" ? "Conta oficial selecionada." : "Conta de teste selecionada.");
    await carregarPerfil(); await carregarContaAzul(false);
  } catch (erro) { aviso(erro.message, true); }
}
$("perfilTeste").onclick = () => trocarPerfil("teste");
$("perfilOficial").onclick = () => trocarPerfil("oficial");
carregarPerfil();
$("atualizarContaAzul").onclick = () => carregarContaAzul(true);
$("confirmarEmpresa").onclick = confirmarEmpresaContaAzul;
$("sincronizarCentros").onclick = sincronizarCentrosContaAzul;
$("criarCentro").onclick = criarCentroContaAzul;
if ($("marcarNotificacoesLidas")) $("marcarNotificacoesLidas").onclick = marcarNotificacoesLidas;
$("temaToggle").onclick = () => aplicarTema(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
aplicarTema(document.documentElement.dataset.theme || "light");
atualizar(); carregarContaAzul(false); atualizarNotificacoes();
// As fotos e o envio ficam na Central de revisao; aqui so o estado do WhatsApp e os avisos.
setInterval(() => { atualizar(); atualizarNotificacoes(); }, 5000);
