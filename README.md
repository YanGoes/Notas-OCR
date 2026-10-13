# PROGRAMA OCR — Central de Despesas VMac

Automatiza o caminho **foto do comprovante no WhatsApp → leitura da nota → despesa conferida → lançamento no Conta Azul e cópia no Drive**.

Os operadores de campo mandam a foto da nota no grupo de despesas, junto com uma mensagem dizendo o projeto, o cartão e o número de pessoas. O programa lê a nota com o Azure, entende a mensagem e monta a despesa no padrão da VMac. Uma pessoa confere a despesa na **Central de revisão** antes de qualquer lançamento.

## Situação atual: período de testes e treino

| Parte | Situação |
| --- | --- |
| Coleta dos grupos do WhatsApp | **Ligada.** Grupos: Almir Despesas VMac, Despesas FWD, Everson Despesas FWD e Lorran despesas VDRod |
| Leitura das notas (Azure, plano gratuito) | **Ligada**, com limite de 450 páginas por mês. Passando disso, as fotos esperam o mês virar |
| Central de revisão e treino da IA | **Ligada**. Treino com a planilha do Conta Azul e com as notas aprovadas |
| Lançamento no Conta Azul | **Desligado** de propósito. A API do Conta Azul também está bloqueada pelo plano (`END_TRIAL`) |
| Cópia do comprovante no Drive | **Desligada** de propósito |
| Mensagens nos grupos | **Nenhuma.** O programa não escreve nos grupos dos operadores |

Acerto atual da IA:
- **90%** dos campos certos nas notas conferidas pela equipe;
- **94%** de acerto na categoria quando as regras decidem (teste com maio a julho de 2026 da planilha).

## Estrutura

```
PROGRAMA OCR/
├── 01-COLETOR-WHATSAPP/   O programa (Node.js): coleta, leitura, Central, treino
├── 02-OCR-AZURE/          Protótipos em Python para comparar modelos do Azure
├── 03-DADOS/              Fotos de amostra e resultados de testes
└── temp_notinhas/         11.395 fotos de notas (base para treinar a leitura)
```

### 01-COLETOR-WHATSAPP

É o programa em uso. O manual completo está no [README da pasta](01-COLETOR-WHATSAPP/README.md). Os atalhos do dia a dia ficam em `01-COLETOR-WHATSAPP/ATALHOS/`:

| Atalho | Para quê |
| --- | --- |
| `15_COLETAR_WHATSAPP.bat` | Liga a coleta dos grupos (painel em http://127.0.0.1:3211). Deixe a janela aberta |
| `13_ABRIR_CENTRAL_REVISAO.bat` | Abre a Central de revisão (http://127.0.0.1:3211/central.html) |
| `14_TREINAR_CENTRAL.bat` | Treina e mede a IA com a planilha do Conta Azul e as notas aprovadas |

### 02-OCR-AZURE

Scripts de linha de comando que mandam uma imagem ao Azure Document Intelligence e mostram os campos extraídos. Servem para comparar modelos (`prebuilt-receipt`, `prebuilt-invoice`, `prebuilt-layout`). Não fazem parte do fluxo automático. Detalhes em [02-OCR-AZURE/README.md](02-OCR-AZURE/README.md).

### 03-DADOS

| Pasta | Conteúdo |
| --- | --- |
| `amostras/whatsapp-2026-07-30/` | 22 fotos de comprovantes usadas nos primeiros testes |
| `amostras/ribeiro-2026-07-30/` | 7 fotos do teste "Ribeiro" |
| `amostras/whatsapp-copias-2026-08-06/` | 46 fotos do grupo de cópias (foto + mensagem), também enviadas à Central para revisão e treino |
| `amostras/documentos/` | Recibo de hospedagem em `.docx` |
| `capturas-coletor/` | Captura real do coletor: imagem, `.txt` e `.json` |
| `resultados-azure/` | Saídas do Azure para os lotes de teste |

### temp_notinhas

São 11.395 fotos de notas (JPEG e PNG). Ainda não foram lidas pelo Azure. Servem de base para medir e treinar a leitura no futuro, respeitando o limite mensal do plano gratuito.

## Segurança

Nunca compartilhe nem suba para a internet:

- `01-COLETOR-WHATSAPP/.baileys_sessao/`: dá acesso à conta do WhatsApp;
- `01-COLETOR-WHATSAPP/.env`: chaves do Azure e do Conta Azul;
- `01-COLETOR-WHATSAPP/tokens_conta_azul.json`: acesso ao Conta Azul;
- `01-COLETOR-WHATSAPP/configuracao/pessoas.json`: telefones dos operadores;
- `01-COLETOR-WHATSAPP/dados/`: fotos, mensagens e o banco da Central.

Todos esses arquivos ficam fora do Git (`.gitignore`). Para mandar o projeto a alguém, use `ATALHOS/11_GERAR_PACOTE_PARA_ENVIO.bat`, que monta um `.zip` sem nenhum deles.

## Desenvolvimento

- **Código:** Node.js 22.5 ou superior; o banco da Central é o SQLite embutido no Node (`node:sqlite`).
- **Versões:** controle de versão com Git (veja [COMO-SUBIR-NO-GIT](01-COLETOR-WHATSAPP/docs/COMO-SUBIR-NO-GIT.md)).
- **Testes:** `npm test` roda os 278 testes automatizados; `npm run check` confere a sintaxe de todos os arquivos.
