# Central de revisão (modo treino)

A Central mostra cada despesa que a IA montou a partir das fotos do WhatsApp, ao lado da foto, para uma pessoa conferir, corrigir e aprovar.

**Nada aqui lança no Conta Azul nem copia para o Drive.** Aprovar só valida a prévia e grava um exemplo de treino.

## Como abrir

1. Dê dois cliques em `ATALHOS/13_ABRIR_CENTRAL_REVISAO.bat`.
2. A Central abre em `http://127.0.0.1:3211/central.html`.

Com a coleta aberta (`ATALHOS/15_COLETAR_WHATSAPP.bat`), a Central já está rodando junto, e o atalho 13 só abre o navegador. Com a coleta fechada, o atalho 13 sobe só a Central, sem conectar o WhatsApp, para revisar o que já chegou.

Para trazer notas lidas em outra instalação do programa, sem chamar o Azure de novo, use `npm run central:importar -- --origem <pasta dados>`.

## Abas

| Aba | O que tem |
|---|---|
| Para revisar | Prévias com pendências (falta dado, projeto inativo, possível duplicidade…) |
| Classificadas | Prévias sem pendência. Ainda precisam de aprovação humana para virar treino |
| Aprovadas | Validadas por uma pessoa. Cada uma é um exemplo de treino |
| Duplicadas / descartadas | Mesma nota fiscal já registrada, ou descartadas com motivo |
| Treino | Acerto da IA por campo, só sobre o que foi aprovado |

## Separação por operador

Acima da lista há um botão para cada operador, com quantas notas ele tem na aba aberta: **Todos · Lorran (3) · Almir (0) · … · Não identificado (46)**. Clique para ver só as notas daquela pessoa. A escolha fica lembrada no navegador.

- **Operador é a pessoa que mandou a nota**, reconhecida pelo telefone, e não o grupo, porque um grupo pode ter mais de um operador.
- **Todos os operadores do cadastro aparecem**, mesmo com zero notas, para ficar claro quem não mandou nada.
- **"Não identificado"** junta as notas de números que o programa ainda não reconhece. Depois de vincular o número (faixa amarela), as notas passam para o operador certo.
- **Aba Treino:** a tabela **Por operador** mostra notas enviadas, quantas estão para revisar, aprovadas e descartadas, o acerto da IA e o que **faltou informar** (cartão, projeto, pessoas). Ela aponta quem precisa ser orientado sobre a mensagem padrão.

## Como revisar uma despesa

1. Escreva seu nome em **Revisor** (topo da página). Toda correção e aprovação fica registrada com ele.
2. Compare a foto com os campos. Embaixo de cada campo aparece de onde o valor veio: lido na nota, legenda da foto, orientação da gerência etc.
3. Ao mudar um campo, aparece o **motivo da correção**:
   - **Leitura**: o OCR leu errado o que está impresso (valor, data, placa, litros, hodômetro, fornecedor).
   - **Classificação**: a leitura estava certa, mas a interpretação não (tipo, categoria, centro de custo, pagamento, pessoas, descrição).
   - **Não informado**: a informação não existia, por exemplo quando o operador não disse o cartão ou a nota não tem a placa. Não conta como erro da IA, mas mostra o que falta pedir aos operadores. Quando o campo era vazio e só o operador pode informar (pagamento, centro de custo, pessoas), este motivo já vem marcado.
   - **Outro**: qualquer outra situação. Neste caso, a explicação é obrigatória.

   Abaixo do motivo há um campo para **explicar o erro com suas palavras** (por exemplo, "operador mandou o cartão no dia seguinte"). A explicação fica guardada com a correção e entra no exemplo de treino.
4. Escolha um destes botões:
   - **Salvar correções**: grava sem aprovar.
   - **Salvar e aprovar**: grava e aprova. Data, valor, tipo, descrição, categoria e centro de custo são obrigatórios.
   - **Descartar**: para o que não é despesa ou é duplicata confirmada. Exige motivo.
   - **Reabrir**: devolve à revisão e tira o exemplo do treino até nova aprovação.
   - **Regerar prévia**: monta a prévia de novo com os cadastros atuais, por exemplo depois de mudar `projetos.json`. Só funciona em prévias sem correção humana.

A descrição de abastecimento (`35,43L od 145.225 - JKN2876`) e de refeição (`JANTAR - 3 PESSOAS`) se refaz sozinha quando você corrige placa, litros, hodômetro ou pessoas. Isso só não acontece se você mesmo tiver escrito a descrição.

## Centros de custo (cadastro de projetos)

A aba **Centros de custo** mantém o `configuracao/projetos.json` sem ninguém editar o arquivo à mão. Para cada projeto você define:

- a **situação**: só projetos ativos são escolhidos automaticamente; inativos e não confirmados vão para revisão;
- o **centro no Conta Azul**: o nome exato, ou um trecho que ache um único centro (como "rota do pequi");
- os **apelidos**: como os operadores escrevem o projeto. Só um texto igual a um apelido resolve.

Regras de segurança:

- Toda alteração exige o nome do revisor e fica registrada (aba → "Últimas alterações").
- Um nome ou apelido não pode apontar para dois projetos. O sistema recusa.
- Ao renomear um projeto, o nome antigo vira apelido, para não perder mensagens e orientações de cartão já registradas.

