# Central de revisão (modo treino)

A Central mostra cada despesa que a IA montou a partir das fotos do WhatsApp, ao lado da foto, para uma pessoa conferir, corrigir e aprovar.

**Nada aqui lança no Conta Azul nem copia para o Drive.** Aprovar só valida a prévia e grava um exemplo de treino.

## Como abrir

1. Dê dois cliques em `ATALHOS/13_ABRIR_CENTRAL_REVISAO.bat`.
2. O atalho traz as notas novas que o programa original já leu. Ele só lê a pasta do original e não chama o Azure de novo.
3. Em seguida, a Central abre em `http://127.0.0.1:3211/central.html`.

O atalho usa a porta 3211 e não conecta o WhatsApp, então pode ficar aberto junto com o programa original (porta 3210).

## Abas

| Aba | O que tem |
|---|---|
| Para revisar | Prévias com pendências (falta dado, projeto inativo, possível duplicidade…) |
| Classificadas | Prévias sem pendência. Ainda precisam de aprovação humana para virar treino |
| Aprovadas | Validadas por uma pessoa. Cada uma é um exemplo de treino |
| Duplicadas / descartadas | Mesma nota fiscal já registrada, ou descartadas com motivo |
| Treino | Acerto da IA por campo, só sobre o que foi aprovado |

## Como revisar uma despesa

1. Escreva seu nome em **Revisor** (topo da página). Toda correção e aprovação fica registrada com ele.
2. Compare a foto com os campos. Embaixo de cada campo aparece de onde o valor veio: lido na nota, legenda da foto, orientação da gerência etc.
3. Ao mudar um campo, escolha o tipo de erro:
   - **Leitura**: o OCR leu errado o que está impresso (valor, data, placa, litros, hodômetro, fornecedor).
   - **Classificação**: a leitura estava certa, mas a interpretação não (tipo, categoria, centro de custo, pagamento, pessoas, descrição).
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

Quando uma foto chega de um número que não está em `configuracao/pessoas.json`, aparece uma faixa amarela. Escolha quem é a pessoa e clique em **Vincular**. As prévias dela que ainda não têm correção são refeitas, e as próximas já chegam com o nome certo.

## Onde ficam os dados

Tudo fica em `dados/central.db` (SQLite, fora do Git). As fotos importadas ficam em `dados/importados/`, também fora do Git.

| Tabela | O que guarda |
|---|---|
| `despesas.campos_originais` | A prévia exatamente como a IA gerou |
| `despesas.campos` | A versão atual, com as correções |
| `correcoes` | Cada campo corrigido: antes, depois, tipo de erro, autor e data |
| `exemplos_treino` | Só despesas aprovadas: entrada (leitura do OCR, mensagem, prévia da IA) e rótulos (valores finais aprovados) |
