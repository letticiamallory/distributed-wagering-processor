# ADR-0002: MiniStack em vez de LocalStack
Status: Aceito · Data: 2026-11-25
## Contexto
Desde 23/03/2026 a imagem do LocalStack exige conta e `LOCALSTACK_AUTH_TOKEN`. O enunciado aceita qualquer emulador de SQS, mas o CI e quem avalia precisam subir tudo com `docker compose up`, sem conta.
## Decisão
`ministackorg/ministack` (MIT, sem conta). `scripts/init-queues.sh` cria `wager-transactions.fifo` (VisibilityTimeout 30, redrive `maxReceiveCount=10`, era 5 até o ADR-0011), a DLQ `wager-transactions-dlq.fifo` (retenção 14 dias) e `wallet-events.fifo`.
Spike (25/11): `MessageGroupId`/`MessageDeduplicationId` e `ChangeMessageVisibility 0` funcionam; sem `DeleteMessage`, o `ApproximateReceiveCount` sobe até o limite do redrive (testado com 5) e, no `ReceiveMessage` seguinte ao limite, a mensagem deixa a fila principal e chega à DLQ com o mesmo `MessageId` e corpo.
## Alternativas consideradas
- LocalStack com token gratuito: plano B; troca só o endpoint e o compose.
## Consequências
+ Sobe sem conta e o redrive foi provado. − Emulador menos maduro que o LocalStack. O redrive ocorre no momento do 6º receive, não em segundo plano: os testes precisam receber de novo para provocá-lo. A imagem não tem `curl`, então o healthcheck usa o Python dela.