Esta aba **não cria nada no Conta Azul**. O fluxo para um projeto novo é:

1. Crie o centro no Conta Azul pelo painel principal (Gerenciar centros de custo) e sincronize.
2. O centro aparece aqui como **Não confirmado**. Clique em **Confirmar**, marque como ativo e coloque os apelidos.
3. Clique em **Refazer prévias pendentes** para aplicar às despesas que ainda estão em revisão.

## Remetentes não reconhecidos

Nos grupos, o WhatsApp identifica cada pessoa por um código interno ("…@lid") que esconde o telefone. O programa traduz esse código para o telefone e procura no cadastro (`configuracao/pessoas.json`):

- **Mensagem nova:** se o WhatsApp mandar o telefone junto, a pessoa é reconhecida na hora.
- **Ao conectar:** o programa pergunta ao WhatsApp o telefone de cada remetente ainda desconhecido. Salvar o contato no celular ajuda o WhatsApp a liberar esse telefone.
- **Botão "Buscar nos contatos do WhatsApp"** (faixa amarela): faz a mesma busca na hora. Quando o telefone não está no cadastro, a resposta mostra só os **4 últimos dígitos**, para conferir no celular sem expor o número.
- **Manual:** escolha quem é a pessoa e clique em **Vincular**.

Em todos os casos, as prévias sem correção são refeitas e as próximas fotos já chegam com o nome certo. O número conectado ao programa aparece como **"Você (número conectado ao programa)"**.

Se um operador continuar desconhecido, confira se o telefone dele no cadastro é o mesmo do WhatsApp, com DDD.

## Onde ficam os dados

Tudo fica em `dados/central.db` (SQLite, fora do Git). As fotos importadas ficam em `dados/importados/`, também fora do Git.

| Tabela | O que guarda |
|---|---|
| `despesas.campos_originais` | A prévia exatamente como a IA gerou |
| `despesas.campos` | A versão atual, com as correções |
| `correcoes` | Cada campo corrigido: antes, depois, motivo, explicação, autor e data |
| `exemplos_treino` | Só despesas aprovadas: entrada (leitura do OCR, mensagem, prévia da IA) e rótulos (valores finais aprovados) |

## Treino com a planilha do Conta Azul

`ATALHOS/14_TREINAR_CENTRAL.bat` (ou `npm run central:treinar`) lê a planilha `visao_contas_a_pagar` e mede como a categoria seria decidida.

**Como o teste é feito:**
- só despesas de campo (as que chegam por foto) e só lançamentos já ocorridos;
- o teste usa os **últimos 3 meses** com volume normal, que o modelo não vê no treino;
- abastecimentos sem placa na descrição ficam de fora da conta, porque na Central o veículo vem da placa lida na nota.

**O que ele produz:**
- `configuracao/modelo-central.json` (fora do Git): a categoria que a VMac usa hoje para cada tipo e um modelo de texto;
- o resultado do teste, que aparece na aba **Treino**.

O modelo **só sugere** a categoria quando nenhuma regra decide. A sugestão aparece ao lado do campo, com o botão "Usar sugestão", e a despesa continua em revisão até alguém aprovar.

Rode o treino de novo sempre que exportar uma planilha mais recente: a VMac muda de categoria de tempos em tempos (por exemplo, o café da manhã passou para "Café da Manhã" em abril de 2026).

## Leitura e regras (revisão de 10/10/2026)

- **Fornecedor padrão por tipo**, configurado em `configuracao/fornecedores_recorrentes.json`: posto → "POSTOS DE COMBUSTÍVEL", restaurante → "RESTAURANTES", hotel → "HOTÉIS". O nome impresso na nota fica guardado como "nome lido", para auditoria.
- **A VMac nunca é fornecedor.** Ela aparece como tomadora da NFS-e ou como "EMPRESA:" no recibo. Na NFS-e, o fornecedor é a razão social do prestador.
- **Placa:** aceita o rótulo lido torto ("FLACA") e corrige trocas do OCR nas posições numéricas ("RBTZE25" → RBT2E25). Placa ilegível é comparada com a frota e vira **sugestão**.
- **Hodômetro:** aceita os rótulos "HM" e "KM" e números com centavos. Um número sem rótulo colado à placa é usado, mas vai como pendência para confirmar.
- **Data no futuro** (erro de leitura) é trocada pela outra data que aparece na nota.
- **Duas notas lado a lado na mesma foto** viram duas despesas. A separação usa a posição de cada linha na foto, e cada uma vai para revisão.
- **Pessoas:** a mensagem do operador vale sempre. Sem ela, a estimativa é a maior quantidade de um mesmo item da nota ("QTD_HOSPEDE" na hospedagem), sempre a confirmar.
- **"Não usar no treino":** ao aprovar, marque quando o centro de custo e o pagamento não forem reais (notas antigas ou de teste). Esses dois campos ficam fora do treino e das métricas.
- `node ferramentas/medir-contra-aprovadas.js` reprocessa as fotos aprovadas com a versão atual, sem custo de Azure, e mostra o acerto de cada campo antes e depois.
