# Central de Despesas VMac — coletor do WhatsApp

Programa que acompanha os grupos de despesas do WhatsApp, lê cada nota com o Azure, entende a mensagem do operador e monta a despesa no padrão da VMac. A despesa fica para conferência na **Central de revisão**. Lançar no Conta Azul e copiar para o Drive são etapas separadas, desligadas no período de testes.

```
Operador manda a foto + mensagem no grupo
        │
        ▼
Coleta (WhatsApp) ──► Leitura da nota (Azure) ──► Regras VMac + contexto do operador
                                                        │
                                                        ▼
                                          Prévia na Central de revisão
                                                        │  pessoa confere, corrige e aprova
                                                        ▼
                                  Exemplo de treino   (futuro: Conta Azul + Drive)
```

## Situação atual (modo treino)

| O quê | Estado | Onde muda |
| --- | --- | --- |
| Coleta dos grupos | Ligada nos grupos marcados no painel | painel → "Grupos monitorados" |
| Leitura com o Azure | Ligada, até 450 páginas por mês (plano gratuito) | `config.json` → `pipeline.limite_paginas_azure_mes` |
| Lançamento no Conta Azul | **Desligado** | `config.json` → `lancamento_automatico`, `conta_azul` |
| Cópia no Drive | **Desligada** | `config.json` → `arquivo_drive.habilitado` |
| Mensagens nos grupos | Nenhuma: o programa só lê | — |

A API do Conta Azul está bloqueada pelo plano da conta (`END_TRIAL`). Enquanto o plano não for regularizado, nem a sincronização de cadastros nem o lançamento funcionam.

## Uso no dia a dia

Na primeira vez, rode `ATALHOS/01_INSTALAR_E_INICIAR.bat`. Ele instala o Node.js e as bibliotecas. Depois disso:

| Atalho (`ATALHOS/`) | Para quê |
| --- | --- |
| **15_COLETAR_WHATSAPP.bat** | Liga a coleta e abre o painel em http://127.0.0.1:3211. **Deixe a janela aberta**: fechar para a coleta |
| **13_ABRIR_CENTRAL_REVISAO.bat** | Abre a Central de revisão. Com a coleta aberta, só abre o navegador |
| **14_TREINAR_CENTRAL.bat** | Treina e mede a IA (planilha do Conta Azul + notas aprovadas) |
| 02_ABRIR_APLICATIVO.bat | Mesmo programa, minimizado no ícone da bandeja do Windows |
| 09 / 10 | Liga ou desliga a abertura automática com o Windows |
| 11_GERAR_PACOTE_PARA_ENVIO.bat | Gera um `.zip` do projeto **sem** sessões, chaves, telefones e fotos |
| 03 a 08, 12 | Configuração e testes do Azure e do Conta Azul (ver `ATALHOS/LEIA-ME.txt`) |

O programa só pode estar aberto **uma vez** no computador. Uma segunda cópia se recusa a subir e avisa qual janela já está coletando, porque duas cópias na mesma sessão derrubam a conexão uma da outra.

O computador precisa ficar ligado, com internet e sem suspensão para receber as notas.

### Conectar o WhatsApp

1. Abra o atalho 15. No painel, o card **"1 WhatsApp"** mostra o QR Code.
2. No celular: *WhatsApp → Aparelhos conectados → Conectar aparelho* e leia o código. Se a câmera não funcionar, use "O QR Code não funcionou?" para entrar com um código de 8 letras.
3. No card **"2 Grupos monitorados"**, clique em "Atualizar lista de grupos", marque os grupos de despesas e salve. **Só os grupos marcados são lidos.** Com nenhum marcado, nada é lido.

A sessão fica salva em `.baileys_sessao/`, então o QR só é pedido de novo se o aparelho for removido no celular.

Como o programa evita falhas no pareamento:
- **Versão sempre atual:** ele se apresenta ao celular com a versão atual do WhatsApp Web, consultada no site do WhatsApp. Com uma versão defasada, o celular recusa o vínculo. Sem internet, usa a última que funcionou.
- **QR expirado:** gera outro na hora. Depois de 5 sem leitura, para e pede para clicar em Conectar.
- **Celular recusou:** limpa a sessão, gera um QR novo e explica no painel. A causa mais comum é o limite de **4 aparelhos conectados** no WhatsApp.
- **Registro de conexão:** toda conexão e queda fica em `dados/logs/whatsapp-conexao.log`, com o código e o motivo.

