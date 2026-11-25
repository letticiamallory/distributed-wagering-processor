#!/bin/sh
# Cria as filas FIFO e a DLQ. Pode rodar quantas vezes quiser: create-queue com os
# mesmos atributos devolve a fila que já existe.
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
#    string), por isso as aspas internas vão escapadas. Depois de 5 recebimentos sem
#    DeleteMessage, o próprio SQS move a mensagem para a DLQ.
MAIN_ATTRS=$(printf '{"FifoQueue":"true","VisibilityTimeout":"30","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"5\\"}"}' "$DLQ_ARN")
sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$MAIN_ATTRS" \
  --query QueueUrl --output text

# 3. Fila dos eventos publicados pela outbox (sem DLQ própria).
sqs create-queue \
  --queue-name wallet-events.fifo \
  --attributes '{"FifoQueue":"true"}' \
  --query QueueUrl --output text

echo "queues ready"
