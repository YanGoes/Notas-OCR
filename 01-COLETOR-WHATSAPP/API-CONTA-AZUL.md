# Contrato da API Conta Azul (v2)

Anotações levantadas **testando a API da conta de teste** em 03/08/2026, porque o portal de
documentação (`developers.contaazul.com`) responde 403 sem login. Onde estiver marcado
"não verificado", o campo ainda não foi confirmado.

Base: `https://api-v2.contaazul.com`

## Consultas úteis

| Endpoint | Retorno na conta de teste |
| --- | --- |
| `GET /v1/pessoas/conta-conectada` | Empresa vinculada — serve de teste de conexão |
| `GET /v1/categorias?tamanho_pagina=200` | 125 categorias (112 do tipo `DESPESA`) em 07/08/2026 |
| `GET /v1/centro-de-custo` | 4 em 07/08/2026: `TESTE CC`, `CONSOL MG-050`, `CONSOL MG-259`, `Consol` |
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

## Criar despesa

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

Tudo acima está **confirmado por lançamento real** na conta de teste: categoria, centro de custo,
valor, competência, vencimento e método de pagamento gravam corretamente.

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

### A descrição do evento some — quem aparece é a da parcela

Confirmado em 07/08/2026, por lançamento real. Mandamos `descricao: "ALMOÇO - 2 PESSOAS"` na raiz do
evento e `descricao: "Parcela 1/1"` na parcela. Resultado: **`ALMOÇO - 2 PESSOAS` não aparece em
endpoint nenhum.** A busca e o detalhe da parcela mostram `"Parcela 1/1"`, e o objeto `evento` do
detalhe **não tem campo `descricao`**.

