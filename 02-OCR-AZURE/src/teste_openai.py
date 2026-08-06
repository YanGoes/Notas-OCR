from openai import OpenAI

client = OpenAI()

response = client.responses.create(
    model="gpt-5-mini",
    input="Responda somente: API funcionando.",
)

print(response.output_text)