## Mensagem padrão do operador

A nota é a fonte da **data**, do **valor**, do **fornecedor**, dos **litros**, do **hodômetro** e da **placa**. O que só a mensagem pode dizer é o **projeto**, o **cartão** e as **pessoas**:

```text
Jantar
Pessoas: 3
Projeto: Rota do Pequi
Cartão: Inter
```

Também são entendidos:
- **formatos curtos:** "Jantar 3 pessoas / Rota do Pequi / Crédito Inter";
- **cabeçalho do dia:** "Despesas 11/10/2026" seguido do projeto, que vale para as fotos seguintes do mesmo operador;
- **mensagem separada da foto:** enviada até 45 segundos antes ou depois, ou como resposta à foto.

O projeto informado vale para as próximas notas daquele operador, mesmo em outros dias, até ele informar outro.

## Como a nota é lida e montada

| Campo | Regra |
| --- | --- |
| Data e valor | Sempre os da nota. Se a mensagem diz outro valor e **esse valor também está impresso na nota** (o OCR pegou o subtotal) ou é o mesmo número sem a vírgula (5800 = 58,00), vale o da mensagem. Se não aparece na nota, fica o da nota e vai para conferência. Data lida no futuro é trocada pela outra data da nota |
| Fornecedor | Padrão VMac por tipo: posto → **POSTOS DE COMBUSTÍVEL**, refeição → **RESTAURANTES**, hotel → **HOTÉIS**. O nome impresso fica guardado. A própria VMac (tomadora da NFS-e) nunca é fornecedor |
| Tipo | Pela nota (itens, estabelecimento, texto da NFS-e) e pela mensagem. Refeição pelo horário é só pista e vai para confirmação |
| Placa | Lida na nota, inclusive com "PLACA" mal impresso ("FLACA") e trocas do OCR ("RBTZE25" → RBT2E25, "SGR4854" → SGR4B54 da frota). Placa ilegível é comparada com a frota e vira **sugestão** |
| Litros | Lidos na nota. Separador de milhar perdido ("61618") vira 61,618 quando o preço por litro confere (R$ 3 a 12) |
| Hodômetro | Rótulos "HODOMETRO", "OD", "KM", "HM". Um número sem rótulo colado à placa é usado, mas vai para confirmação. O km da rodovia no endereço é ignorado |
| Pessoas | A mensagem manda. Sem ela, estima, **sempre a confirmar**: pelo **costume do operador** (5+ notas aprovadas, 80%+ iguais), pela maior quantidade de um mesmo item, pelos hóspedes da nota ou por diária de até R$ 350 (1 pessoa) |
| Descrição | Abastecimento: `35,43L od 145.225 - JKN2876`. Refeição e hospedagem: `JANTAR - 3 PESSOAS`, `HOSPEDAGEM - 1 PESSOA` |
| Categoria | Combustível pela placa da frota; refeição, hospedagem e pedágio pela prática atual da VMac. Sem regra, o modelo treinado só **sugere** |
| Centro de custo | Do projeto informado pelo operador. Só nome ou apelido **exatos** escolhem o projeto. Projeto inativo vai para revisão |
| Cartão | O informado pelo operador. Sem ele, vale a orientação da gerência para o projeto. O que vem impresso no cupom não decide. Sem nenhum dos dois, o **cartão de costume** do operador aparece só como sugestão |

Mais regras:
- **Uma foto, várias notas:** uma foto com duas notas diferentes vira **duas despesas**, inclusive notas lado a lado separadas pela posição na foto. Cupom fiscal mais a via da maquininha da mesma compra é uma despesa só.
- **Duplicidade:** a mesma chave de NFC-e é bloqueada. Mesmo emissor, data, valor e hora em outra foto vira suspeita para revisão.

Tudo o que a regra não consegue decidir com segurança vira **pendência** na Central. Nada é inventado.

