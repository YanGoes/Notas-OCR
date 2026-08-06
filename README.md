# PROGRAMA OCR

Automatização do fluxo **foto de comprovante no WhatsApp → extração dos dados → despesa no Conta Azul**.

O projeto tem duas frentes: um **coletor** em Node.js já pronto para uso (frente principal) e
**protótipos de OCR** em Python usados para avaliar a qualidade da extração pela Azure.

## Estrutura

```
PROGRAMA OCR/
├── 01-COLETOR-WHATSAPP/     Aplicação principal (Node.js) — em produção
├── 02-OCR-AZURE/            Protótipos de OCR em Python (Azure / OpenAI)
├── 03-DADOS/                Imagens de teste, capturas reais e resultados
└── 04-ARQUIVO/              Código antigo e material que não é mais usado
```

### 01-COLETOR-WHATSAPP

Programa que roda continuamente: monitora os grupos autorizados do WhatsApp, salva cada foto nova
com seus metadados e, opcionalmente, envia a imagem para a Captura do Conta Azul.

Para usar, dê dois cliques em `INICIAR.bat`. As instruções completas — configuração, conexão com o
Conta Azul e solução de problemas — estão no [README próprio da pasta](01-COLETOR-WHATSAPP/README.md).

Estado atual: coletor funcionando; integração com o Conta Azul **desligada** em `config.json`
(`conta_azul.habilitada: false`), aguardando validação com a área financeira.

### 02-OCR-AZURE

Scripts de linha de comando que mandam uma imagem para o Azure Document Intelligence e mostram os
campos extraídos. Servem para comparar os modelos `prebuilt-receipt`, `prebuilt-invoice` e
`prebuilt-layout` antes de decidir qual usar. Detalhes em [02-OCR-AZURE/README.md](02-OCR-AZURE/README.md).

### 03-DADOS

| Pasta | Conteúdo |
| --- | --- |
| `amostras/whatsapp-2026-07-30/` | 22 fotos de comprovantes usadas nos testes |
| `amostras/ribeiro-2026-07-30/` | 7 fotos do teste "Ribeiro" |
| `amostras/documentos/` | Recibo de hospedagem em `.docx` |
| `capturas-coletor/` | Captura real do coletor: imagem + `.txt` + `.json` |
| `resultados-azure/lote-whatsapp/` | Saídas do Azure para as fotos do lote de 30/07 |
| `resultados-azure/ribeiro/` | Saídas do Azure para o teste Ribeiro (layout, receipt e relatório) |

### 04-ARQUIVO

Nada aqui é executado pelo fluxo atual. Pode ser apagado quando não houver mais interesse.

| Pasta | Conteúdo |
| --- | --- |
| `legado-coletor/` | Versões anteriores do coletor (whatsapp-web.js e Baileys), com as sessões que usavam |
| `pacotes-zip/` | Pacotes `.zip` gerados para envio ao gestor |
| `coletor-incompleto/` | Tentativa abandonada de coletor: só `package.json` e bibliotecas |
| `imagens-duplicadas/` | Cópias idênticas das 22 fotos que estão em `03-DADOS/amostras/whatsapp-2026-07-30/` |

## Pendências conhecidas

- **As duas frentes não se conversam.** O coletor envia a imagem direto para a IA do Conta Azul;
  os scripts Azure rodam à parte, sobre pastas de teste. Não existe código ligando um ao outro.
- **Não há controle de versão.** O projeto não é um repositório Git; o histórico está sendo
  guardado em cópias de pastas.
- **Não há testes automatizados**, apenas `npm run check`, que verifica a sintaxe dos arquivos.

## Segurança

Nunca compartilhe estes itens — eles dão acesso à conta do WhatsApp e ao Conta Azul:

- `01-COLETOR-WHATSAPP/.baileys_sessao/` e `04-ARQUIVO/legado-coletor/.whatsapp_sessao/`
- `01-COLETOR-WHATSAPP/.env` e `01-COLETOR-WHATSAPP/tokens_conta_azul.json`

As chaves da Azure e da OpenAI ficam em variáveis de ambiente, nunca dentro do código.
