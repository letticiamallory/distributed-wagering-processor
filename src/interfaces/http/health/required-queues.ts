import { loadSqsConsumerConfig } from '../../sqs/sqs-consumer.config.js';
import { loadOutboxPublisherConfig } from '../../workers/workers.config.js';

// As filas sem as quais ESTE processo não funciona, lidas das mesmas variáveis que os componentes
// leem: o consumidor precisa da fila de entrada e da DLQ; o publisher, da fila de eventos. Um
// componente desligado não exige nada (um processo só de HTTP não fica "não pronto" por uma fila).
export function requiredQueueNames(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const names: string[] = [];
  const consumer = loadSqsConsumerConfig(env);
  if (consumer.enabled) {
    names.push(consumer.queueName, consumer.dlqName);
  }
  const publisher = loadOutboxPublisherConfig(env);
  if (publisher.enabled) {
    names.push(publisher.queueName);
  }
  return names;
}