Isso também explica o export `visao_contas_a_pagar`: ele é um export **de parcelas** (tem "Valor
original da parcela", "Data de vencimento"), então a coluna "Descrição" que traz `ALMOÇO - 2 PESSOAS`
no histórico é a descrição da **parcela**.

**Repita o mesmo texto nos dois campos.** Só a parcela é visível; a do evento parece ser descartada.

### A busca devolve parcelas, não eventos

`.../contas-a-pagar/buscar` retorna `{ itens_totais, itens[], totais }`, e cada item é uma **parcela**:

| Dado | Campo na busca |
| --- | --- |
| Valor | `total` (também `nao_pago`, `pago`) — **não** `valor` |
| Descrição | `descricao` da parcela |
| Categoria | `categorias[]` com `{id, nome}` |
| Centro de custo | `centros_de_custo[]` com `{id, nome}` |

Conferir por descrição+valor é frágil. O jeito exato está abaixo.

### O protocolo reaparece como `evento.referencia.id`

Este é o único elo entre o `POST` e o registro criado. O protocolo devolvido na criação volta em
`GET /v1/financeiro/eventos-financeiros/parcelas/{idParcela}` no campo `evento.referencia.id`
(com `evento.referencia.origem: "LANCAMENTO_FINANCEIRO"`).

Então a conferência confiável é: buscar o dia, filtrar candidatos por valor, e abrir o detalhe de
cada um até achar `evento.referencia.id === protocolo`. É o que `src/despesa-conta-azul.js` faz.

### A criação é assíncrona

A resposta não traz o id da despesa:

```json
{ "protocolo": "1ee1d478-...", "status": "PENDING", "data_criacao": "2026-08-03T18:48:53" }
```

`PENDING` significa apenas que a requisição entrou na fila — **não** que a despesa foi criada. Uma
requisição com categoria inexistente foi aceita com `PENDING` e depois descartada silenciosamente,
sem aparecer na busca.

Não achei endpoint que consulte o protocolo (`/protocolo/{id}` dá 404). Para confirmar que a
despesa realmente existe, é preciso consultar depois:

```
GET /v1/financeiro/eventos-financeiros/contas-a-pagar/buscar
    ?data_vencimento_de=AAAA-MM-DD&data_vencimento_ate=AAAA-MM-DD
```

**Qualquer automação precisa fazer essa conferência**, senão vai achar que lançou despesas que
foram descartadas.

### A fila é lenta e irregular — não desista cedo

Medido em 07/08/2026, com 17 lançamentos no mesmo dia: a grande maioria aparece na busca em ~3 s,
mas **um deles levou mais de um minuto**. Conferir com 3 s e desistir faz concluir "descartado" o
que estava apenas atrasado.

Isso é perigoso pelo motivo óbvio: sem `DELETE` na API, quem relança "porque falhou" cria uma
duplicata que não sai mais. Espere ao menos ~90 s antes de tratar como falha, e nunca relance
automaticamente. É o que `confirmarComEspera()` faz, com escada de 3/5/8/15/30/30 s.

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
| Fornecedor | **Impossível pelo lançamento direto**, confirmado em 07/08/2026. Ver a seção abaixo. |
| Conta financeira | `id_conta_financeira` é aceito sem erro mas fica `null`, tanto na raiz quanto na parcela. O campo existe na leitura; a hipótese é que só se define na **baixa** (pagamento), não na criação. |
| Anexos | **Não é possível pela API pública.** Ver a seção abaixo. |

Nenhum desses impede o fluxo principal: categoria e centro de custo — que é o que a legenda do
operador fornece — funcionam.

## Fornecedor: só a Captura amarra. Encerrado.

Investigado à exaustão em 07/08/2026. **15 combinações** de nome de campo e formato de valor, no
`POST` e no `PATCH`. Todas responderam **200** e todos os lançamentos nasceram com
`fornecedor: {id: null, nome: null}`.

| Valor testado | Campos |
| --- | --- |
| uuid novo da pessoa | `id_fornecedor`, `uuid_fornecedor`, `fornecedor` (string), `fornecedor:{uuid}`, `fornecedor:{id}`, `id_pessoa`, `uuid_pessoa` |
| uuid legado | `id_fornecedor`, `fornecedor`, `fornecedor:{id}`, `id_pessoa` |
| id legado numérico | `id_fornecedor` |
| `codigo` da pessoa (`"0001"`) | `id_fornecedor`, `codigo_fornecedor`, `id_legado_fornecedor` |

O que fecha a questão: o fornecedor que a **Captura** amarrou (`9b050ceb-…`) é o **uuid novo** da
pessoa — conferido com `GET /v1/pessoas/9b050ceb-…`, que devolveu
`RESTAURANTE SABOR CASEIRO LTDA`. Ou seja, o formato que mandávamos sempre esteve certo; o campo
simplesmente **não é honrado na criação**. Mesmo comportamento do rateio no `PATCH`: aceita e
ignora, e o 200 não significa nada.

Só a **Captura** preenche, do lado do servidor, a partir do CNPJ lido no documento — ela chega a
criar a pessoa sozinha. Mas não grava centro de custo; ver a tabela de comparação adiante.

**Não gaste mais tempo aqui.** Se quiser fornecedor, é interface do ERP ou Captura.

### De passagem: existe `/v1/pessoas/{uuid}` (plural), bem mais rico

`GET /v1/pessoa` (singular) lista `{ uuid, nome, documento, id_legado, uuid_legado, perfis, ... }`.
Já `GET /v1/pessoas/{uuid}` (plural) devolve **o `codigo` cadastrado no ERP** e o vínculo legado:

```json
{ "id": "c4428686-…", "nome": "Hoteis", "codigo": "0001",
  "pessoas_legado": [{ "id": 518700847, "uuid": "53dc2867-…", "perfil": "Fornecedor" }] }
```

Atenção: `/v1/pessoa/{uuid}` (singular com id) devolve **502**, não 404. E os filtros `?busca=` e
`?codigo=` na listagem são **ignorados** — devolvem a lista inteira. Filtre no cliente.

## Anexo: não dá pela API pública

Investigado a fundo em 07/08/2026. Três confirmações independentes:

**1. Não existe rota de anexo na `api-v2`.** Nove formatos testados, todos 404 em `GET` e `POST`:
`parcelas/{id}/anexos`, `/anexo`, `/arquivos`, `eventos-financeiros/{idEvento}/anexos`,
`eventos-financeiros/anexos`, `financeiro/anexos`, `/v1/anexos`, `/v1/arquivos`, `/v1/documentos`.

**2. O serviço real de anexos é interno e recusa o token OAuth.** Lendo os bundles do ERP
(`app.contaazul.com/modules/common-lib/*/index.min.js`) aparecem as rotas verdadeiras:

```
https://services.contaazul.com/contaazul-bff/ca-gateway/v1/attachment-uploads
https://services.contaazul.com/attachment-service/v1/files/{id}
https://services.contaazul.com/contaazul-bff/ca-gateway/v1/attachment-downloads
```

Repare no host: `services.contaazul.com`, o BFF do ERP — **não** `api-v2.contaazul.com`. Com o
mesmo Bearer que devolve 200 em `/v1/pessoas/conta-conectada`, as três respondem **401**. É a
sessão do ERP que autentica ali, não o OAuth de integração.

**3. Nem a Captura resolve.** Uma despesa criada a partir da Captura (imagem enviada e aceita)
também volta com `anexos: []`. A imagem fica no documento da captura, não vira anexo da despesa
na visão da API.

Conclusão: para ter o comprovante grudado no lançamento é preciso a interface do ERP, ou uma
credencial de sessão que a API pública não fornece.

## PATCH da parcela funciona — e o campo é `versao`, não `version`

`PATCH /v1/financeiro/eventos-financeiros/parcelas/{idParcela}` existe (o `PUT` dá 405).

Sem versão ele responde **409** com `"Versão informada para o recurso é inválida / name: version"`.
A mensagem diz `version`, em inglês, mas **o campo aceito é `versao`** — mandar `version` continua
dando 409. A versão atual vem no `versao` do detalhe da parcela e incrementa a cada alteração
(travamento otimista).

```json
PATCH /v1/financeiro/eventos-financeiros/parcelas/{id}
{ "versao": 0, "descricao": "ALMOÇO - 2 PESSOAS" }
```

Aceita: `descricao`, `nota`, `vencimento`, `composicao_valor`, `data_pagamento_esperado`,
`metodo_pagamento`.

**Não aceita categoria nem centro de custo.** Testadas três formas (`rateio` completo,
`id_categoria` solto, aninhado em `evento`): todas devolvem **200 e incrementam a versão**, mas o
rateio não muda. Aceita e ignora — não confie no 200.

Consequência prática: dá para corrigir a descrição de um lançamento depois de criado, mas
**a categoria só se define na criação**.

## A Captura atribui categoria e fornecedor (corrige nota anterior)

A observação anterior de que a Captura "nunca traz categoria nem centro de custo" vale para a
**prévia**, mas não para o resultado. Medido em 07/08/2026, ao aceitar uma captura de cupom:

| Campo | Resultado |
| --- | --- |
| Categoria | **Preenchida pela IA** — `Refeição - Almoço`, o mesmo id que usamos |
| Fornecedor | **Preenchido**, com id de pessoa criado (`RESTAURANTE SABOR CASEIRO LTDA`) |
| Centro de custo | **Vazio** (`rateio_centro_custo: []`) |
| Descrição | Gerada pela IA: `Almoço Executivo, Refrigerante e Couvert - ago/2026` |
| Anexo | `[]` |

Ou seja, Captura e lançamento direto se complementam mas nenhum entrega tudo:

| | Descrição padronizada | Categoria | Centro de custo | Fornecedor |
| --- | --- | --- | --- | --- |
| Lançamento direto | sim | sim | **sim** | não |
| Captura + aceite | não (mas `PATCH` corrige) | sim (pela IA) | **não** | sim |

O centro de custo é o que decide de qual obra é a despesa, e só o lançamento direto o grava.

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
| Valor da parcela | `detalhe_valor.valor_bruto` | `total` (na busca) |
| Protocolo do POST | (resposta: `protocolo`) | `evento.referencia.id` (no detalhe da parcela) |

## Captura (extração por IA), para comparação

Fluxo que funciona, medido em ~24 s numa foto de cupom:

1. `POST /v1/captura/documentos` — multipart, campo `arquivo`, opcional `descricao`
2. `GET /v1/captura/documentos/status?ids={id}` — até `status_captura: PENDENTE`
3. `GET /v1/captura/{idCaptura}` — devolve `previa_evento_financeiro`

A prévia traz tipo, valor, data, descrição, fornecedor com CNPJ e parcelas — mas **nunca categoria
nem centro de custo**, que é a razão de o projeto usar o lançamento direto.