## Central de revisão

Endereço: http://127.0.0.1:3211/central.html. O manual completo está em [docs/CENTRAL-DE-REVISAO.md](docs/CENTRAL-DE-REVISAO.md).

- **Abas:** para revisar, classificadas, aprovadas, duplicadas/descartadas, treino e centros de custo.
- **Por operador:** botões acima da lista filtram as notas de cada pessoa, com contador. A aba Treino mostra o resumo por operador, inclusive o que cada um deixou de informar.
- **Tela da despesa:** a foto fica ao lado dos campos, com zoom, girar e tela cheia. Cada campo mostra de onde veio o valor.
- **Correções:** cada correção registra o motivo, que pode ser **leitura** (o OCR leu errado), **classificação** (interpretou errado), **não informado** (faltou na mensagem ou na nota, e não conta como erro da IA) ou **outro**, e uma explicação livre para a IA entender o que errou.
- **Aprovar** transforma a despesa em exemplo de treino. A caixa "Centro de custo e pagamento não são reais" tira esses dois campos do treino, para notas antigas ou de teste.
- **Centros de custo:** cadastro de projetos com situação, centro no Conta Azul e apelidos, com histórico de quem alterou.
- **Quem mandou:** o operador é reconhecido pelo telefone. O código interno do WhatsApp ("…@lid") é traduzido para o telefone sozinho, ao chegar a mensagem ou ao conectar. Quem ainda não foi reconhecido aparece numa faixa, com o botão "Buscar nos contatos do WhatsApp" ou a opção de dizer quem é.

## Treino da IA

- `ATALHOS/14_TREINAR_CENTRAL.bat` (ou `npm run central:treinar`) usa a planilha `visao_contas_a_pagar` exportada do Conta Azul e as notas aprovadas na Central, que valem mais por terem sido conferidas. O teste é sempre nos **últimos 3 meses**, que o modelo não viu no treino, para medir como ele vai acertar no mês seguinte.
- `npm run central:medir` reprocessa as notas aprovadas com a versão atual, sem gastar o Azure, e mostra o acerto de cada campo.
- A aba **Treino** da Central mostra os dois resultados e o uso do Azure no mês.
- O Agendador de Tarefas do Windows pode rodar `ferramentas/treino-agendado.cmd`, que grava o resultado em `dados/logs/treino-agendado.log`.

## Maturidade da IA e lançamento autônomo

A aba **Treino** abre com a **maturidade**, medida pela versão atual da IA reprocessando todas as notas já aprovadas, sem gastar o Azure. Ela mostra:
- **notas inteiras certas**, ou seja, todos os campos certos de uma vez, que é o que importa para lançar sem revisar;
- o **mínimo garantido** de cada número: o pior acerto plausível com 95% de confiança. Com poucas notas ele fica baixo mesmo acertando tudo, o que evita confiar cedo demais;
- a situação de cada campo: maduro, quase, aprendendo ou poucos dados.

| Estágio | Quando | O que pode fazer |
| --- | --- | --- |
| 1 · Aprendendo | até atingir o estágio 2 | Revisar todas as notas |
| 2 · Assistido | notas inteiras certas com mínimo garantido ≥ 80% em 50+ notas | Revisão rápida; aprovar em lote as notas sem pendência |
| 3 · Autônomo parcial | ≥ 95% garantido em 150+ notas e campos críticos maduros | Lançar sozinha só as notas sem pendência; o resto continua em revisão |
| 4 · Autônomo | ≥ 98% garantido em 300+ notas | Lançar sozinha; revisão por amostragem |

O programa só **mede**. Ligar o lançamento autônomo continua sendo decisão da equipe, e depende também do plano do Conta Azul liberar a API. A maturidade é atualizada pelo atalho 14, pelo treino agendado ou por `npm run central:medir`.

## Cadastros (`configuracao/`)

