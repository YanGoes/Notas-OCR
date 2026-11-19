## Conexao OAuth: "invalid_client" em apps novos (resolvido em 11/11/2026)

Ao conectar a conta OFICIAL pela primeira vez, a troca do `code` pelo token em
`https://auth.contaazul.com/oauth2/token` (o endpoint que o projeto sempre usou)
devolvia `{"error":"invalid_client"}` **mesmo com client_id/secret 100% conferidos**
(copiados por texto do portal, nao por print — a fonte do portal confunde "l"
minusculo com "I" maiusculo, mas isso foi descartado como causa depois de
conferir caractere a caractere). Testamos tambem: header Basic vs corpo,
com/sem secret (cliente publico), dois apps diferentes criados do zero — todos
deram o mesmo erro nesse host.

**Causa:** `auth.contaazul.com/oauth2/token` e o endpoint **legado**. So
reconhece apps antigos (ex.: o app de teste deste projeto, criado antes do
Portal do Desenvolvedor atual). Apps novos, criados no Portal atual
(`developers.contaazul.com`), ficam registrados em outro backend e precisam de:

```
POST https://api-v2.contaazul.com/oauth/token
```

Mesmo corpo/headers (Basic client_id:client_secret em Base64, `grant_type`,
`code`/`refresh_token`, `redirect_uri`). Confirmado funcionando: devolveu
`access_token`/`refresh_token`/`id_token` validos, com o `id_token` trazendo o
e-mail certo da empresa (`vmac@vmacengenharia.com`) e `ca_company_id` real.

O suporte da Conta Azul (chat) nao confirmou isso quando perguntado
diretamente ("nao ha etapa adicional de ativacao") — foi achado testando hosts
alternativos (`login.contaazul.com/oauth2/token` deu 403 do CloudFront,
`api-v2.contaazul.com/oauth/token` funcionou). Nao esta documentado
publicamente em `developers.contaazul.com/auth` (a pagina so descreve os 4
passos do fluxo em uma frase cada, sem URLs).

`src/conta-azul.js` usa `TOKEN_URL` (antigo, perfil "teste") ou
`TOKEN_URL_NOVO` (`api-v2.../oauth/token`, perfil "oficial") dependendo do
perfil ativo — ver `trocarToken()`. Se um dia a conta de teste tambem passar a
dar `invalid_client` no endpoint antigo, e so trocar o mesmo jeito.

# Contrato da API Conta Azul (v2)

