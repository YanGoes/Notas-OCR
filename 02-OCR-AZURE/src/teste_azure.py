import json
import os
import sys
from pathlib import Path

from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.core.credentials import AzureKeyCredential
from azure.core.exceptions import AzureError


ENDPOINT = os.getenv("AZURE_DOCUMENT_ENDPOINT")
KEY = os.getenv("AZURE_DOCUMENT_KEY")


def mostrar_campo(nome, campo, nivel=0):
    identacao = "  " * nivel
    confianca = getattr(campo, "confidence", None)

    if confianca is not None:
        confianca_texto = f" — confiança: {confianca:.1%}"
    else:
        confianca_texto = ""

    tipo = getattr(campo, "type", None)
    valor = getattr(campo, "value", None)
    conteudo = getattr(campo, "content", None)

    if tipo == "array" and valor:
        print(f"{identacao}{nome}:{confianca_texto}")
        for indice, item in enumerate(valor, start=1):
            mostrar_campo(f"Item {indice}", item, nivel + 1)

    elif tipo == "object" and valor:
        print(f"{identacao}{nome}:{confianca_texto}")
        for subnome, subcampo in valor.items():
            mostrar_campo(subnome, subcampo, nivel + 1)

    else:
        valor_exibido = valor if valor is not None else conteudo
        print(
            f"{identacao}{nome}: {valor_exibido}"
            f"{confianca_texto}"
        )


def analisar_documento(caminho, modelo):
    if not ENDPOINT or not KEY:
        raise RuntimeError(
            "As variáveis AZURE_DOCUMENT_ENDPOINT e "
            "AZURE_DOCUMENT_KEY não foram configuradas."
        )

    arquivo = Path(caminho)

    if not arquivo.is_file():
        raise FileNotFoundError(
            f"Arquivo não encontrado: {arquivo}"
        )

    cliente = DocumentIntelligenceClient(
        endpoint=ENDPOINT,
        credential=AzureKeyCredential(KEY),
    )

    print(f"Enviando: {arquivo.name}")
    print(f"Modelo: {modelo}")
    print("Aguarde...\n")

    with arquivo.open("rb") as imagem:
        poller = cliente.begin_analyze_document(
            model_id=modelo,
            body=imagem,
            content_type="application/octet-stream",
        )

    resultado = poller.result()

    print("=== CAMPOS ESTRUTURADOS ===")

    if not resultado.documents:
        print("Nenhum documento estruturado foi identificado.")

    for indice, documento in enumerate(
        resultado.documents or [], start=1
    ):
        print(f"\nDocumento {indice}")
        print(f"Tipo: {documento.doc_type}")

        for nome, campo in documento.fields.items():
            mostrar_campo(nome, campo)

    print("\n=== TEXTO COMPLETO RECONHECIDO ===")
    print(resultado.content or "Nenhum texto reconhecido.")

    nome_saida = (
        f"resultado_{arquivo.stem}_{modelo}.json"
        .replace("-", "_")
    )

    with open(nome_saida, "w", encoding="utf-8") as saida:
        json.dump(
            resultado.as_dict(),
            saida,
            ensure_ascii=False,
            indent=2,
            default=str,
        )

    print(f"\nJSON salvo em: {nome_saida}")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        print(
            "Uso:\n"
            "python teste_azure.py foto.jpg\n"
            "python teste_azure.py foto.jpg prebuilt-invoice"
        )
        sys.exit(1)

    caminho_imagem = sys.argv[1]
    modelo_escolhido = (
        sys.argv[2]
        if len(sys.argv) == 3
        else "prebuilt-receipt"
    )

    modelos_permitidos = {
        "prebuilt-receipt",
        "prebuilt-invoice",
        "prebuilt-layout",
    }

    if modelo_escolhido not in modelos_permitidos:
        print("Modelo inválido.")
        print("Use:")
        for item in modelos_permitidos:
            print(f"- {item}")
        sys.exit(1)

    try:
        analisar_documento(
            caminho_imagem,
            modelo_escolhido,
        )
    except (AzureError, OSError, RuntimeError) as erro:
        print(f"\nErro: {erro}")
        sys.exit(1)