| Arquivo | Conteúdo |
| --- | --- |
| `projetos.json` | Projetos e centros de custo: situação, nome no Conta Azul e apelidos. Editável pela aba "Centros de custo" |
| `veiculos.json` | Frota: placa e categorias de combustível e manutenção no Conta Azul |
| `categorias.json` | Categoria de cada tipo de despesa (refeições, hospedagem, pedágio…) |
| `cartoes.json` | Cartões (Inter, C6) e como os operadores os escrevem |
| `fornecedores_recorrentes.json` | Fornecedor padrão por tipo e estabelecimentos recorrentes |
| `pessoas.json` | Operadores: telefone, papel, pasta no Drive, regras especiais. **Fora do Git** (modelo em `pessoas.exemplo.json`) |
| `regras.json` | Limites de confiança, tipos permitidos e bloqueados |
| `modelo-central.json` | Modelo gerado pelo treino (fora do Git) |

## Onde fica cada coisa

```text
ATALHOS/        Atalhos do dia a dia e de configuração (ver LEIA-ME.txt)
configuracao/   Cadastros e regras
docs/           Documentação: Central, API do Conta Azul, regras de classificação
src/            Código do programa
  central/      Central de revisão: banco, regras VMac, contexto, revisão, rotas
public/         Painel e Central (abrem no navegador)
ferramentas/    Comandos de linha: treino, importação, testes, Conta Azul
scripts/        Scripts do Windows usados pelos atalhos
testes/         Testes automatizados (npm test)
dados/          Tudo que o programa gera (fora do Git):
  central.db      banco da Central (mensagens, despesas, correções, treino)
  entrada/        fila de fotos esperando leitura
  ocr-bruto/      resposta completa do Azure de cada foto
  revisao/ simulacao/ bloqueados/ erros/   fotos já lidas
  importados/     fotos trazidas para a Central por importação
  logs/           conexão do WhatsApp e treino agendado
  azure-uso.json  páginas do Azure usadas no mês
```

## Configuração (`config.json`)

| Chave | Para quê |
| --- | --- |
| `grupos_permitidos`, `nomes_dos_grupos` | Grupos lidos (preenchidos pelo painel) |
| `exigir_legenda`, `aguardar_comentario_segundos` | Espera pela mensagem do operador quando a foto vem sem legenda |
| `pipeline.modo` | `simulacao`: só prévias, nada é lançado |
| `pipeline.limite_paginas_azure_mes` | Limite mensal de leituras (450 no plano gratuito; `0` = sem limite) |
| `central.habilitada` | Gera as prévias na Central |
| `lancamento_automatico`, `conta_azul`, `arquivo_drive` | Lançamento e Drive (desligados no período de testes) |

As chaves do Azure e do Conta Azul ficam no `.env` (modelo em `.env.exemplo`). Para duas instalações usarem a mesma conexão do Conta Azul, aponte `CONTA_AZUL_TOKENS_PATH` para um único `tokens_conta_azul.json`. Cada renovação do token invalida as cópias.

## Limite do Azure (plano gratuito)

O plano gratuito lê 500 páginas por mês. O programa para em 450, deixando folga. Daí em diante, as fotos ficam em `dados/entrada` e são lidas automaticamente quando o mês virar. O painel avisa quando o limite é atingido, e a aba Treino mostra o uso.

## Solução de problemas

- **QR Code não conecta:** veja a mensagem no card do WhatsApp e o fim de `dados/logs/whatsapp-conexao.log`. Se o celular estiver com 4 aparelhos conectados, remova um que não use.
- **"Já está coletando":** já existe uma janela do programa aberta. Use essa janela.
- **Foto não aparece na Central:** confira se o grupo está marcado no painel e se o limite do Azure do mês foi atingido (aba Treino).
- **Node.js não encontrado:** rode `ATALHOS/01_INSTALAR_E_INICIAR.bat` de novo.
- **Conta Azul 403 / END_TRIAL:** é o plano da conta; o programa não resolve isso sozinho.

## Desenvolvimento

```powershell
npm ci           # instala as bibliotecas
npm test         # 278 testes automatizados
npm run check    # confere a sintaxe de todos os arquivos
npm start        # sobe o painel e a coleta (porta 3211)
```

Requer Node.js 22.5 ou superior (o instalador do atalho 01 instala ou atualiza). O banco usa o SQLite embutido do Node (`node:sqlite`), sem instalação extra.