Referência oficial atual: [API Financeira do Conta Azul](https://developers.contaazul.com/docs/financial-apis-openapi).
Os endpoints exigem OAuth 2.0. Consultas são feitas automaticamente; qualquer `POST` que altere o ERP
exige uma confirmação explícita no painel.

## Fluxo implementado no painel

O envio financeiro seguro usa a API oficial **Conta AI Captura**:

1. `POST /v1/captura/documentos` envia somente uma imagem já aprovada localmente;
2. `GET /v1/captura/documentos/status` e `GET /v1/captura/{id}` obtêm a prévia;
3. o programa compara tipo, valor, data, fornecedor, categoria e centro de custo;
4. `POST /v1/captura/{id}` só é liberado quando não existe divergência e o usuário confirma novamente.

O documento aparece em **Conta AI Captura** antes do aceite. Depois, aparece em
**Financeiro → Contas a pagar**, com a imagem original anexada. O endpoint de aceite não aceita corpo,
portanto uma categoria ou centro divergente precisa ser revisado antes; o programa nunca força o aceite.

## IDs de categoria e centro de custo

Os IDs usados no rateio não são o `CONTA_AZUL_CLIENT_ID` da aplicação. Eles são UUIDs dos cadastros
financeiros da empresa conectada:

- categorias de despesa: `GET /v1/categorias?pagina=1&tamanho_pagina=1000&tipo=DESPESA&permite_apenas_filhos=false`;
- centros de custo ativos: `GET /v1/centro-de-custo?pagina=1&tamanho_pagina=1000&filtro_rapido=ATIVO`.

A resposta de categorias usa a lista `itens`; a resposta de centros de custo usa `items` na versão
atual da documentação. O sincronizador aceita os dois formatos para tolerar versões anteriores.

Execute `CONFIGURAR_IDS_CONTA_AZUL.bat` depois da autorização OAuth. A ferramenta apenas consulta a
API, salva os catálogos em `dados/conta-azul` e atualiza os JSONs locais após confirmação do usuário.
Ela nunca envia `POST`, `PUT`, `PATCH` ou `DELETE` ao Conta Azul.

O modo `--automatico` só aplica equivalências explícitas em `configuracao/categorias.json` e
correspondências exatas. Na configuração atual: `ALIMENTACAO EM CAMPO` → `Lanches e Refeições`,
`COMBUSTIVEL` → `Combustíveis`, `FARMACIA` → `Farmácia`, `DESLOCAMENTO` →
`Transporte Urbano (táxi, Uber)`, `MANUTENCAO` → `Manutenção de Veículos` e `MATERIAL DE CAMPO` →
`Materiais Aplicados na Prestação de Serviços`. Hospedagem e outros ficam pendentes se não houver
correspondência inequívoca.

Os UUIDs mostrados abaixo foram observados em uma conta de teste e não devem ser copiados para outra
empresa. Sempre obtenha os IDs da conta que será usada em produção.

Anotações levantadas **testando a API da conta de teste** em 03/08/2026 e confrontadas com a
documentação oficial disponível atualmente. Onde estiver marcado "não verificado", o campo ainda
não foi confirmado no fluxo deste projeto.

Base: `https://api-v2.contaazul.com`

## Consultas úteis

| Endpoint | Retorno na conta de teste |
| --- | --- |
| `GET /v1/pessoas/conta-conectada` | Empresa vinculada — serve de teste de conexão |
| `GET /v1/categorias?tamanho_pagina=200` | 123 categorias (110 do tipo `DESPESA`) |
| `GET /v1/centro-de-custo` | Vazio — precisa cadastrar |
| `GET /v1/conta-financeira` | Vazio — precisa cadastrar |
| `GET /v1/pessoa` | Cadastro de pessoas (fornecedores/clientes) |
| `GET /v1/financeiro/eventos-financeiros/contas-a-pagar/buscar` | Exige `data_vencimento_de` e `data_vencimento_ate` |

Categorias já úteis para o fluxo de despesas de campo:

| Nome | id |
| --- | --- |
| Combustíveis | `b2e64f41-0b9c-4608-8e3e-0e0a0080e0a0` |
| Lanches e Refeições | `5bd50b47-4409-4157-b631-98a24f26148a` |
| Manutenção de Veículos | `aff51b5a-3b53-4101-9fd5-92d67329df33` |
| Transporte Urbano (táxi, Uber) | `966c057b-f439-4db4-ad46-639527d2a846` |

## Criação financeira direta — referência histórica, não usada pelo painel

O contrato oficial atual também exige `contato`, `conta_financeira`, observação e os dados da conta em
cada parcela. O payload abaixo foi aceito por uma versão anterior da conta de teste, mas não contém
todos os campos hoje documentados e **não deve ser usado como contrato de produção**. O painel usa a
Captura porque ela resolve o fornecedor e mantém a imagem anexada.

`POST /v1/financeiro/eventos-financeiros/contas-a-pagar`

```json
{
  "descricao": "Refeição (almoço) - Rodrigo e Hugo",
  "valor": 48.0,
  "data_competencia": "2026-07-26",
  "condicao_pagamento": {
    "tipo": "A_VISTA",
    "parcelas": [
      {
        "data_vencimento": "2026-07-26",
        "descricao": "Parcela 1/1",
        "detalhe_valor": {
          "valor_bruto": 48.0,
          "valor_liquido": 48.0,
          "desconto": 0,
          "taxa": 0,
          "multa": 0,
          "juros": 0
        }
      }
    ]
  },
  "rateio": [
    {
      "id_categoria": "5bd50b47-4409-4157-b631-98a24f26148a",
      "valor": 48.0,
      "rateio_centro_custo": [
        { "id_centro_custo": "af692fa0-8f85-11f1-a1fb-07d665f7a520", "valor": 48.0 }
      ]
    }
  ]
}
```

O formato de `rateio` abaixo foi confirmado historicamente na conta de teste para categoria, centro,
valor e competência. Isso não elimina os campos adicionais obrigatórios no contrato atual.

### Centro de custo vai dentro do rateio, como lista

Não é um id solto. Cada item do `rateio` tem seu próprio `rateio_centro_custo`, que é um **array**
(permite dividir uma categoria entre vários centros de custo). A chave interna é `id_centro_custo` —
sem o "de". Foram recusados `id_centro_de_custo` e `id` no lugar dele.

Obrigatórios, segundo as mensagens de validação: `valor`, `data_competencia`,
`condicao_pagamento` (com ao menos uma parcela) e `rateio` (com ao menos uma categoria).

### Pegadinha: o campo da composição de valor chama `detalhe_valor`

Esse foi o campo mais difícil de achar. A mensagem de erro é
`"valor da parcela: A composição de valor é obrigatória."` e **não** muda de texto quando o nome
está errado, então ela não ajuda a encontrar o nome certo. Foram recusados: `composicao_valor`
(que é como a API da **Captura** devolve o mesmo dado, na resposta), `valor`, `composicao`,
`valor_composicao`, `composicao_de_valor`, `composicao_valores`, `valores`, `valor_parcela` e
`valueComposition`.

Ou seja: a Captura **responde** com `composicao_valor`, mas o financeiro **exige** `detalhe_valor`.
Não copie o nome de um para o outro.

### A criação é assíncrona

A resposta não traz o id da despesa:

```json
{ "protocolo": "1ee1d478-...", "status": "PENDING", "data_criacao": "2026-08-03T18:48:53" }
```

`PENDING` significa apenas que a requisição entrou na fila — **não** que a despesa foi criada. Uma
requisição com categoria inexistente foi aceita com `PENDING` e depois descartada silenciosamente,
sem aparecer na busca.

A documentação atual publica `GET /v1/protocolo/{id}`. Mesmo assim, a confirmação funcional também
pode ser feita consultando as contas a pagar pelo período:

```
GET /v1/financeiro/eventos-financeiros/contas-a-pagar/buscar
    ?data_vencimento_de=AAAA-MM-DD&data_vencimento_ate=AAAA-MM-DD
```

**Qualquer automação precisa fazer essa conferência**, senão vai achar que lançou despesas que
foram descartadas.

## Consultar o que foi lançado

O detalhe de uma parcela é o retorno mais rico da API e foi ele que revelou os nomes dos campos:

```
GET /v1/financeiro/eventos-financeiros/parcelas/{idParcela}
```

Traz o evento com `rateio`, `rateio_centro_custo`, `valor_composicao`, `metodo_pagamento`,
`conta_financeira`, `anexos` e `baixas`. Não existe endpoint de detalhe do **evento**
(`/eventos-financeiros/{idEvento}` dá 404) — só o da parcela.

## Campos que NÃO funcionam na criação

| Campo | Situação |
| --- | --- |
| Fornecedor | Não conseguimos amarrar. Testados sem sucesso: `id_fornecedor`, `fornecedor:{id}`, `fornecedor:{uuid}`, `id_pessoa`, `pessoa:{id}`, `pessoa:{uuid}`, `uuid_fornecedor`, `uuid_pessoa`, `id_pessoa_fornecedor`. O lançamento nasce com `fornecedor: null`, mesmo com um id de fornecedor válido (`perfis: ["Fornecedor"]`). Provavelmente só é vinculado em outro momento, ou a despesa precisa nascer da Captura para ter fornecedor. |
| Conta financeira | `id_conta_financeira` é aceito sem erro mas fica `null`, tanto na raiz quanto na parcela. O campo existe na leitura; a hipótese é que só se define na **baixa** (pagamento), não na criação. |
| Anexos | Existe o campo `anexos` na leitura, sempre `[]`. Não foi testado como enviar a imagem. |

Nenhum desses impede o fluxo principal: categoria e centro de custo — que é o que a legenda do
operador fornece — funcionam.

## O que dá para cadastrar pela API

| Recurso | Criar | Alterar / excluir |
| --- | --- | --- |
| Categoria | **Não** — `POST /v1/categorias` responde 405 | — |
| Centro de custo | **Sim** — `POST /v1/centro-de-custo` com `{"nome": "..."}` | Não (404 em `PUT` e `DELETE`) |

Ou seja: **categorias só pelo ERP**. Isso importa porque as categorias de vocês (por veículo, com
placa) são customizadas e precisam existir antes de qualquer lançamento automático.

Centro de custo criado por engano não sai pela API — só dá para inativar pela interface.

## Não há exclusão

A API não expõe `DELETE` para eventos nem para parcelas (405/404). Lançamento errado só se apaga
pela interface do ERP. **Mais um motivo para conferir antes de lançar, e não depois.**

## Atenção: nome de campo diferente na escrita e na leitura

Vale memorizar, porque custou caro:

| Dado | Escrita (POST) | Leitura (GET) |
| --- | --- | --- |
| Composição do valor | `detalhe_valor` | `valor_composicao` |
| Centro de custo | `rateio_centro_custo[].id_centro_custo` | `centros_de_custo[]` (na busca) |

## Envio da Central (testado em 19/10/2026, empresa de teste)

Caminho usado por `src/central/envio.js` e `ferramentas/enviar-teste-conta-azul.js`:

`POST /v1/financeiro/contas-a-pagar` (endpoint novo, resposta direta com `id` e parcelas) **grava**
categoria, centro de custo, fornecedor (`id_fornecedor`, obrigatório), conta financeira, descrição,
observação e forma de pagamento. Conferido relendo a parcela e a busca de contas a pagar.

- **Fornecedor:** `GET /v1/pessoas?documentos=<CNPJ>` acha pelo CNPJ lido na nota; `?busca=<nome>`
  acha por nome. O envio nunca cria fornecedor: sem cadastro, recusa.
- **Foto:** a API não tem envio de anexo. A foto fica no arquivo do Drive.
- **Captura + aceite não serve:** a prévia não aceita edição (`PATCH/PUT /v1/captura/{id}` → 405) e a
  categoria fica a que a Captura escolheu, sem centro de custo. A Captura também não deixa a foto em
  `anexos` da parcela.
- **PATCH da parcela não muda categoria nem centro:** o contrato só tem `nota`, `descricao`, `vencimento`,
  `composicao_valor`, `metodo_pagamento`, `id_conta_financeira`… O `rateio` enviado é ignorado sem erro.
- Trava: só envia se a empresa conectada for `config.central.envio_conta_azul.somente_empresa_id`.
  Cada envio fica em `envios_conta_azul` (não reenvia a mesma despesa).

## Captura (extração por IA), para comparação

Fluxo que funciona, medido em ~24 s numa foto de cupom:

1. `POST /v1/captura/documentos` — multipart, campo `arquivo`, opcional `descricao`
2. `GET /v1/captura/documentos/status?ids={id}` — até `status_captura: PENDENTE`
3. `GET /v1/captura/{idCaptura}` — devolve `previa_evento_financeiro`

A prévia pode trazer tipo, valor, data, descrição, fornecedor, categoria e centro de custo. Como esses
dois últimos campos podem vir ausentes ou diferentes, o painel compara os IDs com os mapeamentos locais
e bloqueia o aceite quando não houver igualdade exata.

### Reteste em 11/11/2026: duplicar a mesma foto NÃO vincula a um lançamento já existente

Motivado pela pergunta "dá pra anexar foto a uma despesa já lançada usando a automação/API da
Conta Azul". Mandamos a mesma imagem duas vezes pra Captura, na conta de teste:

1. 1ª vez: `status_documento` passa por `AGUARDANDO_VINCULO_LANCAMENTO` e termina em `PRONTO`
   com uma captura `PENDENTE`. Aceitamos e criou o evento financeiro normalmente.
2. 2ª vez (foto idêntica, byte a byte): passa pelo MESMO `AGUARDANDO_VINCULO_LANCAMENTO`, mas
   termina criando uma captura **nova e independente**, com uma leitura de OCR ligeiramente
   diferente da primeira (fornecedor leu "PANIFICADORA GOIAS" na 2ª vez contra "PANIFICADORA E
   CONFEITARIA JK LTDA ME" na 1ª, categoria sem centro de custo). Não houve nenhuma ligação com o
   evento já criado na 1ª vez — a API não expõe (pelo menos não documentado) um jeito de "grudar"
   o documento num lançamento que já existe.
3. Conferido também: depois do aceite, `GET .../parcelas/{id}` devolve `"anexos": []` — a foto
   **não** aparece como anexo da parcela, confirmando o que já estava anotado acima (seção "Envio
   da Central").

**Conclusão:** `AGUARDANDO_VINCULO_LANCAMENTO` parece ser um passo interno do pipeline deles
(provavelmente pensado pra conciliação bancária, não pra "colar foto em despesa feita por fora"),
não uma automação que a gente consiga acionar via API pra resolver o problema de anexo. Fechado:
Captura **não é o caminho** para anexar comprovante a uma despesa já criada pela nossa integração.

### Leitura da especificação oficial em 11/11/2026 (sem chamadas à API)

Lidos o índice da documentação (`developers.contaazul.com/llms.txt`), os OpenAPI de Financeiro e
Captura (`/_bundle/open-api-docs/open-api-finance.yaml` e `developer-platform-open-api-capture.yaml`)
e o changelog até 04/11/2026:

- **Não existe rota de escrita de anexo.** `anexos` aparece só na LEITURA da parcela (`ParcelaAnexo`)
  e da baixa (`AnexoBaixa`). Os corpos de `POST /v1/financeiro/contas-a-pagar`
  (`CriacaoEventoFinanceiroContasPagar`), `PATCH /v1/financeiro/parcelas/{id}` (`AtualizacaoParcela`)
  e `POST/PATCH /v1/financeiro/baixas` não têm campo de arquivo, anexo ou URL.
- **O único envio de arquivo é a Captura** (`POST /v1/captura/documentos`, multipart `arquivo` +
  `descricao`). O aceite (`POST /v1/captura/{id}`) continua sem corpo.
- **Pista ainda não testada:** `GET /v1/captura/{id}` devolve `sugestao_evento_financeiro.id_parcela`
  ("ID da parcela sugerida") e o documento passa por `AGUARDANDO_VINCULO_LANCAMENTO`. Indica que a
  Captura pode sugerir uma parcela QUE JÁ EXISTE. Teste que falta: criar o lançamento pelo
  `POST /v1/financeiro/contas-a-pagar` (com tudo), enviar a foto à Captura, ler
  `sugestao_evento_financeiro.id_parcela` e, se for a nossa parcela, aceitar e conferir no site se a
  foto ficou no clipe sem criar lançamento duplicado. O reteste acima (mesma foto duas vezes) não
  cobre isso: não criou o lançamento antes pelo POST nem registrou o campo `sugestao_evento_financeiro`.
- Caminhos novos desde 19/10/2026: `GET/PATCH /v1/financeiro/parcelas/{id}`,
  `GET /v1/financeiro/contas-a-pagar`; o `POST .../contas-a-pagar/buscar` deixou de existir (o `GET`
  no mesmo caminho, que o programa usa, continua).

### Link da foto no Drive (implementado em 11/11/2026)

Como a API não anexa arquivo, o envio da Central manda o **link** da foto arquivada no Google Drive:

- O Drive para computador expõe o ID de cada arquivo no fluxo `<arquivo>:user.drive.id`. Foto
  recém-copiada começa com ID provisório (`local-123`) e recebe o definitivo em ~7 s. O link é
  `https://drive.google.com/file/d/<ID>/view` (`linkDaFoto` em `src/central/arquivo-drive.js`).
- Com `config.central.envio_conta_azul.link_da_foto: true`, a observação do lançamento termina com
  `Foto: <link>`. Nota com foto e sem link **não sobe** (a observação não pode ser corrigida depois
  pela API); nota sem comprovante sobe sem link. A ferramenta de envio copia as fotos que faltam
  para o Drive e espera até 60 s o link ficar pronto.
- **Aba Anexo do site:** a tela do lançamento tem "Forma do anexo: Link" + "Tipo de anexo: Outros" +
  "Descrição" (print do Yan, 11/11). É o mesmo formato que a LEITURA da parcela devolve
  (`anexos[].tipo_conteudo = URL`, `tipo_anexo = OUTROS`, `url`, `descricao`). A especificação não
  tem campo de escrita para isso; falta testar na conta de teste se a criação aceita `anexos` não
  documentado. Se aceitar, o link passa da observação para a aba Anexo.

### Teste em 11/11/2026 (conta de teste): a API NÃO grava anexo por Link

Sonda `SONDA ANEXO LINK - NAO USAR` (R$ 1,23, evento `487e13c6-639e-4870-86f4-ee40784905df`, parcela
`f1cadcad-6d06-4532-a3c0-eb62d6bdde59`), rodada com `CONTA_AZUL_PERFIL=teste` (vale só para o processo;
o perfil gravado do programa não muda):

- `POST /v1/financeiro/contas-a-pagar` com `anexos` no evento e na parcela
  (`{tipo_conteudo:"URL", url, tipo_anexo:"OUTROS", descricao}`): responde 201, cria o lançamento e
  **ignora** o campo — a releitura devolve `anexos: []`.
- `PATCH /v1/financeiro/parcelas/{id}` com `anexos` em três formatos: responde 200, incrementa a
  `versao` e **não grava** (mesmo comportamento do `rateio`).
- Rotas tentadas, todas 404 ("não corresponde a um recurso da API"): `.../parcelas/{id}/anexos`
  (POST, PUT, GET), `.../parcelas/{id}/anexo`, `.../eventos-financeiros/parcelas/{id}/anexos`,
  `.../eventos-financeiros/{evento}/anexos`, `.../contas-a-pagar/{evento}/anexos`, `/v1/financeiro/anexos`.

**Conclusão:** a opção "Anexo → Link" do site só é preenchida pelo próprio site. Pela API o link só
entra em campo de texto (observação). Para cair na aba Anexo é preciso automação de tela, ou o
Conta Azul abrir a escrita de anexos na API.

### Teste em 11/11/2026 (conta de teste): Captura SUGERE a parcela existente, mas o aceite pela API DUPLICA

Despesa #458 (café da manhã, R$ 60,00, 08/11/2026). Sequência:

1. `POST /v1/financeiro/contas-a-pagar` com tudo → evento `de201e2c-debb-432e-808c-5212beb31202`,
   parcela `c5c8a4a1-c24f-41cb-bae3-ba915303a55a`.
2. Foto enviada a `POST /v1/captura/documentos` → `PRONTO / PENDENTE` em 9 s.
3. `GET /v1/captura/{id}` devolveu `sugestao_evento_financeiro.id_parcela` = **a nossa parcela**, e a
   prévia veio com a mesma categoria e o mesmo centro do lançamento criado (a Captura reconheceu o
   lançamento existente).
4. `POST /v1/captura/{id}` (aceite) **criou outro evento** (`e07bc443-38f1-40d0-9f63-156d57481c17`,
   "Cupom Fiscal Eletrônico - COMERCIAL LINS E GUEDES LTDA") em vez de vincular: o dia ficou com 2
   contas e a nossa parcela continuou com `anexos: []`.

**Conclusão:** a API pública não tem "vincular ao lançamento sugerido"; o aceite só cria. Nunca
aceitar pela API uma captura cuja sugestão aponta para parcela existente: duplica e não dá para
apagar. O vínculo, se existir, é ação da tela "Conta AI Captura" do site (não verificado).
Sobraram na conta de teste: os dois lançamentos de R$ 60,00 em 08/11 e o fornecedor
"COMERCIAL LINS E GUEDES LTDA".

## Robô de tela: link da foto na aba Anexo (11/11/2026, funcionando na conta de teste)

A API pública não grava anexo, mas o **site** grava com o serviço interno dele. Observado ao salvar
"Anexo → Forma: Link, Tipo: Outros" na conta de teste:

```
PATCH https://services.contaazul.com/finance-pro/v1/financial-events/{id_evento}
{ "version": 0, "attachments": [ { "name": null, "reference": null, "url": "<link>",
    "description": "Foto da nota", "type": "OTHERS", "contentType": "URL" } ] }
GET   https://services.contaazul.com/finance-pro/v1/financial-events/{id_evento}   (version, attachments…)
```

- **Autenticação:** só os cookies da sessão de quem está logado no site. Por isso a chamada roda
  dentro da página, num navegador próprio do programa (`src/central/navegador-conta-azul.js`: Chrome
  ou Edge já instalado, perfil em `dados/navegador-conta-azul`, protocolo de depuração em 127.0.0.1,
  sem instalar nada). O login é feito pela pessoa nessa janela (atalho `18_ABRIR_ROBO_CONTA_AZUL.bat`).
- **A lista enviada substitui a anterior:** anexo que fica de fora é excluído (testado). O robô sempre
  manda os anexos vivos que já existem + o novo, e não repete um link que já está lá.
- **`version`** é a versão atual do evento, lida antes de gravar.
- **Fluxo** (`src/central/anexo-conta-azul.js` + `envio.js`), com `link_da_foto: "anexo"`:
  1. confere que a nota tem link no Drive e que o robô está com sessão aberta (senão não cria nada);
  2. cria o lançamento pela API pública;
  3. o robô lê o evento no site, confere a referência (`central-<id>`), grava o anexo e relê;
  4. o relatório ganha a linha "anexo da foto". Se o robô falhar, o envio fica `ENVIADO_INCOMPLETO`
     e `node ferramentas/enviar-teste-conta-azul.js --anexar-pendentes` tenta de novo
     (`--antigos` inclui os enviados antes de o robô existir).
- **Teste real:** despesa #448 (almoço, R$ 134,00, 31/10/2026) → evento
  `104c2654-f4eb-4853-86c7-6b9b1f834b9c`, anexo por link gravado e relido.
- **Risco:** é serviço interno, sem contrato: pode mudar sem aviso. Tudo é conferido na releitura e a
  falha não derruba o envio. A empresa do robô é a que estiver logada na janela: se for outra, o
  evento não existe lá (404) e nada é gravado.
- **Ainda não feito:** anexar o ARQUIVO da foto (Forma: Arquivo) e ligar o robô ao botão de envio da
  Central / assistente (hoje só a ferramenta de terminal envia).

## Imagem da nota como anexo, envio por conta e assistente (11/11/2026, noite)

Decisão do Yan: **sem link**; vai só a **imagem** na aba Anexo. E o assistente passa a lançar na
conta de teste ou na oficial.

**Como o site anexa um arquivo** (observado na conta de teste):

```
POST https://services.contaazul.com/attachment-service/v1/files      multipart, campo "file"
     → 201 { "id": "<id do arquivo>", "name", "tenantId", "size", "type", "temporary": true }
PATCH https://services.contaazul.com/finance-pro/v1/financial-events/{id_evento}
     { "version": N, "attachments": [ …os que já existem (name, id, reference, url, description, type, contentType),
       { "name": "<nome>", "reference": "<id do arquivo>", "url": null, "description": null,
         "type": "OTHERS", "contentType": "FILE" } ] }
GET  https://services.contaazul.com/app/user                          → { "idEmpresa", "nome", … } (quem está logado)
GET  https://services.contaazul.com/attachment-service/v1/downloads/{reference}  (baixa o arquivo anexado)
```

**No programa:**

- `config.central.envio_conta_azul.anexo_da_foto`: `"arquivo"` (a imagem; é o que está ligado) ou
  `"link"` (o link do Drive na aba Anexo). `link_da_foto: true | "observacao"` ainda põe o link no texto
  da observação, mas está desligado. No modo `"arquivo"` o envio não depende do Drive: usa a foto que
  está no programa, com o nome `#<nota> <TIPO> R$ <valor>.jpg`.
- **Robô por conta:** cada conta tem a sua janela e o seu perfil (`dados/navegador-conta-azul` =
  teste, `dados/navegador-conta-azul-oficial` = oficial; atalho 18 pergunta qual). Antes de criar
  qualquer lançamento o robô confere, por `/app/user`, que a janela está logada **na mesma empresa**
  do envio; se não estiver, nada é criado.
- **Conta por chamada:** `contaAzul.comPerfil("teste" | "oficial", fn)` faz a API usar a conta pedida
  só dentro daquela chamada, sem trocar o perfil gravado que o resto do programa usa (seletor do painel).
- **Conta oficial** (`envio.exigirEmpresa`): só envia se `envio_conta_azul.oficial = { "habilitado":
  true, "empresa_id": "<id>" }` e a empresa conectada for essa. Na oficial nada é substituído nem
  cadastrado: categoria, centro e fornecedor precisam existir com o nome exato, e a conta financeira vem
  do cartão da nota (`configuracao/cartoes.json` → `conta_conta_azul_id`, hoje vazio em todos).
- **Assistente:** `preparar_lancamento({ ids, conta })` vira o botão Confirmar ("Lançar na conta de
  TESTE…" / "…na conta OFICIAL (empresa real)…"). Depois do Confirmar roda `envio.enviarLote`, que
  confere empresa e robô antes de começar e devolve o resultado nota a nota. Precisa de
  `config.central.lancamento_habilitado: true` (ligado no config local).
- **Testes reais (conta de teste):** #448 (link, primeira versão) e #212 pelo caminho do assistente:
  evento `d91a5d8a-1caa-4518-a001-db744a218b19`, anexo `#212 ALMOCO R$ 182,00.jpeg` relido e baixado
  do site com 92.164 bytes, igual à foto local. Pedido para a conta oficial devolveu "ainda não
  conectada", sem enviar nada.

**Falta para a conta oficial:** conectar a API com o login da empresa (atalho 04, perfil oficial),
gravar a liberação no config com o ID que a mensagem de bloqueio mostra, entrar na janela do robô da
conta oficial, e preencher `conta_conta_azul_id` dos cartões com as contas financeiras reais.

## Botões de envio na Central (11/11/2026)

Na aba **Aprovadas**:

- **📤 Enviar ao Conta Azul** (dentro da nota aprovada, bloco "Conta Azul"): envia só aquela nota.
  O bloco mostra para qual conta ela já foi enviada, quando, por quem e se a foto ficou anexada.
- **📤 Enviar todas ao Conta Azul** (barra de filtros): envia todas as aprovadas que ainda não subiram
  para a conta escolhida, uma a uma, em segundo plano, com andamento e botão **Parar**.
- A janela pergunta a conta (teste ou oficial; a oficial só fica marcável depois de liberada e pede uma
  confirmação a mais). Na lista, a nota enviada ganha a etiqueta "📤 teste" / "📤 oficial".
- Só Yan, Jhonathan e Vanessa enviam (nome no campo Revisor), como no Confirmar do assistente.
- Rotas: `GET /api/central/envio/situacao`, `POST /envio/enviar` (`{ conta, ids | todas, autor, aguardar }`),
  `GET /envio/andamento`, `POST /envio/parar`. Controle em `src/central/envio-central.js` (um envio por vez);
  o envio em si é o mesmo `envio.enviarLote` do assistente.
- Teste real pelo botão: nota #209 enviada para a conta de teste com a foto anexada; repetir o envio
  devolveu "já foi enviada para esta empresa", sem duplicar.
- **O programa aberto precisa ser reiniciado** para carregar rotas, assistente e tela novos. O erro
  "Envio ao Conta Azul não disponível neste processo" é o código antigo ainda em memória.

## O envio leva o que está na Central, também na conta de teste (11/11/2026)

Decisão do Yan depois de enviar a #463: o lançamento tem de sair com os dados da Central, seja teste
ou oficial. Antes, na conta de teste, o programa trocava o centro por "TESTE CC", a conta financeira
por "Teste", a categoria por uma parecida e o fornecedor pelo do CNPJ lido no cupom.

- **Nada é trocado por parecido.** Categoria e centro: pelo nome exato da Central. Fornecedor: o
  **aprovado na Central** (ex.: SUPERMERCADO); o CNPJ lido só vale quando a nota não tem fornecedor
  aprovado. Conta financeira: a do cartão da nota (`configuracao/cartoes.json` → `conta_conta_azul`,
  o nome no Conta Azul; `conta_conta_azul_id` se preenchido).
- **Nomes das contas** (tirados do histórico do Conta Azul, por forma de pagamento): CRÉDITO INTER →
  "Inter - Conta Corrente"; CRÉDITO BB e DÉBITO BB → "Banco do Brasil - Conta Corrente"; CRÉDITO C6 e
  C6 - LP → "C6 - Conta Corrente LP"; C6 - SN → "C6 - Conta Corrente - SN"; CRÉDITO PORTO → "Porto
  Seguro - Conta Corrente". **Conferir com o Yan** (o crédito C6 saiu 73× da LP e 6× da SN).
- **Cadastro que falta:** na conta de TESTE é criado com o mesmo nome na hora do envio — centro
  (`POST /v1/centro-de-custo`) e fornecedor (`POST /v1/pessoas`) pela API; categoria e conta financeira
  pelo robô, porque a API não cria: `POST services.contaazul.com/app/finance/v2/categories
  { name, parentId, type: "EXPENSE" }` e `POST services.contaazul.com/app/financial-accounts
  { bankInstitutionCode: -20, name, initialBalance: 0, initialBalanceDate, type: "OTHERACCOUNT", active: true }`.
  Na OFICIAL nada é criado: a nota não sobe e o motivo aparece.
- **Nota que não sobe em nenhuma conta:** sem categoria, ou sem cartão/conta definido (PIX ou cartão
  sem dizer qual). Das 116 aprovadas pendentes em 11/11: 111 sobem; #278 e #284 sem categoria; #80,
  #317 (PIX) e #411 (débito) sem cartão/conta.
- **Reenvio (só conta de teste):** `--despesa N --reenviar --executar` marca o envio antigo como
  SUBSTITUIDO e envia de novo; o lançamento antigo fica lá para apagar pela tela.
- **Testes reais:** #463 reenviada → SUPERMERCADO, DESPESAS ADMINISTRATIVAS, Inter - Conta Corrente,
  Lanches e Refeições, foto anexada; #454 → categoria "ONIX - SFI4A94" e conta "Banco do Brasil - Conta
  Corrente" criadas pelo robô, centro "ETEL OAEs PR/2026" pela API. Tudo conferido na releitura.
  O lançamento antigo e errado da #463 (fornecedor BIG TRANS, TESTE CC) continua na conta de teste.

## Sem código de referência no lançamento (11/11/2026)

Pedido do Yan: o lançamento não leva mais `referencia_externa` ("central-<nota>" aparecia como
"Código de referência" na tela). Quem impede o envio repetido é a tabela `envios_conta_azul`; o robô
passou a conferir o lançamento pelo ID devolvido na criação e pelo **valor** (antes era pela
referência). Teste real: #458 enviada para a conta de teste, relida pelo site com o código de
referência vazio e a foto anexada. Lançamentos enviados antes continuam com o código antigo.
