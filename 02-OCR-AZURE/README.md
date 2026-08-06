# Protótipos de OCR

Scripts de teste que enviam imagens de comprovantes para o **Azure Document Intelligence** e mostram
os campos extraídos com o respectivo grau de confiança. Não fazem parte do fluxo automático do
coletor: são usados na mão, para avaliar qual modelo lê melhor os comprovantes.

## Requisitos

Python 3.10 ou superior e as bibliotecas:

```powershell
pip install azure-ai-documentintelligence openai
```

Antes de rodar, configure as credenciais no PowerShell:

```powershell
$env:AZURE_DOCUMENT_ENDPOINT = "https://SEU-RECURSO.cognitiveservices.azure.com/"
$env:AZURE_DOCUMENT_KEY = "sua-chave"
```

As chaves ficam apenas no ambiente — não as escreva dentro dos scripts.

## Scripts

### `src/teste_azure.py` — uma imagem

Analisa um arquivo e imprime os campos na tela.

```powershell
python src/teste_azure.py "../03-DADOS/amostras/ribeiro-2026-07-30/arquivo.jpeg" prebuilt-receipt
```

### `src/teste_azure_lote.py` — pasta inteira

Percorre uma pasta, roda o modelo escolhido em cada imagem e grava, por arquivo, o `.json` bruto e um
`_RELATORIO_COMPLETO.txt` legível, além de um `resumo_lote.json` do conjunto. Foi o script que gerou
o conteúdo de `03-DADOS/resultados-azure/`.

```powershell
python src/teste_azure_lote.py "../03-DADOS/amostras/whatsapp-2026-07-30"
python src/teste_azure_lote.py "../03-DADOS/amostras/whatsapp-2026-07-30" prebuilt-invoice
```

Sem argumentos, abre uma janela para escolher a pasta. O modelo padrão é `prebuilt-receipt` — para
comparar modelos, rode uma vez para cada um.

Os resultados são gravados numa subpasta `RESULTADOS_AZURE` **dentro da pasta analisada**. Se rodar
sobre `03-DADOS/amostras/`, mova depois a saída para `03-DADOS/resultados-azure/` para manter a
organização.

Aceita `.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp`, `.tif`, `.tiff` e `.pdf`.

### `src/teste_openai.py` — verificação da API

Oito linhas que apenas confirmam se a chave da OpenAI está funcionando. Requer `OPENAI_API_KEY`
no ambiente.

## Modelos comparados

| Modelo | Uso |
| --- | --- |
| `prebuilt-receipt` | Cupons e recibos — traz total, data, estabelecimento e itens |
| `prebuilt-invoice` | Notas fiscais — traz fornecedor, vencimento e impostos |
| `prebuilt-layout` | Só o texto e as tabelas, sem interpretar campos |

Os resultados já gerados estão em `03-DADOS/resultados-azure/` e podem ser comparados sem gastar
novas chamadas da API.
