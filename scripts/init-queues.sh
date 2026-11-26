#!/bin/sh
# Cria as filas FIFO e a DLQ. Pode rodar quantas vezes quiser: create-queue com os
# mesmos atributos devolve a fila que já existe, e o set-queue-attributes abaixo acerta
# o redrive de uma fila criada antes com outro valor.
set -eu

ENDPOINT="${SQS_ENDPOINT:?SQS_ENDPOINT is required}"

sqs() {
  aws --endpoint-url "$ENDPOINT" sqs "$@"
}

# 1. A DLQ vem primeiro: a fila principal precisa do ARN dela.
#    Retenção de 14 dias (1209600 s), o máximo do SQS, para dar tempo de investigar.
DLQ_URL=$(sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}' \
  --query QueueUrl --output text)

DLQ_ARN=$(sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# 2. Fila principal. O RedrivePolicy é um JSON dentro de outro JSON (o SQS espera uma
#    string), por isso as aspas internas vão escapadas. Depois de 10 recebimentos sem
#    DeleteMessage, o próprio SQS move a mensagem para a DLQ: é a REDE DE SEGURANÇA (ADR-0011).
#    O consumidor manda para a DLQ por conta própria (erro permanente, ou o limite de
#    tentativas, SQS_MAX_RECEIVE_COUNT, que tem que ser <= este número).
REDRIVE=$(printf '"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"10\\"}"' "$DLQ_ARN")
MAIN_ATTRS="{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",$REDRIVE}"
# Fila que já existe com OUTRO redrive (a antiga tinha 5) faz o create-queue falhar com
# QueueAlreadyExists: por isso procura primeiro e só cria se não achar.
MAIN_URL=$(sqs get-queue-url \
  --queue-name wager-transactions.fifo \
  --query QueueUrl --output text 2>/dev/null \
  || sqs create-queue \
    --queue-name wager-transactions.fifo \
    --attributes "$MAIN_ATTRS" \
    --query QueueUrl --output text)
echo "$MAIN_URL"

# Estes dois atributos podem ser alterados depois da criação (o FifoQueue não): rodar de novo
# deixa a fila existente com o redrive de agora.
sqs set-queue-attributes \
  --queue-url "$MAIN_URL" \
  --attributes "{\"VisibilityTimeout\":\"30\",$REDRIVE}"

# 3. Fila dos eventos publicados pela outbox (sem DLQ própria).
sqs create-queue \
  --queue-name wallet-events.fifo \
  --attributes '{"FifoQueue":"true"}' \
  --query QueueUrl --output text

echo "queues ready"
