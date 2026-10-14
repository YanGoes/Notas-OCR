# Assistente da Central (chatbot): especificação

Data: 14/10/2026 · Situação: **aguardando aprovação** · Nada foi construído ainda.

## 1. Objetivo

Uma aba **"Assistente"** na Central de revisão para conversar sobre as despesas e o programa em linguagem natural, como numa conversa com o Claude. Ela serve para:

- responder rápido às perguntas da gerência (principalmente da Vanessa): gastos do mês, quem não manda nota há dias, o que está pendente, o que foi para o Drive;
- explicar o programa: por que uma nota ficou em revisão, o que deu errado, como está a maturidade da IA;
- registrar ideias e problemas numa lista de **sugestões** para o Yan avaliar;
- **lançar notas no Conta Azul só quando alguém pedir**, e só depois de uma pessoa confirmar no botão.

**Critério de sucesso:** a Vanessa pergunta "quanto o Lorran gastou em outubro, por tipo?" e recebe a resposta certa em segundos, com os números batendo com a Central.

## 2. Quem usa e onde

- **Onde:** só neste computador, na Central (http://127.0.0.1:3211/central.html, aba "Assistente"). A liberação na rede local, com login, fica para a fase do servidor.
- **Quem:** Yan, Jhonathan, Vanessa e Cauã. A pessoa escolhe quem está falando no topo da aba, como já acontece com o "Revisor". O Cauã entra no cadastro sem telefone.
- Cada conversa fica salva com o nome de quem falou.

## 3. O que ele consegue fazer (ferramentas)

O assistente não lê o banco diretamente: ele pede dados ao programa por **ferramentas** com regras fixas. Assim, ele só vê o que a ferramenta devolve e nunca vê telefones.

### Consultas (só leitura)

| Ferramenta | Exemplos de pergunta |
| --- | --- |
| `relatorio_gastos` (período; agrupar por operador, centro de custo, categoria, tipo ou dia) | "Gastos de outubro por operador", "média por dia do Almir", "quanto foi de combustível na Rota do Pequi" |
| `ultimo_envio_por_operador` | "Quem não manda nota há mais de 3 dias?", "último dia de lançamento de cada um" |
| `buscar_despesas` (operador, estado, período, tipo, centro, faixa de valor, texto) | "Notas do Lorran em revisão", "despesas sem comprovante deste mês" |
| `detalhar_despesa` | "Por que a #81 está pendente?" |
| `consultar_drive` (operador, mês) | "As notas de setembro do Everson estão no Drive?", "quantos comprovantes do Almir em outubro" |
| `situacao_do_sistema` | "O WhatsApp está conectado?", "quanto falta da cota do Azure?", "quando foi o último backup?", "deu algum erro hoje?" |
| `maturidade_da_ia` | "A IA já pode lançar sozinha?" |
| `cadastros` | "Quais centros de custo estão ativos?", "qual cartão o projeto X usa?" |

- **Fontes dos relatórios:** as notas da Central (desde 11/10/2026) e, para meses anteriores, a planilha `visao_contas_a_pagar` exportada do Conta Azul, que já é usada no treino. A resposta sempre diz de qual fonte veio cada número.
- **Drive:** leitura da pasta sincronizada neste computador (`G:\Meu Drive\...\Controle Financeiro - VMac`). Ele só lista e conta arquivos; nunca apaga nem move.

### Ações

| Ferramenta | Como funciona |
| --- | --- |
| `registrar_sugestao` | Grava a ideia ou o problema na lista "Sugestões" (quem pediu, quando, texto). O Yan vê numa área da aba. |
| `preparar_lancamento` | **Só quando a pessoa pede para lançar.** O assistente monta a lista de notas que seriam lançadas e o resumo (valor, fornecedor, categoria, centro, cartão). **Ele não lança.** A tela mostra um botão **"Confirmar lançamento"**, e só o clique de uma pessoa executa, pelo mesmo caminho de lançamento que o programa já tem. |

Regras do lançamento:
- só notas **aprovadas** na Central;
- respeita a chave geral de lançamento: enquanto o Conta Azul estiver em modo teste ou com a API bloqueada, o botão explica o motivo e não lança;
- cada lançamento fica registrado (quem pediu, quem confirmou, quando, quais notas).

Ele não corrige notas, não aprova, não descarta e não muda cadastros. Para isso continua sendo a Central.

## 4. Modelo de IA e custo

- **Modelo escolhido na própria aba** (e salvo em `config.json`):
  - **Claude Opus 5.5** (padrão; o mais inteligente): US$ 4 de entrada / US$ 20 de saída por milhão de tokens;
  - **Claude Sonnet 5.5** (intermediário): US$ 2 / US$ 10;
  - **Claude Haiku 5.5** (mais barato): US$ 0,10 / US$ 0,50.
- **Painel de gasto na aba:** tokens e custo estimado do mês, por pessoa e por modelo.
- **Limite mensal em dólares** (definido por você em `config.json`). Ao chegar nele, o assistente para e avisa. O limite no site da Anthropic continua valendo como segunda trava.
- **Economia automática:** as instruções fixas e a lista de ferramentas ficam em cache (prompt caching), e as respostas usam o nível de raciocínio "médio" por padrão.
- **Plano B automático:** se o modelo principal recusar uma pergunta legítima por engano, a Anthropic responde com um modelo alternativo (fallback do lado do servidor).

## 5. Segurança e privacidade

- A chave fica no `.env` (`ANTHROPIC_API_KEY`), que nunca vai para o Git. Sem chave, a aba mostra como configurar e nada é enviado.
- **Telefones nunca são enviados.** As ferramentas devolvem só nomes e, quando preciso, os 4 últimos dígitos.
- O que vai para a Anthropic: a pergunta, as instruções do assistente e os resultados das ferramentas daquela conversa (valores, fornecedores, nomes de operadores e de projetos).
- As conversas ficam no banco local da Central, que entra no backup diário.

## 6. Como fica no programa

- `src/assistente/`:
  - `ferramentas.js`: cada ferramenta é uma função pura sobre o banco e os cadastros, fácil de testar;
  - `conversa.js`: ciclo de pergunta → ferramentas → resposta, com o SDK oficial `@anthropic-ai/sdk`;
  - `custos.js`: tokens, custo e limite mensal.
- **Banco:** migração nova com as tabelas `assistente_conversas`, `assistente_mensagens`, `assistente_sugestoes` e `assistente_uso`.
- **Rotas:** `/api/central/assistente/*` (enviar mensagem, histórico, sugestões, uso, modelo, confirmar lançamento).
- **Tela:** aba "Assistente" com a conversa, um seletor de modelo, o painel de gasto e a lista de sugestões. Indicação de "consultando…" enquanto as ferramentas rodam.

## 7. Testes

- Cada ferramenta, com banco em memória e dados fictícios, incluindo:
  - relatório por operador e média;
  - último envio;
  - Drive numa pasta temporária;
  - telefone nunca presente na saída.
- O ciclo da conversa com um **cliente falso** (sem chamar a API nem gastar).
- O limite mensal bloqueia.
- `preparar_lancamento` nunca lança sem a confirmação, e a confirmação recusa notas não aprovadas e o modo teste.

## 8. Fora desta versão

Acesso pelo WhatsApp ou pela rede, voz, edição de notas pelo chat, relatórios em PDF ou Excel (dá para incluir depois) e lançamento sem confirmação humana.

## 9. Perguntas em aberto

1. **Quem pode confirmar lançamentos** no botão: só você (Yan), ou também Jhonathan e Vanessa?
2. **Limite mensal inicial:** sugiro US$ 20 por mês para a fase de testes.
3. **Relatórios de meses anteriores:** posso usar a planilha do Conta Azul como fonte? Ela só é atualizada quando alguém exporta de novo.
