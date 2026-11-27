// A prova de que as entregas de uma mensagem falharam com erro PERMANENTE (ADR-0016). Cada falha
// permanente soma 1, numa transação própria e curta, e a porta devolve o total. O consumidor só
// grava FAILED quando esse total é igual ao número de entregas: uma entrega sem registro (o banco
// estava fora e nem este registro passou; a mensagem voltou por crash ou SIGTERM) é falta de prova,
// e falta de prova nunca vira FAILED.
export abstract class DeliveryFailureLog {
  abstract recordPermanentFailure(
    consumerName: string,
    messageId: string,
  ): Promise<number>;
}
