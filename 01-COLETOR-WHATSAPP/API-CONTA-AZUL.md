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

O documento aparece em **Conta AI Captura** antes do aceite. Depois, o lançamento aparece em
**Financeiro → Contas a pagar** e continua relacionado ao documento processado na interface. A API
pública não oferece um endpoint de upload de anexo para a despesa e o detalhe financeiro devolve
`anexos: []`; por isso o programa não promete um anexo financeiro gravado pela API. O endpoint de
aceite da Captura não aceita corpo, portanto uma categoria ou centro divergente precisa ser revisado
antes; o programa nunca força o aceite.

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
| `GET /v1/categorias?tamanho_pagina=200` | Catálogo da empresa; a quantidade varia com os cadastros |
| `GET /v1/centro-de-custo` | Centros ativos da empresa; a quantidade varia com os projetos |
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

## Criação financeira direta — caminho assistido e limitado

O payload abaixo foi comprovado na conta de teste para gravar valor, competência, vencimento,
descrição, categoria e centro de custo. Ele não grava fornecedor, CNPJ, conta financeira, baixa ou
anexo. Por isso o caminho direto é oferecido apenas como alternativa assistida quando a prévia da
Captura divergir, nunca como substituição silenciosa do fluxo principal.

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

O formato de `rateio` abaixo foi confirmado na conta de teste para categoria, centro, valor e
competência. Os UUIDs devem sempre ser validados contra a empresa conectada antes do envio.

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

### A descrição precisa estar também na parcela

A busca de contas a pagar trabalha com parcelas. Se a descrição padronizada estiver somente na raiz
do evento, ela pode não aparecer na listagem nem na exportação. O adaptador repete a descrição na raiz
e em `condicao_pagamento.parcelas[].descricao`.

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

O protocolo do `POST` reaparece no detalhe da parcela como `evento.referencia.id`. A reconciliação
segura busca os candidatos do período, abre cada detalhe e aceita somente uma correspondência que
tenha o mesmo protocolo, valor, data, categoria e centro. A fila pode demorar mais de um minuto; após
um resultado incerto o programa registra o estado e **não reenvia automaticamente**, evitando
duplicidade.

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
| Fornecedor | O lançamento direto nasce sem fornecedor. Variações de `id_fornecedor`, `fornecedor`, `pessoa`, UUID novo/legado e código foram aceitas, mas ignoradas. A Captura consegue relacionar o fornecedor a partir do documento. |
| Conta financeira | `id_conta_financeira` é aceito sem erro mas fica `null`, tanto na raiz quanto na parcela. O campo existe na leitura; a hipótese é que só se define na **baixa** (pagamento), não na criação. |
| Anexos | A API pública não expõe rota de upload aceita pelo OAuth da integração; o detalhe financeiro devolve `anexos: []`. |

Essas limitações impedem chamar o lançamento direto de “despesa completa”. Categoria e centro de
custo funcionam, mas fornecedor/documento e pagamento precisam ser conferidos separadamente.

### Comparação dos dois caminhos

| Campo | Captura + aceite | Lançamento direto |
| --- | --- | --- |
| Valor e data | Inferidos pela IA e revisáveis | Gravados com os dados aprovados pelo programa |
| Descrição | Gerada pela Captura | Padronizada pelo programa |
| Categoria | Inferida pela IA | UUID exato aprovado pelo programa |
| Centro de custo | Pode vir ausente | UUID exato aprovado pelo programa |
| Fornecedor | A Captura consegue relacionar | Não é gravado |
| Documento/anexo via API | Documento permanece na Captura; anexo financeiro não é exposto | Não há upload público |
| Conta/baixa/Pago | Concluídos na interface financeira | Não são configurados na criação |

Nunca aceite a Captura e crie diretamente a mesma nota: isso produz duas despesas. O programa mantém
os caminhos mutuamente exclusivos e exige confirmação explícita para qualquer `POST` financeiro.

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
| Protocolo do POST | resposta `protocolo` | `evento.referencia.id` (no detalhe) |

## Captura (extração por IA), para comparação

Fluxo que funciona, medido em ~24 s numa foto de cupom:

1. `POST /v1/captura/documentos` — multipart, campo `arquivo`, opcional `descricao`
2. `GET /v1/captura/documentos/status?ids={id}` — até `status_captura: PENDENTE`
3. `GET /v1/captura/{idCaptura}` — devolve `previa_evento_financeiro`

A prévia pode trazer tipo, valor, data, descrição, fornecedor, categoria e centro de custo. Como esses
dois últimos campos podem vir ausentes ou diferentes, o painel compara os IDs com os mapeamentos locais
e bloqueia o aceite quando não houver igualdade exata.
